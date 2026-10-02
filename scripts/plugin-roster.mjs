/**
 * The fork's plugin and skill roster: what a shipped harness may carry and what it
 * must never carry.
 *
 * Three staging paths need the same answer to "which plugins and skills does this
 * checkout have": a dev checkout (`dsh-manage.mjs`), the sandbox image context
 * (`deploy/sandbox-image/scripts/prepare-context.mjs`), and the packaged desktop
 * app's closures (`apps/desktop/scripts/stage-harness.mjs`). Each used to answer
 * it privately, and the desktop app answered it by discovering nothing at all. One
 * module makes the three agree, and gives the exclusion set exactly one home.
 *
 * Discovery stays name-agnostic: every plugin directory the checkout carries is
 * discovered, whatever it is called, and the exclusion set is applied afterwards by
 * directory name. A new plugin therefore ships without touching this file, while a
 * directory that must never ship is filtered everywhere at once.
 *
 * Plain Node ESM with no dependencies and no repository install, because
 * `apps/desktop` sits outside the root pnpm workspace: this module is run by Node
 * and never bundled, so it may only import node builtins.
 *
 * @module scripts/plugin-roster
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under a checkout root that holds the fork's plugin repositories. */
export const PLUGINS_DIR_NAME = 'plugins'

/** Directory under a checkout root that holds the fork's skill repositories. */
export const SKILLS_DIR_NAME = 'skills'

/**
 * Plugin directories that must never be staged into a shipped build or loaded by
 * one. This is a security invariant rather than a deployment choice: no
 * configuration makes an attacker or a scratch plugin shippable, and the set is
 * keyed by directory name so a plugin is refused before its manifest is read.
 *
 * `crescendo-attacker` and `web-search-searxng` are gone from this fork's
 * `.gitmodules`, so a checkout that still carries them holds them as leftover
 * directories, which the name-agnostic discovery below would otherwise pick up and
 * build. `_security-review` is a scratch working directory that has held no
 * manifest of its own; it is named here so a later manifest cannot make it
 * shippable by accident.
 */
export const PLUGIN_EXCLUSIONS = new Map([
  ['crescendo-attacker', 'scratch attacker plugin, never part of a shipped build'],
  ['_security-review', 'scratch security-review directory, not a plugin'],
  ['web-search-searxng', 'removed from this fork, superseded by the web-search capability'],
])

/**
 * One discovered plugin.
 * @typedef {object} PluginEntry
 * @property {string} name directory name under the plugins tree, which is what {@link PLUGIN_EXCLUSIONS} keys on
 * @property {string} packageName the manifest `name`, which is the bundle name a profile lists
 * @property {string} dir absolute package directory
 * @property {string} patchPath absolute path of the `cordis.patch.yml` bundle layer
 */

/**
 * One discovered skill.
 * @typedef {object} SkillEntry
 * @property {string} name frontmatter `name`, which is the home skill-root entry the provider reads
 * @property {string} description frontmatter `description`
 * @property {string} category skills-tree subdirectory the skill was found in
 * @property {string} dir directory to copy into the home skill root
 * @property {string} file absolute path of the `SKILL.md` or flat `.md` file
 */

/** List immediate children of a directory, sorted, or [] when absent. */
function listDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

/** Read JSON, or undefined when the file is absent or unparsable. */
function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** True when a path is a directory, following symlinks. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The plugin directory trees of one checkout, in discovery order.
 * @param {string} harnessRoot the harness checkout root
 * @param {string[]} [roots] plugin roots to read instead of the default: a
 * caller with its own `$DSH_PLUGINS_REPO` override answers for one tree, and
 * the sandbox image adds its own `plugins/` beside the harness tree
 * @returns {string[]} the plugin roots to read
 */
export function pluginRoots(harnessRoot, roots) {
  if (roots !== undefined) return [...roots]
  return [join(harnessRoot, PLUGINS_DIR_NAME)]
}

/**
 * Discover the plugin packages a checkout carries.
 *
 * A directory counts when it holds both a `package.json` naming the package and a
 * `cordis.patch.yml`: the profile launcher composes a bundle by reading the
 * manifest's `dsh.bundle.patch` and loading that file, so a directory without
 * either is not a bundle and staging it would only fail at load time. The
 * manifest's `name` is the bundle name a profile lists, so a manifest without
 * one cannot be listed and is skipped.
 *
 * A directory named by {@link PLUGIN_EXCLUSIONS} is discovered like any other
 * and reported as excluded by {@link partitionPlugins}: dropping it here would hide
 * a scratch plugin sitting in the checkout.
 *
 * @param {string} harnessRoot the harness checkout root
 * @param {object} [options] `roots` replaces the plugin trees that are read
 * @returns {PluginEntry[]} every discovered plugin, sorted by directory name
 */
export function discoverPlugins(harnessRoot, options = {}) {
  const plugins = []
  const discovered = new Set()
  for (const root of pluginRoots(harnessRoot, options.roots)) {
    for (const name of listDir(root)) {
      // One name is judged once: two plugin trees may hold the same plugin, and
      // a plugin staged twice would be built and placed twice.
      if (discovered.has(name)) continue
      const dir = join(root, name)
      // A plugin directory may be a symlink into a sibling checkout, so the
      // directory probe follows links rather than reading the link itself.
      if (!isDirectory(dir)) continue
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest === undefined || typeof manifest.name !== 'string' || manifest.name === '') continue
      const patchPath = join(dir, 'cordis.patch.yml')
      if (!existsSync(patchPath)) continue
      discovered.add(name)
      plugins.push({ name, packageName: manifest.name, dir, patchPath })
    }
  }
  return plugins.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Split discovered plugins into what a shipped build carries and what it must not.
 * @param {PluginEntry[]} plugins the result of {@link discoverPlugins}
 * @returns {{shipped: PluginEntry[], excluded: Array<PluginEntry & {reason: string}>}} both halves, in discovery order
 */
export function partitionPlugins(plugins) {
  const shipped = []
  const excluded = []
  for (const plugin of plugins) {
    const reason = PLUGIN_EXCLUSIONS.get(plugin.name)
    if (reason === undefined) shipped.push(plugin)
    else excluded.push({ ...plugin, reason })
  }
  return { shipped, excluded }
}

/**
 * Format the excluded directories that ARE present, for a staging log.
 * @param {Array<PluginEntry & {reason: string}>} excluded the excluded half of {@link partitionPlugins}
 * @returns {string} one line naming each excluded directory and why, or '' when none is present
 */
export function describeExclusions(excluded) {
  if (excluded.length === 0) return ''
  const rows = excluded.map((plugin) => `${plugin.name} (${plugin.reason})`)
  return `excluded from this build: ${rows.join(', ')}`
}

/**
 * Frontmatter name and description of a SKILL.md, or undefined when unparseable.
 * @param {string} path the `SKILL.md` or flat `.md` file
 * @returns {Record<string, string> | undefined} the frontmatter keys, or undefined without a frontmatter block
 */
export function parseSkillFrontmatter(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null) return undefined
  const data = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/u.exec(line)
    if (kv !== null && data[kv[1]] === undefined) data[kv[1]] = kv[2].replace(/^["']|["']$/gu, '')
  }
  return data
}

/**
 * Describe one skill candidate, or undefined when it is not a usable skill.
 * @param {string} category the skills-tree subdirectory
 * @param {string} categoryDir the category's absolute directory
 * @param {string} entry the candidate's name inside the category
 * @param {string} path the candidate's absolute path
 * @returns {SkillEntry | undefined} the skill, or undefined when unusable
 */
function describeSkill(category, categoryDir, entry, path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    // A dangling link inside a skills tree is not a skill; discovery continues.
    return undefined
  }
  const isFlat = stat.isFile() && entry.endsWith('.md')
  const isBundle = stat.isDirectory() && existsSync(join(path, 'SKILL.md'))
  if (!isFlat && !isBundle) return undefined
  const file = isBundle ? join(path, 'SKILL.md') : path
  const frontmatter = parseSkillFrontmatter(file)
  if (frontmatter === undefined || typeof frontmatter.name !== 'string' || frontmatter.name === ''
    || typeof frontmatter.description !== 'string' || frontmatter.description === '') return undefined
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    category,
    dir: isBundle ? path : categoryDir,
    file,
  }
}

/**
 * Discover the skills a checkout carries.
 *
 * The rule is the skill-filesystem provider's own: an immediate child of a
 * skills-tree category is a skill when it is a directory holding `SKILL.md` or a
 * flat `.md` file, and either needs frontmatter with a non-empty `name` and
 * `description`. A candidate without them is not a usable skill, so shipping it
 * would only add an entry the provider ignores.
 *
 * Skill directories are not subject to {@link PLUGIN_EXCLUSIONS}: that set refuses
 * attacker and scratch PLUGINS, and no skill here is either.
 *
 * @param {string} harnessRoot the harness checkout root
 * @param {object} [options] `skillsRoot` replaces the skills tree that is read
 * @returns {SkillEntry[]} every discovered skill, sorted by category then name
 */
export function discoverSkills(harnessRoot, options = {}) {
  const skillsRoot = options.skillsRoot ?? join(harnessRoot, SKILLS_DIR_NAME)
  const skills = []
  for (const category of listDir(skillsRoot)) {
    const categoryDir = join(skillsRoot, category)
    if (!isDirectory(categoryDir)) continue
    for (const entry of listDir(categoryDir)) {
      const skill = describeSkill(category, categoryDir, entry, join(categoryDir, entry))
      if (skill !== undefined) skills.push(skill)
    }
  }
  return skills.sort((left, right) => `${left.category}/${left.name}`.localeCompare(`${right.category}/${right.name}`))
}

/**
 * `lstatSync` that answers undefined instead of throwing when a path is absent.
 * @param {string} path the path to inspect
 * @returns {import('node:fs').Stats | undefined} the link's own status, or undefined when absent
 */
export function lstatSafe(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}
