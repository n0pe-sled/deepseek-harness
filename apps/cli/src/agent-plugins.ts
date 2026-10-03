/**
 * `dsh plugin marketplace <add|list|remove>` and `dsh plugin <install|uninstall>`.
 *
 * This is the other half of `dsh plugin --profile <name> <pnpm args…>`: that form
 * installs an npm package that declares a dsh bundle, while these verbs install a
 * Claude Code / Codex agent-plugin bundle. Upstream publishes that layout with no
 * package manifest at all — `codex plugin marketplace add SpecterOps/skills`, then
 * install a plugin from it — so pnpm can neither fetch nor resolve it, and the
 * install is a directory on disk plus one row for the host that reads it.
 *
 * An install writes three things and records all three so `uninstall` reverses
 * exactly what it did: the profile's own `cordis.patch.yml` row naming
 * `@deepseek-ai/dsh-agent-plugin-host`, the plugin's agent count in
 * `$DSH_HOME/agent-plugins.json`, and — only when the plugin contributes an
 * agent definition and the key is absent — `configurable-subagents.singleLevel` in
 * `$DSH_HOME/settings.yaml`. That last one is what lets an installed agent call
 * another: `dsh-configurable-subagents` bars the shipped `subagent` and
 * `subagent_fork` tools from delegating when the setting is on, and states the
 * bar in the model's own tool guidance.
 *
 * @module @deepseek-ai/dsh/agent-plugins
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Document, parseDocument } from 'yaml'
import { PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const NAME = 'dsh'

/** The host plugin every install row mounts. */
const AGENT_PLUGIN_HOST = '@deepseek-ai/dsh-agent-plugin-host'

/** Loader row id prefix; the id is derived from the plugin id alone. */
const INSTALL_ROW_PREFIX = 'agent-plugin-'

/** Codex marketplace manifest: the complete one upstream ships. */
const CODEX_MARKETPLACE = join('.agents', 'plugins', 'marketplace.json')

/** Claude Code marketplace manifest, read when the Codex one is absent. */
const CLAUDE_MARKETPLACE = join('.claude-plugin', 'marketplace.json')

/** Codex plugin manifest; every upstream plugin ships one. */
const CODEX_PLUGIN = join('.codex-plugin', 'plugin.json')

/** Claude Code plugin manifest, shipped for a subset. */
const CLAUDE_PLUGIN = join('.claude-plugin', 'plugin.json')

/** Settings namespace owned by `dsh-configurable-subagents`. */
const SUBAGENT_NAMESPACE = 'configurable-subagents'

/** Settings key that bars a sub-agent from delegating further. */
const SINGLE_LEVEL_KEY = 'singleLevel'

/** Harness-home state file recording marketplaces and installs. */
const STATE_FILENAME = 'agent-plugins.json'

/** Harness-home directory holding cloned marketplaces. */
const MARKETPLACES_DIRNAME = 'marketplaces'

/** One marketplace this person added. */
interface MarketplaceSource {
  /** Marketplace name, from its manifest; the `@<marketplace>` half of an install. */
  name: string
  /** Absolute path of the bundle tree. */
  path: string
  /** The specification the person typed, kept so `list` shows it back. */
  origin: string
  /** Whether the tree was cloned here or is referenced where it already lived. */
  kind: 'local' | 'clone'
}

/** One installed plugin. */
interface InstallRecord {
  /** Marketplace the plugin was installed from. */
  marketplace: string
  /** Plugin id, which is also its row id and its skill provider name. */
  plugin: string
  /** Absolute path of the installed plugin directory. */
  bundleRoot: string
  /** Manifest version at install time, for orientation only. */
  version?: string
  /** Whether this install wrote the nesting setting. */
  wroteNesting: boolean
}

/** The persisted record of both halves. */
interface AgentPluginState {
  marketplaces: MarketplaceSource[]
  installed: InstallRecord[]
}

/** One marketplace manifest, reduced to what an install validates against. */
export interface MarketplaceManifest {
  /** Marketplace name. */
  name: string
  /** Plugin ids the marketplace lists, in declared order. */
  plugins: string[]
}

/** Narrow one unknown value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The state file path under the harness home. */
function statePath(home: string): string {
  return join(home, STATE_FILENAME)
}

/** Read the recorded state, or an empty state when the file is absent or unusable. */
function readState(home: string): AgentPluginState {
  let raw: string
  try {
    raw = readFileSync(statePath(home), 'utf8')
  } catch {
    return { marketplaces: [], installed: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${NAME}: ${statePath(home)} is not valid JSON: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error(`${NAME}: ${statePath(home)} must hold a JSON object`)
  const marketplaces = Array.isArray(parsed.marketplaces)
    ? parsed.marketplaces.filter(isMarketplaceSource)
    : []
  const installed = Array.isArray(parsed.installed) ? parsed.installed.filter(isInstallRecord) : []
  return { marketplaces, installed }
}

function isMarketplaceSource(value: unknown): value is MarketplaceSource {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.path === 'string'
    && typeof value.origin === 'string'
    && (value.kind === 'local' || value.kind === 'clone')
}

function isInstallRecord(value: unknown): value is InstallRecord {
  return isRecord(value)
    && typeof value.marketplace === 'string'
    && typeof value.plugin === 'string'
    && typeof value.bundleRoot === 'string'
    && typeof value.wroteNesting === 'boolean'
}

/** Write the recorded state back. */
function writeState(home: string, state: AgentPluginState): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(statePath(home), JSON.stringify(state, undefined, 2) + '\n')
}

/** Read one JSON object, or undefined when the file is absent or unusable. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Read one marketplace manifest.
 *
 * The Codex manifest is preferred because it lists every upstream plugin while the
 * Claude Code one lists only those published to that surface. A directory holding
 * neither is refused naming both paths rather than treated as an empty marketplace.
 * @param path - absolute path of the marketplace root.
 * @returns the marketplace name and its declared plugin ids.
 * @throws Error when neither manifest exists or declares a name.
 */
export function readMarketplace(path: string): MarketplaceManifest {
  const manifest = readJsonObject(join(path, CODEX_MARKETPLACE))
    ?? readJsonObject(join(path, CLAUDE_MARKETPLACE))
  if (manifest === undefined) {
    throw new Error(
      `${NAME}: "${path}" is not a marketplace — it holds neither ${CODEX_MARKETPLACE} nor ${CLAUDE_MARKETPLACE}`,
    )
  }
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : undefined
  if (name === undefined) throw new Error(`${NAME}: the marketplace at "${path}" declares no name`)
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : []
  return {
    name,
    plugins: plugins
      .map(entry => isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined)
      .filter((entry): entry is string => entry !== undefined),
  }
}

/**
 * Read one plugin directory's manifest id.
 * @param path - absolute path of the plugin directory.
 * @returns the manifest id, or undefined when neither manifest declares one.
 */
function readPluginId(path: string): string | undefined {
  return readPluginManifest(path).id
}

/**
 * Whether one installed plugin contributes an agent definition.
 *
 * A definition is a TOML file under the plugin's `agents/` directory; the
 * markdown files some plugins carry there are worker protocol prompts, never
 * registered agents. Only a definition needs the nesting setting.
 * @param path - absolute path of the plugin directory.
 * @returns whether the plugin contributes at least one agent definition.
 */
export function contributesAgentDefinition(path: string): boolean {
  let entries
  try {
    entries = readdirSync(join(path, 'agents'), { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some(entry => entry.isFile() && entry.name.endsWith('.toml'))
}

/**
 * Resolve one marketplace specification to a local directory.
 *
 * An existing path is referenced where it already lives, so a person working in a
 * checkout keeps working in it. An `owner/repo` shorthand is cloned once.
 * @param spec - the specification the person typed.
 * @param home - harness home holding cloned marketplaces.
 * @returns the resolved marketplace source, with its tree present.
 * @throws Error when a path is absent or a clone fails.
 */
export function resolveMarketplaceSource(spec: string, home: string): MarketplaceSource {
  if (existsSync(spec)) {
    const path = resolve(spec)
    const manifest = readMarketplace(path)
    return { name: manifest.name, path, origin: spec, kind: 'local' }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    throw new Error(`${NAME}: "${spec}" is neither an existing path nor an owner/repo specification`)
  }
  const directory = join(home, MARKETPLACES_DIRNAME, spec.slice(spec.indexOf('/') + 1))
  if (!existsSync(directory)) {
    mkdirSync(join(home, MARKETPLACES_DIRNAME), { recursive: true })
    const result = spawnSync(
      'git',
      ['clone', '--depth', '1', `https://github.com/${spec}.git`, directory],
      { stdio: 'inherit' },
    )
    if (result.error !== undefined) {
      throw new Error(`${NAME}: git is required to clone "${spec}": ${String(result.error)}`)
    }
    if ((result.status ?? 1) !== 0) {
      rmSync(directory, { recursive: true, force: true })
      throw new Error(`${NAME}: cloning "${spec}" failed with exit code ${String(result.status)}`)
    }
  }
  const manifest = readMarketplace(directory)
  return { name: manifest.name, path: directory, origin: spec, kind: 'clone' }
}

/** Read one plugin directory out of a resolved marketplace. */
function pluginDirectoryIn(source: MarketplaceSource, plugin: string): string {
  const nested = join(source.path, 'plugins', plugin)
  if (isDirectory(nested)) return nested
  if (isDirectory(source.path) && readPluginId(source.path) === plugin) return source.path
  throw new Error(
    `${NAME}: marketplace "${source.name}" carries no plugin "${plugin}" `
    + `(looked for ${join(source.path, 'plugins', plugin)})`,
  )
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The loader row id one plugin installs under. */
export function installRowId(plugin: string): string {
  return `${INSTALL_ROW_PREFIX}${plugin}`
}

/**
 * Whether a profile patch row is one this command wrote.
 * @param row - one parsed patch entry.
 * @returns whether the row names the host plugin and carries a derived id.
 */
export function isInstallRow(row: unknown): row is Record<string, unknown> & { id: string } {
  if (!isRecord(row)) return false
  return row.name === AGENT_PLUGIN_HOST
    && typeof row.id === 'string'
    && row.id.startsWith(INSTALL_ROW_PREFIX)
}

/** The row one install appends. */
export function installRowFor(plugin: string, bundleRoot: string): Record<string, unknown> {
  return {
    id: installRowId(plugin),
    name: AGENT_PLUGIN_HOST,
    config: { bundleRoot, providerName: plugin },
  }
}

/**
 * The patch list with one install row added, replaced, or removed.
 *
 * The profile patch is a top-level entry list, so a row is inserted inside the
 * first `insert:` list when the file already holds one and appended as its own
 * `insert:` entry otherwise. A row for the same plugin is replaced where it
 * already sits, because a patch list's order decides the loader's mount order and
 * a re-install must not move its row. Every other row is preserved verbatim,
 * including a hand-written `!!js` value, so this command never fights a person's
 * own edits.
 * @param rows - the parsed patch list.
 * @param row - the install row to add.
 * @param present - true to add or replace the row, false to remove it.
 * @returns the new patch list.
 */
export function withInstallRow(
  rows: readonly unknown[],
  row: Record<string, unknown>,
  present: boolean,
): unknown[] {
  const id = row.id
  let placed = false
  const kept: unknown[] = []
  for (const entry of rows) {
    if (isInstallRow(entry)) {
      if (entry.id !== id) {
        kept.push(entry)
        continue
      }
      placed = true
      if (present) kept.push(row)
      continue
    }
    if (isRecord(entry) && Array.isArray(entry.insert)) {
      const remaining: unknown[] = []
      let found = false
      for (const item of entry.insert) {
        if (!isInstallRow(item) || item.id !== id) {
          remaining.push(item)
          continue
        }
        found = true
        if (present && !placed) {
          remaining.push(row)
          placed = true
        }
      }
      if (found) placed = true
      if (remaining.length > 0) kept.push({ ...entry, insert: remaining })
      continue
    }
    kept.push(entry)
  }
  if (!present || placed) return kept
  const insert = kept.find(entry => isRecord(entry) && Array.isArray(entry.insert))
  if (isRecord(insert) && Array.isArray(insert.insert)) {
    kept[kept.indexOf(insert)] = { ...insert, insert: [...insert.insert, row] }
    return kept
  }
  return [...kept, { insert: [row] }]
}

/** Parse a profile patch file with the loader dialect. */
export function parsePatchList(text: string): unknown[] {
  if (text.trim() === '') return []
  const parsed: unknown = yaml.load(text, { schema: entryListSchema })
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) {
    throw new Error(`${NAME}: the profile patch must hold a top-level YAML list of entries`)
  }
  return parsed
}

/** Serialize a profile patch list with the loader dialect. */
export function dumpPatchList(rows: readonly unknown[]): string {
  return yaml.dump(rows, { schema: entryListSchema, noRefs: true })
}

/** The settings document path the file provider defaults to. */
function settingsPath(home: string): string {
  return join(home, 'settings.yaml')
}

/** What turning the nesting setting off did. */
export type NestingOutcome =
  /** This call added `singleLevel: false`; `uninstall` removes it again. */
  | 'written'
  /** The person already turned it off; nothing was written. */
  | 'present'
  /** The person turned it on deliberately; nothing was written. */
  | 'conflict'

/**
 * Turn nested delegation on for the agents an install contributes.
 *
 * `dsh-configurable-subagents` defaults this on, which bars the shipped
 * `subagent` and `subagent_fork` tools from delegating further AND states that
 * bar in the delegating agent's own tool guidance, so an installed agent would
 * neither route to another installed agent nor read that it may. The write happens
 * only when the key is absent: a key the person set to `true` is a deliberate
 * deployment choice, and this command reports the conflict instead of overriding
 * it. Every other section and comment in the document is preserved.
 * @param home - harness home holding `settings.yaml`.
 * @returns which of the three outcomes happened.
 */
export function enableNestedDelegation(home: string): NestingOutcome {
  const file = settingsPath(home)
  const document = readSettingsDocument(file)
  const existing = document.getIn([SUBAGENT_NAMESPACE, SINGLE_LEVEL_KEY])
  if (existing === false) return 'present'
  if (existing !== undefined) return 'conflict'
  document.setIn([SUBAGENT_NAMESPACE, SINGLE_LEVEL_KEY], false)
  mkdirSync(home, { recursive: true })
  writeFileSync(file, document.toString())
  return 'written'
}

/**
 * Remove the nesting setting this command added, and only that.
 *
 * A value the person changed after the install is theirs and stays; this command
 * removes the key only while it still holds what the install wrote.
 * @param home - harness home holding `settings.yaml`.
 * @returns whether the key this install added was removed.
 */
export function disableNestedDelegation(home: string): boolean {
  const file = settingsPath(home)
  if (!existsSync(file)) return false
  const document = readSettingsDocument(file)
  if (document.getIn([SUBAGENT_NAMESPACE, SINGLE_LEVEL_KEY]) !== false) return false
  document.deleteIn([SUBAGENT_NAMESPACE, SINGLE_LEVEL_KEY])
  // Leaving an empty section behind would be residue this command created.
  if (document.get(SUBAGENT_NAMESPACE) === undefined) document.delete(SUBAGENT_NAMESPACE)
  writeFileSync(file, document.toString())
  return true
}

/** Parse the settings document, tolerating an absent or empty file. */
function readSettingsDocument(file: string): Document {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return new Document({})
  }
  let document: Document
  try {
    document = parseDocument(raw)
  } catch (error) {
    throw new Error(`${NAME}: ${file} is not valid YAML: ${String(error)}`)
  }
  if (document.contents === null) document.contents = document.createNode({})
  return document
}

/** Resolve the patch file of the profile an install targets. */
function profilePatchPath(profile: string, home: string): string {
  return join(resolveProfileDir(profile, home), PROFILE_PATCH_FILENAME)
}

/** Read the profile patch list, or an empty list when the file is absent. */
function readProfilePatch(file: string): unknown[] {
  try {
    return parsePatchList(readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
}

/** Write the profile patch list back only when it actually changed. */
function writeProfilePatch(file: string, rows: readonly unknown[]): void {
  const content = dumpPatchList(rows)
  try {
    if (readFileSync(file, 'utf8') === content) return
  } catch {
    // An absent or unreadable patch file is written below.
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** Split `<plugin>@<marketplace>` on its last `@`. */
function splitInstallSpec(spec: string): { plugin: string; marketplace: string } | undefined {
  const at = spec.lastIndexOf('@')
  if (at <= 0 || at === spec.length - 1) return undefined
  return { plugin: spec.slice(0, at), marketplace: spec.slice(at + 1) }
}

/**
 * Run one agent-plugin command.
 *
 * `install` and `uninstall` claim only the `<plugin>@<marketplace>` form whose
 * marketplace this person actually added; every other spelling returns undefined so
 * the caller forwards it to pnpm unchanged, which is what keeps `dsh plugin
 * install <package>` and `dsh plugin remove <package>` working as before.
 * @param profile - the profile the install targets.
 * @param args - the arguments after `dsh plugin`.
 * @returns the exit code, or undefined when pnpm owns these arguments.
 */
export function runAgentPluginCommand(profile: string, args: readonly string[]): number | undefined {
  const [verb, ...rest] = args
  if (verb === 'marketplace') return runMarketplace(rest)
  if (verb !== 'install' && verb !== 'uninstall') return undefined
  if (rest.length !== 1) return undefined
  const spec = splitInstallSpec(rest[0] as string)
  if (spec === undefined) return undefined
  const home = resolveDshHome()
  const state = readState(home)
  if (!state.marketplaces.some(entry => entry.name === spec.marketplace)) return undefined
  return verb === 'install' ? installPlugin(profile, home, spec) : uninstallPlugin(profile, home, spec)
}

/** `dsh plugin marketplace <add|list|remove>`. */
function runMarketplace(args: readonly string[]): number {
  const home = resolveDshHome()
  const [verb, spec] = args
  switch (verb) {
    case 'add': {
      if (spec === undefined) throw new Error(`${NAME}: marketplace add requires a path or an owner/repo specification`)
      const source = resolveMarketplaceSource(spec, home)
      const state = readState(home)
      const existing = state.marketplaces.findIndex(entry => entry.name === source.name)
      if (existing >= 0) {
        state.marketplaces[existing] = source
        process.stdout.write(`${NAME}: marketplace ${source.name} updated at ${source.path}\n`)
      } else {
        state.marketplaces.push(source)
        process.stdout.write(`${NAME}: marketplace ${source.name} added at ${source.path}\n`)
      }
      writeState(home, state)
      const manifest = readMarketplace(source.path)
      process.stdout.write(`  ${String(manifest.plugins.length)} plugin(s): ${manifest.plugins.join(', ')}\n`)
      printMarketplaceHint(source.name, manifest.plugins)
      return 0
    }
    case 'list':
    case undefined: {
      const state = readState(home)
      if (state.marketplaces.length === 0) {
        process.stdout.write(`${NAME}: no marketplaces added\n`)
        return 0
      }
      for (const entry of state.marketplaces) {
        process.stdout.write(`${entry.name}\t${entry.origin}\t${entry.path}\n`)
        for (const plugin of state.installed.filter(record => record.marketplace === entry.name)) {
          process.stdout.write(`  ${plugin.plugin}${plugin.version === undefined ? '' : `\t${plugin.version}`}\n`)
        }
      }
      return 0
    }
    case 'remove': {
      if (spec === undefined) throw new Error(`${NAME}: marketplace remove requires a marketplace name`)
      const state = readState(home)
      const source = state.marketplaces.find(entry => entry.name === spec)
      if (source === undefined) throw new Error(`${NAME}: no marketplace named "${spec}" is added`)
      const installed = state.installed.filter(record => record.marketplace === spec)
      if (installed.length > 0) {
        throw new Error(
          `${NAME}: marketplace "${spec}" still has ${installed.map(record => record.plugin).join(', ')} installed; `
          + 'uninstall them first',
        )
      }
      state.marketplaces = state.marketplaces.filter(entry => entry.name !== spec)
      writeState(home, state)
      if (source.kind === 'clone') rmSync(source.path, { recursive: true, force: true })
      process.stdout.write(`${NAME}: marketplace ${spec} removed\n`)
      return 0
    }
    default:
      throw new Error(`${NAME}: marketplace takes add, list, or remove, not "${String(verb)}"`)
  }
}

/** Install one plugin from an added marketplace into a profile. */
function installPlugin(
  profile: string,
  home: string,
  spec: { plugin: string; marketplace: string },
): number {
  const state = readState(home)
  const source = state.marketplaces.find(entry => entry.name === spec.marketplace)
  /* v8 ignore next -- the caller resolved this marketplace out of the same state. */
  if (source === undefined) throw new Error(`${NAME}: no marketplace named "${spec.marketplace}" is added`)
  const bundleRoot = pluginDirectoryIn(source, spec.plugin)
  if (readPluginId(bundleRoot) !== spec.plugin) {
    throw new Error(
      `${NAME}: the plugin at "${bundleRoot}" declares a different name than "${spec.plugin}"`,
    )
  }
  const nesting = contributesAgentDefinition(bundleRoot)
  const outcome = nesting ? enableNestedDelegation(home) : 'present'
  const patchPath = profilePatchPath(profile, home)
  const row = installRowFor(spec.plugin, bundleRoot)
  writeProfilePatch(patchPath, withInstallRow(readProfilePatch(patchPath), row, true))
  const manifest = readPluginManifest(bundleRoot)
  state.installed = [
    ...state.installed.filter(record => record.plugin !== spec.plugin || record.marketplace !== spec.marketplace),
    {
      marketplace: spec.marketplace,
      plugin: spec.plugin,
      bundleRoot,
      ...manifest.version === undefined ? {} : { version: manifest.version },
      wroteNesting: outcome === 'written',
    },
  ]
  writeState(home, state)
  process.stdout.write(`${NAME}: installed ${spec.plugin}@${spec.marketplace} from ${bundleRoot}\n`)
  process.stdout.write(`  row ${installRowId(spec.plugin)} written to ${patchPath}\n`)
  if (nesting) reportNesting(outcome)
  return 0
}

/** Uninstall one plugin, reversing exactly what its install wrote. */
function uninstallPlugin(
  profile: string,
  home: string,
  spec: { plugin: string; marketplace: string },
): number {
  const state = readState(home)
  const record = state.installed.find(
    entry => entry.plugin === spec.plugin && entry.marketplace === spec.marketplace,
  )
  if (record === undefined) {
    throw new Error(`${NAME}: ${spec.plugin}@${spec.marketplace} is not installed`)
  }
  const patchPath = profilePatchPath(profile, home)
  writeProfilePatch(patchPath, withInstallRow(readProfilePatch(patchPath), installRowFor(spec.plugin, record.bundleRoot), false))
  state.installed = state.installed.filter(entry => entry !== record)
  writeState(home, state)
  process.stdout.write(`${NAME}: uninstalled ${spec.plugin}@${spec.marketplace}\n`)
  if (record.wroteNesting) {
    process.stdout.write(disableNestedDelegation(home)
      ? `  removed ${SUBAGENT_NAMESPACE}.${SINGLE_LEVEL_KEY} from ${settingsPath(home)}\n`
      : `  kept ${SUBAGENT_NAMESPACE}.${SINGLE_LEVEL_KEY} in ${settingsPath(home)}: it is no longer what this install wrote\n`)
  }
  return 0
}

/** State the nesting outcome, naming the exact switch a conflict needs. */
function reportNesting(outcome: NestingOutcome): void {
  if (outcome === 'written') {
    process.stdout.write(
      `  set ${SUBAGENT_NAMESPACE}.${SINGLE_LEVEL_KEY}: false in ${settingsPath(resolveDshHome())} `
      + 'so an installed agent can call another\n',
    )
    return
  }
  if (outcome === 'conflict') {
    process.stderr.write(
      `${NAME}: warning: ${SUBAGENT_NAMESPACE}.${SINGLE_LEVEL_KEY} is true, so a sub-agent may not delegate `
      + 'further and will not route to another installed agent. Set it false to allow nested delegation.\n',
    )
  }
}

/** Print the install command for each plugin a marketplace offers. */
function printMarketplaceHint(name: string, plugins: readonly string[]): void {
  for (const plugin of plugins.slice(0, 3)) {
    process.stdout.write(`  ${NAME} plugin install ${plugin}@${name}\n`)
  }
  if (plugins.length > 3) process.stdout.write(`  … and ${String(plugins.length - 3)} more\n`)
}

/** Read one plugin manifest's id, version, and display name. */
function readPluginManifest(path: string): { id?: string; version?: string } {
  const manifest = readJsonObject(join(path, CODEX_PLUGIN)) ?? readJsonObject(join(path, CLAUDE_PLUGIN))
  const id = manifest?.name
  const version = manifest?.version
  return {
    ...typeof id === 'string' && id.length > 0 ? { id } : {},
    ...typeof version === 'string' && version.length > 0 ? { version } : {},
  }
}
