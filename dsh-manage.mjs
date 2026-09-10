#!/usr/bin/env node
/**
 * dsh-manage — keep a dsh profile's plugins and skills in sync with the local
 * plugins/skills repos.
 *
 * Discovers every bundle plugin in the plugins repo and every skill in the
 * skills repo, then (by default) opens an interactive tabbed picker to choose
 * what is installed. On apply it rewrites the profile's package.json
 * (link: dependencies + dsh.profile.bundles) and runs pnpm install, and
 * symlinks the chosen skills into the DSH user skill root so every agent
 * preset's skill-filesystem provider sees them. Nothing is hardcoded: new
 * plugins/skills added to either repo are picked up on the next run.
 *
 * Modes:
 *   (no args)   interactive TUI
 *   --all       select everything non-interactively
 *   --list      print discovered plugins and skills, then exit
 *   --dry-run   show what would change without writing anything
 *   --install   build this checkout and install its launchers in ~/.local/bin
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const DSH_HOME = resolve(process.env.DSH_HOME ?? '/opt/deepseek/deepseek-harness-data')
const PLUGINS_REPO = resolve(process.env.DSH_PLUGINS_REPO ?? '/opt/deepseek/deepseek-harness-plugins')
const SKILLS_REPO = resolve(process.env.DSH_SKILLS_REPO ?? '/opt/deepseek/deepseek-harness-skills')
/** The dsh installation anchor used to compute the dependency closure for out-of-tree plugins. */
const INSTALL_ANCHOR = resolve(process.env.DSH_INSTALL_ANCHOR ?? '/opt/deepseek/deepseek-harness/apps/cli/package.json')
const HARNESS_REPO = resolve(process.env.DSH_HARNESS_REPO ?? join(dirname(INSTALL_ANCHOR), '..', '..'))
const USER_BIN = resolve(process.env.DSH_BIN_DIR ?? join(process.env.HOME ?? '', '.local', 'bin'))

/** Profile bundle rows the CLI ships for the web profile; kept ahead of user-selected plugins. */
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** The user skill root the filesystem skill provider scans for every agent preset. */
const SKILLS_TARGET = join(DSH_HOME, 'skills')

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'web' },
    all: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'ensure-deps': { type: 'boolean', default: false },
    install: { type: 'boolean', default: false },
    plugins: { type: 'string', default: '' },
    skills: { type: 'string', default: '' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`Usage: dsh-manage [options]

Options:
  --profile <name>    profile to sync (default: web)
  --all               select all plugins and skills without the TUI
  --plugins <names>   comma-separated plugin names to enable (others are uninstalled); no TUI
  --skills <names>    comma-separated skill names to enable (others are uninstalled); no TUI
  --list              list discovered plugins and skills and exit
  --ensure-deps       mirror the dsh installation's dependency closure into the
                      plugins repo node_modules so out-of-tree plugins resolve
                      @deepseek-ai/* (idempotent, no TUI, no profile writes)
  --install           build the checked-out harness and install dsh plus
                      dsh-manage into ~/.local/bin
  --dry-run           show what would change without writing anything
  --help              show this help

Environment:
  DSH_HOME            Harness home (default /opt/deepseek/deepseek-harness-data)
  DSH_PLUGINS_REPO    plugins repo (default /opt/deepseek/deepseek-harness-plugins)
  DSH_SKILLS_REPO     skills repo (default /opt/deepseek/deepseek-harness-skills)
  DSH_INSTALL_ANCHOR  dsh app package.json (default …/deepseek-harness/apps/cli/package.json)
  DSH_HARNESS_REPO    checked-out harness root inferred from DSH_INSTALL_ANCHOR
  DSH_BIN_DIR         command install directory (default ~/.local/bin)
`)
  process.exit(0)
}

const PROFILE_DIR = join(DSH_HOME, 'profiles', values.profile)

/** Read JSON with a friendly error; `undefined` when the file is absent. */
function readJson(path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Resolve a package's root directory from one anchor, mirroring Node's node_modules lookup. */
function packageDirFromAnchor(anchor, packageName) {
  const require = createRequire(anchor)
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** BFS over the dsh app's dependency+peer closure, mapping package name -> resolved directory. */
function dependencyClosure(anchor) {
  const links = new Map()
  const appManifest = readJson(anchor)
  if (appManifest === undefined || typeof appManifest.name !== 'string') {
    throw new Error(`dsh-manage: no app manifest at ${anchor}`)
  }
  links.set(appManifest.name, dirname(anchor))
  const queue = [{ anchor, manifest: appManifest }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dep of [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      if (dir === undefined) continue
      links.set(dep, dir)
      const manifest = readJson(join(dir, 'package.json'))
      queue.push({ anchor: join(dir, 'package.json'), manifest: manifest ?? {} })
    }
  }
  return links
}

/** Mirror the dsh installation closure into the plugins repo so out-of-tree plugins resolve @deepseek-ai/*. */
function ensureDependencyMirror() {
  const links = dependencyClosure(INSTALL_ANCHOR)
  const modulesDir = join(PLUGINS_REPO, 'node_modules')
  let created = 0
  let repointed = 0
  for (const [name, dir] of links) {
    const link = join(modulesDir, name)
    const target = resolve(dir)
    if (existsSync(link)) {
      const stat = lstatSync(link)
      if (stat.isSymbolicLink()) {
        if (resolve(dirname(link), readlinkSync(link)) === target) continue
        rmSync(link)
        symlinkSync(target, link)
        repointed++
        continue
      }
      throw new Error(`dsh-manage: ${link} exists and is not a symlink; remove it and re-run --ensure-deps`)
    }
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
    created++
  }
  process.stdout.write(
    `dependency mirror: ${created} created, ${repointed} repointed in ${modulesDir} (${links.size} packages)\n`,
  )
  return { created, repointed, total: links.size }
}

/** Quote one value for a generated POSIX shell launcher. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Build this checkout and install stable launchers in the user's command directory. */
function installLocalHarness() {
  const builtBin = join(HARNESS_REPO, 'apps', 'cli', 'lib', 'bin.js')
  const managerSource = fileURLToPath(import.meta.url)
  process.stdout.write(`building ${HARNESS_REPO}\n`)
  execFileSync('pnpm', ['run', 'build'], { cwd: HARNESS_REPO, stdio: 'inherit' })
  if (!existsSync(builtBin)) throw new Error(`dsh-manage: build did not create ${builtBin}`)

  mkdirSync(USER_BIN, { recursive: true })
  const dshPath = join(USER_BIN, 'dsh')
  const launcher = `#!/bin/sh
set -eu
export DSH_HOME=\${DSH_HOME:-${shellQuote(DSH_HOME)}}
exec node ${shellQuote(builtBin)} "$@"
`
  writeFileSync(dshPath, launcher)
  chmodSync(dshPath, 0o755)

  const managerPath = join(USER_BIN, 'dsh-manage')
  if (existsSync(managerPath)) {
    const stat = lstatSync(managerPath)
    const alreadyLinked = stat.isSymbolicLink()
      && resolve(dirname(managerPath), readlinkSync(managerPath)) === managerSource
    if (!alreadyLinked) {
      throw new Error(`dsh-manage: ${managerPath} already exists and is not this manager`)
    }
  } else {
    symlinkSync(managerSource, managerPath)
  }

  process.stdout.write(`installed ${dshPath}\ninstalled ${managerPath}\n`)
  process.stdout.write(`run: dsh --profile ${values.profile}\n`)
}

/** Frontmatter name/description of a SKILL.md, or undefined when unparseable. */
function parseSkillFrontmatter(path) {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null) return undefined
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line)
    if (kv !== null && data[kv[1]] === undefined) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return data
}

/** List immediate children of a directory, sorted, or [] when absent. */
function listDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

/** Discover bundle plugins: every plugins-repo subdir whose manifest declares dsh.bundle. */
function discoverPlugins() {
  const plugins = []
  if (!existsSync(PLUGINS_REPO)) return plugins
  for (const entry of listDir(PLUGINS_REPO)) {
    const dir = join(PLUGINS_REPO, entry)
    if (!lstatSync(dir).isDirectory()) continue
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest === undefined || typeof manifest !== 'object') continue
    if (typeof manifest.name !== 'string' || manifest.dsh?.bundle?.patch === undefined) continue
    plugins.push({
      kind: 'plugin',
      name: manifest.name,
      dir,
      description: typeof manifest.description === 'string' ? manifest.description : '',
    })
  }
  return plugins
}

/** Discover skills: immediate children of each skills-repo category that are skill bundles or flat .md skills. */
function discoverSkills() {
  const skills = []
  if (!existsSync(SKILLS_REPO)) return skills
  for (const category of listDir(SKILLS_REPO)) {
    const categoryDir = join(SKILLS_REPO, category)
    if (!lstatSync(categoryDir).isDirectory()) continue
    for (const entry of listDir(categoryDir)) {
      const path = join(categoryDir, entry)
      const stat = lstatSync(path)
      const isFlat = stat.isFile() && entry.endsWith('.md')
      const isBundle = stat.isDirectory() && existsSync(join(path, 'SKILL.md'))
      if (!isFlat && !isBundle) continue
      const skillFile = isBundle ? join(path, 'SKILL.md') : path
      const frontmatter = parseSkillFrontmatter(skillFile)
      // Match the skill-filesystem provider: a candidate without a frontmatter
      // name and description is not a usable skill.
      if (frontmatter === undefined || typeof frontmatter.name !== 'string' || frontmatter.name === ''
        || typeof frontmatter.description !== 'string' || frontmatter.description === '') {
        continue
      }
      const name = frontmatter.name
      skills.push({
        kind: 'skill',
        name,
        category,
        dir: isBundle ? path : categoryDir,
        file: skillFile,
        description: frontmatter?.description ?? '',
      })
    }
  }
  return skills
}

/** Current profile manifest, defaulting to the shipped shape when absent. */
function currentManifest() {
  return readJson(join(PROFILE_DIR, 'package.json')) ?? {
    name: `dsh-profile-${values.profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...BASE_BUNDLES] } },
  }
}

function isInside(path, dir) {
  const rel = relative(resolve(dir), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Build the new profile manifest: base bundles + selected plugins as link: dependencies.
 *  Any previously-managed (non-`@`) bundle that is unselected or no longer in the repo is removed. */
function buildManifest(current, plugins) {
  const dependencies = {}
  const bundles = []
  for (const name of current.dsh?.profile?.bundles ?? []) {
    // Keep only installation bundles (scoped @deepseek-ai/* rows); managed
    // plugins are rebuilt from the selection below, so unselected or removed
    // plugins drop out of both dependencies and the layer list.
    if (name.startsWith('@') && !bundles.includes(name)) bundles.push(name)
  }
  for (const plugin of plugins) {
    if (chosen.get(plugin.name)) {
      dependencies[plugin.name] = `link:${plugin.dir}`
      bundles.push(plugin.name)
    }
  }
  return {
    ...current,
    name: current.name ?? `dsh-profile-${values.profile}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Remove profile node_modules links to plugins no longer selected (pnpm's hoisted linker does not prune them). */
function prunePluginLinks(selectedPlugins) {
  const selected = new Set(selectedPlugins.map(plugin => plugin.name))
  const modulesDir = join(PROFILE_DIR, 'node_modules')
  if (!existsSync(modulesDir)) return
  for (const name of listDir(modulesDir)) {
    const link = join(modulesDir, name)
    if (!lstatSync(link).isSymbolicLink()) continue
    const target = resolve(dirname(link), readlinkSync(link))
    if (!isInside(target, PLUGINS_REPO)) continue
    if (selected.has(name)) continue
    if (values['dry-run']) {
      process.stdout.write(`  would prune stale plugin link ${name}\n`)
      continue
    }
    rmSync(link, { force: true })
    process.stdout.write(`  pruned stale plugin link ${name}\n`)
  }
}

/** Interactive, tabbed picker over the discovered plugins and skills. */
async function pick(entries) {
  let kind = 'plugin'
  let cursor = 0
  let filter = ''
  let filtering = false
  let done = false

  const visibleEntries = () => {
    const needle = filter.toLowerCase()
    return entries.filter(entry => entry.kind === kind
      && (needle === '' || `${entry.name} ${entry.description} ${entry.category ?? ''}`.toLowerCase().includes(needle)))
  }

  const clampCursor = () => {
    cursor = Math.max(0, Math.min(cursor, visibleEntries().length - 1))
  }

  const switchKind = (next) => {
    kind = next
    cursor = 0
    filter = ''
    filtering = false
  }

  const render = () => {
    const rows = process.stdout.rows ?? 24
    const columns = process.stdout.columns ?? 80
    const pageSize = Math.max(5, rows - 12)
    const list = visibleEntries()
    clampCursor()
    const start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), list.length - pageSize))
    const page = list.slice(start, start + pageSize)
    const active = entries.filter(entry => chosen.get(entry.name)).length
    const pluginCount = entries.filter(entry => entry.kind === 'plugin' && chosen.get(entry.name)).length
    const skillCount = entries.filter(entry => entry.kind === 'skill' && chosen.get(entry.name)).length
    const tab = (label, tabKind, count) => tabKind === kind
      ? `\x1b[46m\x1b[30m ${label} ${count} \x1b[0m`
      : `\x1b[90m ${label} ${count} \x1b[0m`
    const out = [
      '\x1b[2J\x1b[H',
      `  \x1b[1mDSH MANAGER\x1b[0m  \x1b[90mprofile\x1b[0m \x1b[36m${values.profile}\x1b[0m  \x1b[90m${active}/${entries.length} enabled\x1b[0m\n`,
      `  ${tab('PLUGINS', 'plugin', pluginCount)}  ${tab('SKILLS', 'skill', skillCount)}\n`,
      `  \x1b[90m${'─'.repeat(Math.max(12, columns - 4))}\x1b[0m\n`,
    ]

    if (page.length === 0) {
      out.push(`\n  \x1b[90m${filter === '' ? `No ${kind}s found.` : `No matches for "${filter}".`}\x1b[0m\n`)
    } else {
      for (let index = 0; index < page.length; index++) {
        const entry = page[index]
        const absoluteIndex = start + index
        const selected = absoluteIndex === cursor
        const marker = chosen.get(entry.name) ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m'
        const pointer = selected ? '\x1b[36m›\x1b[0m' : ' '
        const nameWidth = Math.max(18, Math.min(38, Math.floor(columns * 0.42)))
        const name = truncate(entry.name, nameWidth).padEnd(nameWidth)
        const description = truncate(entry.description ?? '', Math.max(0, columns - nameWidth - 11))
        out.push(`  ${pointer} ${marker} ${selected ? '\x1b[1m' : ''}${name}\x1b[0m  \x1b[90m${description}\x1b[0m\n`)
      }
    }

    const current = list[cursor]
    out.push(`  \x1b[90m${'─'.repeat(Math.max(12, columns - 4))}\x1b[0m\n`)
    if (current !== undefined) {
      out.push(`  \x1b[90m${truncate(current.dir, Math.max(12, columns - 4))}\x1b[0m\n`)
    }
    out.push(`  ${filtering ? '\x1b[36msearch ›\x1b[0m' : '\x1b[90msearch\x1b[0m'} ${filter || (filtering ? '' : 'press /')}\n`)
    out.push('  \x1b[90m←/→ tabs  ↑/↓ move  space toggle  a tab  / search  enter apply  q quit\x1b[0m')
    process.stdout.write(out.join(''))
  }

  return await new Promise((resolveApply) => {
    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdout.write('\x1b[?25h\x1b[2J\x1b[H')
      process.stdin.pause()
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdout.write('\x1b[?25l')
    render()

    const apply = () => {
      done = true
      cleanup()
      resolveApply()
    }

    process.stdin.on('data', (chunk) => {
      if (done) return
      const s = chunk.toString()
      if (filtering) {
        for (const ch of s) {
          if (ch === '\u001b' || ch === '\r' || ch === '\n') filtering = false
          else if (ch === '\u007f') filter = filter.slice(0, -1)
          else if (ch >= ' ' && ch !== '\u007f') filter += ch
        }
        cursor = 0
        render()
        return
      }
      if (s.includes('\x1b[A')) {
        const count = visibleEntries().length
        if (count > 0) cursor = (cursor - 1 + count) % count
        render()
      } else if (s.includes('\x1b[B')) {
        const count = visibleEntries().length
        if (count > 0) cursor = (cursor + 1) % count
        render()
      } else if (s.includes('\x1b[C') || s.includes('\x1b[D')) {
        switchKind(kind === 'plugin' ? 'skill' : 'plugin')
        render()
      }
      for (const ch of s) {
        if (ch === '\u0003' || ch === 'q') {
          done = true
          cleanup()
          process.exitCode = 130
          resolveApply(false)
          return
        }
        if (ch === '\r' || ch === '\n') {
          apply()
          return
        }
        if (ch === ' ') {
          const entry = visibleEntries()[cursor]
          if (entry !== undefined) chosen.set(entry.name, !chosen.get(entry.name))
          render()
        } else if (ch === 'a') {
          const tabEntries = entries.filter(entry => entry.kind === kind)
          const allOn = tabEntries.every(entry => chosen.get(entry.name))
          for (const entry of tabEntries) chosen.set(entry.name, !allOn)
          render()
        } else if (ch === '/' ) {
          filtering = true
          filter = ''
          render()
        } else if (ch === '\t') {
          switchKind(kind === 'plugin' ? 'skill' : 'plugin')
          render()
        } else if (ch === 'j' || ch === '\u000e') {
          const count = visibleEntries().length
          if (count > 0) cursor = (cursor + 1) % count
          render()
        } else if (ch === 'k' || ch === '\u0010') {
          const count = visibleEntries().length
          if (count > 0) cursor = (cursor - 1 + count) % count
          render()
        }
      }
    })
  })
}

const plugins = discoverPlugins()
const skills = discoverSkills()
const entries = [...plugins, ...skills]
const manifest = currentManifest()
const installedBundles = new Set(manifest.dsh?.profile?.bundles ?? [])
const chosen = new Map(entries.map(entry => {
  if (entry.kind === 'plugin') return [entry.name, installedBundles.has(entry.name)]
  const link = join(SKILLS_TARGET, entry.name)
  const installed = existsSync(link) && lstatSync(link).isSymbolicLink()
    && isInside(resolve(dirname(link), readlinkSync(link)), entry.dir)
  return [entry.name, installed]
}))

const onlyPlugins = values.plugins.split(',').map(name => name.trim()).filter(Boolean)
const onlySkills = values.skills.split(',').map(name => name.trim()).filter(Boolean)
const hasAllowlist = onlyPlugins.length > 0 || onlySkills.length > 0
if (hasAllowlist) {
  for (const entry of entries) {
    const allow = entry.kind === 'plugin' ? onlyPlugins.includes(entry.name) : onlySkills.includes(entry.name)
    chosen.set(entry.name, allow)
  }
}

if (values.list) {
  process.stdout.write(`plugins (${plugins.length}):\n`)
  for (const plugin of plugins) process.stdout.write(`  ${plugin.name}\t${plugin.dir}\n`)
  process.stdout.write(`skills (${skills.length}):\n`)
  for (const skill of skills) process.stdout.write(`  ${skill.name}\t${skill.dir}\n`)
  process.exit(0)
}

if (values['ensure-deps']) {
  ensureDependencyMirror()
  process.exit(0)
}

if (values.install) {
  installLocalHarness()
  process.exit(0)
}

const interactive = process.stdin.isTTY === true && !values.all && !hasAllowlist
if (interactive) {
  const apply = await pick(entries)
  if (apply === false) process.exit(130)
}

const newManifest = buildManifest(manifest, plugins)
const chosenPlugins = plugins.filter(plugin => chosen.get(plugin.name))
const chosenSkills = skills.filter(skill => chosen.get(skill.name))
const dryRun = values['dry-run']
const manifestChanged = JSON.stringify(newManifest) !== JSON.stringify(manifest)

process.stdout.write(`\n${values.profile} profile sync:\n`)
process.stdout.write(`  plugins: ${chosenPlugins.length}/${plugins.length} enabled\n`)
process.stdout.write(`  skills:  ${chosenSkills.length}/${skills.length} enabled\n`)

if (manifestChanged) {
  if (dryRun) {
    process.stdout.write(`  would rewrite ${join(PROFILE_DIR, 'package.json')}\n`)
  } else {
    mkdirSync(PROFILE_DIR, { recursive: true })
    writeFileSync(join(PROFILE_DIR, 'package.json'), `${JSON.stringify(newManifest, undefined, 2)}\n`)
    process.stdout.write(`  rewrote ${join(PROFILE_DIR, 'package.json')}\n`)
    try {
      execFileSync('pnpm', ['install'], { cwd: PROFILE_DIR, stdio: 'inherit' })
      process.stdout.write(`  pnpm install done in ${PROFILE_DIR}\n`)
    } catch (error) {
      process.stderr.write(`dsh-manage: pnpm install failed: ${String(error)}\n`)
      process.exitCode = 1
    }
  }
} else if (!dryRun) {
  process.stdout.write(`  ${join(PROFILE_DIR, 'package.json')} unchanged\n`)
}
prunePluginLinks(chosenPlugins)

if (!dryRun) mkdirSync(SKILLS_TARGET, { recursive: true })
const skillByName = new Map(skills.map(skill => [skill.name, skill]))
const skillLinkNames = new Set([...listDir(SKILLS_TARGET), ...skillByName.keys()])
for (const linkName of skillLinkNames) {
  const link = join(SKILLS_TARGET, linkName)
  const skill = skillByName.get(linkName)
  const wanted = skill !== undefined && chosen.get(linkName)
  if (!existsSync(link)) {
    if (wanted) {
      if (dryRun) {
        process.stdout.write(`  would link skill ${linkName} -> ${skill.dir}\n`)
      } else {
        symlinkSync(skill.dir, link)
        process.stdout.write(`  linked skill ${linkName} -> ${skill.dir}\n`)
      }
    }
    continue
  }
  const stat = lstatSync(link)
  if (!stat.isSymbolicLink()) {
    if (wanted) process.stdout.write(`  skill ${linkName}: existing non-symlink at ${link} left alone\n`)
    continue
  }
  const target = resolve(dirname(link), readlinkSync(link))
  // Only this tool's own links are touched: anything whose target is not in
  // the skills repo (or the skill's own dir) is left alone.
  const managed = isInside(target, SKILLS_REPO) || (skill !== undefined && isInside(target, skill.dir))
  if (!managed) continue
  if (wanted && isInside(target, skill.dir)) continue
  if (wanted) {
    if (dryRun) {
      process.stdout.write(`  would relink skill ${linkName} -> ${skill.dir}\n`)
    } else {
      rmSync(link, { force: true })
      symlinkSync(skill.dir, link)
      process.stdout.write(`  relinked skill ${linkName} -> ${skill.dir}\n`)
    }
    continue
  }
  if (dryRun) {
    process.stdout.write(`  would unlink skill ${linkName}\n`)
  } else {
    rmSync(link, { force: true })
    process.stdout.write(`  unlinked skill ${linkName}\n`)
  }
}

if (!dryRun) {
  process.stdout.write(`\nnext: run 'dsh ${values.profile}' to boot with the synced composition.\n`)
}
