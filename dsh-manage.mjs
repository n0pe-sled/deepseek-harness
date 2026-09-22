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
 *   --setup     first-run bootstrap after a fresh clone; then exit
 *   --install   build this checkout and install its launchers in ~/.local/bin
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * The checkout this script belongs to. `realpathSync` matters here: `--install`
 * symlinks this file into `~/.local/bin/dsh-manage`, so `import.meta.url` on an
 * installed copy resolves to the symlink and would derive the root from the
 * link's directory instead of the checkout.
 */
const CHECKOUT = dirname(realpathSync(fileURLToPath(import.meta.url)))

const DSH_HOME = resolve(process.env.DSH_HOME ?? '/opt/deepseek/deepseek-harness-data')
const PLUGINS_REPO = resolve(process.env.DSH_PLUGINS_REPO ?? join(CHECKOUT, 'plugins'))
const SKILLS_REPO = resolve(process.env.DSH_SKILLS_REPO ?? join(CHECKOUT, 'skills'))
/** The dsh installation anchor used to compute the dependency closure for out-of-tree plugins. */
const INSTALL_ANCHOR = resolve(process.env.DSH_INSTALL_ANCHOR ?? join(CHECKOUT, 'apps', 'cli', 'package.json'))
const HARNESS_REPO = resolve(process.env.DSH_HARNESS_REPO ?? CHECKOUT)
const USER_BIN = resolve(process.env.DSH_BIN_DIR ?? join(process.env.HOME ?? '', '.local', 'bin'))

/** The platform/arch a plugin's build output was produced for, e.g. `darwin-arm64`. */
const BUILD_TARGET = `${process.platform}-${process.arch}`

/**
 * Stamp file written into each plugin's `lib/` after a build. Its presence and
 * value record which platform/arch produced the committed-or-checkout output,
 * so a plugin built on another machine (a Linux CI, a Docker image) is
 * rebuilt locally before use. `lib/` itself stays out of version control.
 */
const BUILD_STAMP = '.dsh-build-target'

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
    setup: { type: 'boolean', default: false },
    install: { type: 'boolean', default: false },
    plugins: { type: 'string', default: '' },
    skills: { type: 'string', default: '' },
    'disable-plugins': { type: 'string', default: '' },
    'disable-skills': { type: 'string', default: '' },
    rebuild: { type: 'boolean', default: true },
    'no-rebuild': { type: 'boolean', default: false },
    'rebuild-plugins': { type: 'boolean', default: false },
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
  --disable-plugins <names>  comma-separated plugin names to disable; no TUI
  --disable-skills <names>   comma-separated skill names to disable; no TUI
  --list              list discovered plugins and skills and exit
  --ensure-deps       mirror the dsh installation's dependency closure into the
                      plugins repo node_modules so out-of-tree plugins resolve
                      @deepseek-ai/* (idempotent, no TUI, no profile writes)
  --[no-]rebuild      rebuild selected plugins whose lib/ is missing or was
                      built for another platform/arch (default: enabled); each
                      build records the target in lib/${BUILD_STAMP}
  --rebuild-plugins   force a rebuild of every selected plugin, ignoring stamps
  --setup             first-run bootstrap after a fresh clone: initialize the
                      plugin and skill submodules, install and build the harness,
                      mirror the dependency closure, then build every discovered
                      plugin (no TUI, no profile writes)
  --install           build the checked-out harness and install dsh plus
                      dsh-manage into ~/.local/bin
  --dry-run           show what would change without writing anything
  --help              show this help

Environment:
  DSH_HOME            Harness home (default /opt/deepseek/deepseek-harness-data)
  DSH_PLUGINS_REPO    plugins repo (default <checkout>/plugins)
  DSH_SKILLS_REPO     skills repo (default <checkout>/skills)
  DSH_INSTALL_ANCHOR  dsh app package.json (default <checkout>/apps/cli/package.json)
  DSH_HARNESS_REPO    harness root (default <checkout>; inferred from DSH_INSTALL_ANCHOR when set)
  DSH_BIN_DIR         command install directory (default ~/.local/bin)

  <checkout> is the directory holding this script, resolved through symlinks.
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

/** The platform/arch a plugin's `lib/` was built for, or undefined when unstamped or unbuilt. */
function pluginBuildTarget(plugin) {
  const libDir = join(plugin.dir, 'lib')
  const stamp = join(libDir, BUILD_STAMP)
  if (!existsSync(stamp)) return undefined
  return readFileSync(stamp, 'utf8').trim()
}

/** Whether a plugin's build output exists and was produced for this platform/arch. */
function pluginNeedsBuild(plugin) {
  if (!existsSync(join(plugin.dir, 'lib'))) return 'missing'
  return pluginBuildTarget(plugin) === BUILD_TARGET ? false : 'stale'
}

/** Write the current platform/arch stamp into a freshly built plugin's `lib/`. */
function stampBuild(plugin) {
  const libDir = join(plugin.dir, 'lib')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, BUILD_STAMP), `${BUILD_TARGET}\n`)
}

/** Ensure a plugin has its own node_modules before building (pnpm install when absent). */
function ensurePluginDeps(plugin) {
  if (existsSync(join(plugin.dir, 'node_modules'))) return
  process.stdout.write(`  installing dependencies for ${basename(plugin.dir)}\n`)
  execFileSync('pnpm', ['install'], { cwd: plugin.dir, stdio: 'inherit' })
}

/**
 * Rebuild every selected plugin whose `lib/` is missing or was built for a
 * different platform/arch. `lib/` is not version-controlled, so a fresh clone
 * or a checkout carried over from a Linux host arrives either unbuilt or
 * stamped with the producing host; both are rebuilt here before dsh loads them.
 * @param selected - chosen plugin descriptors (from {@link discoverPlugins}).
 * @param options - `dryRun` reports without building; `force` rebuilds unconditionally.
 * @returns counts of rebuilt and skipped plugins.
 */
function rebuildPlugins(selected, options) {
  let rebuilt = 0
  let skipped = 0
  for (const plugin of selected) {
    const reason = options.force ? 'forced' : pluginNeedsBuild(plugin)
    if (reason === false) {
      skipped++
      continue
    }
    if (options.dryRun) {
      process.stdout.write(`  would rebuild ${basename(plugin.dir)} (${reason})\n`)
      continue
    }
    process.stdout.write(`  rebuilding ${basename(plugin.dir)} (${reason}; target ${BUILD_TARGET})\n`)
    ensurePluginDeps(plugin)
    try {
      execFileSync('pnpm', ['run', 'build'], { cwd: plugin.dir, stdio: 'inherit' })
      stampBuild(plugin)
      rebuilt++
    } catch (error) {
      process.stderr.write(`dsh-manage: build failed for ${basename(plugin.dir)}: ${String(error)}\n`)
      process.exitCode = 1
    }
  }
  return { rebuilt, skipped }
}

/** Quote one value for a generated POSIX shell launcher. */
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * First-run bootstrap for a fresh clone of this checkout.
 *
 * Submodule initialization comes first because everything after it reads the
 * plugin and skill directories: the dependency mirror needs the plugin
 * manifests, and the build needs the plugin sources. A clone made without
 * `--recurse-submodules` arrives with those directories empty, so the
 * initializer is what makes `git clone` plus this command equivalent to a
 * recursive clone.
 *
 * Nothing built is version-controlled: the harness `lib/` is gitignored and
 * each plugin builds its own `lib/` locally, so both installs and both builds
 * happen here rather than arriving with the clone.
 */
function setupCheckout() {
  process.stdout.write(`initializing submodules in ${CHECKOUT}\n`)
  try {
    execFileSync('git', ['-C', CHECKOUT, 'submodule', 'update', '--init', '--recursive'], { stdio: 'inherit' })
  } catch (error) {
    process.stderr.write(`dsh-manage: submodule init failed: ${String(error)}\n`)
    process.exitCode = 1
  }

  process.stdout.write(`installing harness dependencies in ${CHECKOUT}\n`)
  try {
    execFileSync('pnpm', ['install'], { cwd: CHECKOUT, stdio: 'inherit' })
  } catch (error) {
    process.stderr.write(`dsh-manage: pnpm install failed: ${String(error)}\n`)
    process.exitCode = 1
  }

  process.stdout.write(`building the harness\n`)
  try {
    execFileSync('pnpm', ['run', 'build'], { cwd: CHECKOUT, stdio: 'inherit' })
  } catch (error) {
    process.stderr.write(`dsh-manage: harness build failed: ${String(error)}\n`)
    process.exitCode = 1
  }

  ensureDependencyMirror()

  const plugins = discoverPlugins()
  process.stdout.write(`building ${plugins.length} discovered plugin(s)\n`)
  const { rebuilt, skipped } = rebuildPlugins(plugins, { dryRun: false, force: false })
  process.stdout.write(`  plugin builds: ${rebuilt} rebuilt, ${skipped} current (target ${BUILD_TARGET})\n`)
  process.stdout.write(`\nsetup complete. next: dsh-manage --all (or run without arguments to pick plugins)\n`)
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

    let inputBuffer = ''

    const handleChar = (ch) => {
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
      } else if (ch === '/') {
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

    const handleEscape = (seq) => {
      if (seq === '\x1b[A' || seq === '\x1bOA') {
        const count = visibleEntries().length
        if (count > 0) cursor = (cursor - 1 + count) % count
        render()
      } else if (seq === '\x1b[B' || seq === '\x1bOB') {
        const count = visibleEntries().length
        if (count > 0) cursor = (cursor + 1) % count
        render()
      } else if (seq === '\x1b[C' || seq === '\x1bOC' || seq === '\x1b[D' || seq === '\x1bOD') {
        switchKind(kind === 'plugin' ? 'skill' : 'plugin')
        render()
      }
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
      // Escape sequences may arrive split across chunks (tmux/screen/ssh) or
      // several at once; parse incrementally so every keypress registers.
      inputBuffer += s
      let index = 0
      while (index < inputBuffer.length) {
        if (done) break
        const ch = inputBuffer[index]
        if (ch !== '\x1b') {
          handleChar(ch)
          index++
          continue
        }
        const rest = inputBuffer.slice(index)
        if (rest.length < 2) break
        let seq = null
        let len = 0
        const prefix = rest[1]
        if (prefix === '[') {
          let end = 2
          while (end < rest.length && rest[end] >= ' ' && rest[end] <= '?') end++
          if (end >= rest.length) break
          seq = rest.slice(0, end + 1)
          len = end + 1
        } else if (prefix === 'O') {
          if (rest.length < 3) break
          seq = rest.slice(0, 3)
          len = 3
        } else {
          seq = '\x1b'
          len = 1
        }
        handleEscape(seq)
        index += len
      }
      inputBuffer = inputBuffer.slice(index)
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
const disablePlugins = values['disable-plugins'].split(',').map(name => name.trim()).filter(Boolean)
const disableSkills = values['disable-skills'].split(',').map(name => name.trim()).filter(Boolean)
const hasAllowlist = onlyPlugins.length > 0 || onlySkills.length > 0
const hasDisablelist = disablePlugins.length > 0 || disableSkills.length > 0
const hasSelection = hasAllowlist || hasDisablelist
if (hasSelection) {
  for (const entry of entries) {
    const isPlugin = entry.kind === 'plugin'
    // An allowlist resets every entry (unlisted ones are uninstalled); a
    // disablelist only turns listed entries off, leaving the rest as chosen.
    let value = hasAllowlist
      ? (isPlugin ? onlyPlugins.includes(entry.name) : onlySkills.includes(entry.name))
      : chosen.get(entry.name)
    if (isPlugin ? disablePlugins.includes(entry.name) : disableSkills.includes(entry.name)) value = false
    chosen.set(entry.name, value)
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

if (values.setup) {
  setupCheckout()
  process.exit(process.exitCode ?? 0)
}

if (values.install) {
  installLocalHarness()
  process.exit(0)
}

const interactive = process.stdin.isTTY === true && !values.all && !hasSelection
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

// Rebuild before the profile relinks, so pnpm install and dsh both see native
// output. `--rebuild-plugins` forces; `--no-rebuild` opts out entirely.
const rebuild = values['no-rebuild'] ? false : values.rebuild
if (rebuild && chosenPlugins.length > 0) {
  const { rebuilt, skipped } = rebuildPlugins(chosenPlugins, {
    dryRun,
    force: values['rebuild-plugins'],
  })
  process.stdout.write(`  plugin builds: ${rebuilt} rebuilt, ${skipped} current (target ${BUILD_TARGET})\n`)
}

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
