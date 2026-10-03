/**
 * Discovery of an installed Claude Code / Codex agent-plugin bundle.
 *
 * A bundle root is a directory in the upstream plugin layout: either one plugin
 * directory holding `skills/` and optional `agents/` and `mcp/`, or a marketplace
 * directory holding `plugins/<plugin>/` with the same contents. Discovery reads the
 * tree in place and never copies or rewrites it, so a skill body that references
 * `../../references/…` keeps resolving against the installed plugin's own
 * subdirectories.
 *
 * Every unusable child is reported and skipped, so one bad file cannot hide the rest
 * of an installed bundle. A bundle root that is absent or is not a directory is the
 * caller's misconfiguration and fails loud instead.
 *
 * @module @deepseek-ai/dsh-agent-plugin-host/discovery
 */

import type { Dirent } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

/** Directory holding a plugin's skills, one directory per skill. */
const SKILLS_DIR = 'skills'
/** Directory holding a plugin's agent definitions, one TOML file per agent. */
const AGENTS_DIR = 'agents'
/** Directory holding a plugin's MCP server declaration. */
const MCP_DIR = 'mcp'
/** A skill's body filename inside its own directory. */
const SKILL_FILE = 'SKILL.md'
/** Per-skill interface metadata beside the body, carrying the invocation policy. */
const SKILL_UI_FILE = join('agents', 'openai.yaml')
/** Codex plugin manifest, which all 25 upstream plugins ship. */
const CODEX_MANIFEST = join('.codex-plugin', 'plugin.json')
/** Claude Code plugin manifest, which only some upstream plugins ship. */
const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json')
/** A marketplace's own plugin list in the Codex layout. */
const CODEX_MARKETPLACE = join('.agents', 'plugins', 'marketplace.json')
/** A marketplace's own plugin list in the Claude Code layout. */
const CLAUDE_MARKETPLACE = join('.claude-plugin', 'marketplace.json')
/** MCP server declaration beside the plugin it belongs to. */
const MCP_MANIFEST = join(MCP_DIR, 'manifest.json')
/** The skill-name grammar `ctx.skills` accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The public tool-name grammar every delegation tool name must satisfy. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** Frontmatter `$skill` reference inside a definition's instructions. */
const SKILL_REFERENCE = /\$([a-z0-9]+(?:-[a-z0-9]+)*)/gu

/**
 * The sandbox mode whose intent this host can honour: a definition that must not
 * write. Upstream's schema requires a non-empty string and enumerates nothing, so
 * any other value is recorded as provenance and enforces nothing.
 */
const READ_ONLY_SANDBOX = 'read-only'

/** Global tool names a read-only definition must not reach. */
const MUTATING_TOOLS: readonly string[] = ['write', 'edit']

/** One skill discovered inside a bundle. */
export interface DiscoveredSkill {
  /** Kebab-case frontmatter name, which equals the skill's directory name. */
  readonly name: string
  /** Routing description from frontmatter. */
  readonly description: string
  /** Extra routing guidance from frontmatter, when the body declares it. */
  readonly whenToUse?: string
  /** Absolute path of the skill's `SKILL.md`. */
  readonly file: string
  /**
   * Absolute real path of the skill directory, used verbatim as the skill's
   * resource base. Resolved through `realpath` because a bundle root is commonly
   * a symbolic link into the checkout a person installed from, and the linked path
   * would make the body's relative resource references resolve elsewhere.
   */
  readonly directory: string
  /** Whether the skill's interface metadata permits model invocation. */
  readonly modelInvocable: boolean
  /** Upstream frontmatter `metadata`, plus `license` when the body declares one. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** One upstream agent definition, read from `agents/<name>.toml`. */
export interface DiscoveredAgentDefinition {
  /** Id of the plugin the definition belongs to. */
  readonly pluginId: string
  /** Definition name, which the file stem must equal. */
  readonly name: string
  /** One-line purpose plus upstream `Use for …` routing guidance. */
  readonly description: string
  /** Model id the definition names: recorded provenance, never a pinned route. */
  readonly model?: string
  /** Reasoning effort the definition names: recorded provenance. */
  readonly reasoningEffort?: string
  /** Sandbox mode the definition names; `read-only` becomes a tool denial. */
  readonly sandboxMode?: string
  /** The definition's `developer_instructions`, used verbatim as the persona. */
  readonly instructions: string
  /** Skill names its instructions reference as `$name`, for reporting only. */
  readonly skillReferences: readonly string[]
  /** Model-facing tool name this definition is delegated through. */
  readonly toolName: string
  /** Global tool names the child must not reach, empty when it may reach all. */
  readonly deniedTools: readonly string[]
}

/** One MCP server declaration, read from `mcp/manifest.json`. */
export interface DiscoveredMcpServer {
  /** Id of the plugin declaring the server. */
  readonly pluginId: string
  /** Server name the manifest declares. */
  readonly name: string
  /** Transport the manifest declares, e.g. `stdio`. */
  readonly type: string
  /** Executable the manifest says to run. */
  readonly command: string
  /** Arguments the manifest says to pass; may still hold upstream placeholders. */
  readonly args: readonly string[]
  /** Display entry point the manifest documents. */
  readonly entrypoint?: string
  /** Credential environment variable names the server requires. */
  readonly secrets: readonly string[]
  /** Non-secret environment variable names the server reads. */
  readonly configuration: readonly string[]
  /**
   * Whether the declaration carries enough to write an MCP client row. False
   * while an argument is still an upstream `/path/to/…` placeholder or a
   * declared credential is unset, because upstream ships declarations only and
   * expects the person to clone each server and supply its values.
   */
  readonly actionable: boolean
}

/** One plugin inside a bundle root. */
export interface DiscoveredPlugin {
  /** Plugin id, from whichever manifest declares it. */
  readonly id: string
  /** Absolute path of the plugin directory. */
  readonly directory: string
  /** Display name from the Codex manifest interface block, when present. */
  readonly displayName?: string
  /** Description from the plugin manifest. */
  readonly description?: string
  /** Version from the plugin manifest. */
  readonly version?: string
  /** Skills the plugin ships, one per `skills/<name>` directory. */
  readonly skills: readonly DiscoveredSkill[]
  /** Agent definitions the plugin ships. */
  readonly agents: readonly DiscoveredAgentDefinition[]
  /** MCP servers the plugin declares. */
  readonly mcpServers: readonly DiscoveredMcpServer[]
}

/** Everything one bundle root supplied, plus everything unusable it held. */
export interface BundleDiscovery {
  /** Bundle root the result was read from, absolute and real. */
  readonly root: string
  /** Every usable plugin, sorted by id. */
  readonly plugins: readonly DiscoveredPlugin[]
  /** Standalone skills the root's own `skills/` directory holds. */
  readonly skills: readonly DiscoveredSkill[]
  /**
   * Root agent definitions the root's own `agents/` directory holds.
   *
   * Upstream keeps its shared definitions here rather than under a plugin, and one
   * plugin's `ownership.json` may name several at once, so a root definition
   * belongs to the bundle: `pluginId` names the bundle.
   */
  readonly agents: readonly DiscoveredAgentDefinition[]
  /** One human-readable diagnostic per unusable entry. */
  readonly problems: readonly string[]
}

/**
 * Read one bundle root in place.
 *
 * The two root shapes are told apart by what the root itself holds: a root with a
 * `skills/` directory is one plugin, and a root with a `plugins/` directory is a
 * marketplace. A marketplace's own `plugins/` wins when both are present, because
 * that is the shape whose children carry the manifests.
 * @param root - absolute path of the installed bundle root.
 * @returns the usable plugins and standalone skills plus every diagnostic.
 * @throws Error when the root is absent or is not a directory, because the caller
 *   named it and its absence is a fault rather than empty state.
 */
export async function discoverBundle(root: string): Promise<BundleDiscovery> {
  const absolute = await resolveRootDirectory(root)
  const entries = await readdir(absolute, { withFileTypes: true })
  const directories = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  const problems: string[] = []
  const skills = directories.has(SKILLS_DIR)
    ? await discoverSkills(join(absolute, SKILLS_DIR), problems)
    : []
  const plugins = directories.has('plugins')
    ? await discoverMarketplace(absolute, problems)
    : await discoverSinglePlugin(absolute, problems)
  const agents = directories.has(AGENTS_DIR)
    ? await discoverAgentDefinitions(join(absolute, AGENTS_DIR), await bundleNameOf(absolute), problems)
    : []
  return { root: absolute, plugins, skills, agents, problems }
}

/** Resolve one root directory, failing loud when the caller named a non-directory. */
async function resolveRootDirectory(path: string): Promise<string> {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new Error(`agent-plugin-host: bundle root "${path}" cannot be read: ${errorMessage(error)}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`agent-plugin-host: bundle root "${path}" is not a directory`)
  }
  return await realpath(path)
}

/** Read every plugin a marketplace root lists, reporting each unusable child. */
async function discoverMarketplace(root: string, problems: string[]): Promise<readonly DiscoveredPlugin[]> {
  const entries = await readdir(join(root, 'plugins'), { withFileTypes: true })
  const plugins: DiscoveredPlugin[] = []
  for (const entry of sortByName(entries)) {
    if (!entry.isDirectory()) {
      problems.push(`marketplace entry "${entry.name}" is not a directory`)
      continue
    }
    const plugin = await discoverPlugin(join(root, 'plugins', entry.name), problems)
    if (plugin !== undefined) plugins.push(plugin)
  }
  return sortedBy(plugins, plugin => plugin.id)
}

/** Read one plugin directory. */
async function discoverSinglePlugin(directory: string, problems: string[]): Promise<readonly DiscoveredPlugin[]> {
  const plugin = await discoverPlugin(directory, problems)
  return plugin === undefined ? [] : [plugin]
}

/**
 * Read one plugin directory.
 *
 * The Codex manifest is authoritative: every upstream plugin ships one while only
 * some ship a Claude Code manifest, so reading Claude alone would drop the three
 * Codex-only tradecraft plugins. A plugin with neither is reported and skipped,
 * and two manifests that disagree on a shared identity field are reported, because
 * upstream's own catalog generator enforces that agreement.
 */
async function discoverPlugin(directory: string, problems: string[]): Promise<DiscoveredPlugin | undefined> {
  const codex = await readJsonObject(join(directory, CODEX_MANIFEST))
  const claude = await readJsonObject(join(directory, CLAUDE_MANIFEST))
  const manifest = codex ?? claude
  if (manifest === undefined) {
    problems.push(`plugin "${directory}" declares neither ${CODEX_MANIFEST} nor ${CLAUDE_MANIFEST}`)
    return undefined
  }
  const id = stringField(manifest, 'name')
  if (id === undefined) {
    problems.push(`plugin "${directory}" declares no manifest name`)
    return undefined
  }
  if (codex !== undefined && claude !== undefined) {
    for (const field of ['name', 'description', 'version'] as const) {
      const left = stringField(codex, field)
      const right = stringField(claude, field)
      if (left !== undefined && right !== undefined && left !== right) {
        problems.push(
          `plugin "${id}" declares ${field} "${left}" in ${CODEX_MANIFEST} and "${right}" in ${CLAUDE_MANIFEST}`,
        )
      }
    }
  }
  return {
    id,
    directory,
    ...optionalField('displayName', displayNameOf(manifest)),
    ...optionalField('description', stringField(manifest, 'description')),
    ...optionalField('version', stringField(manifest, 'version')),
    skills: await discoverSkills(join(directory, SKILLS_DIR), problems),
    agents: await discoverAgentDefinitions(join(directory, AGENTS_DIR), id, problems),
    mcpServers: await discoverMcpServers(join(directory, MCP_MANIFEST), id, problems),
  }
}

/** The Codex manifest's display name, or undefined for a manifest without one. */
function displayNameOf(manifest: Record<string, unknown>): string | undefined {
  return stringField(nestedRecord(manifest, 'interface'), 'displayName')
}

/**
 * Read every skill directory under one `skills/` directory.
 *
 * A skill is a directory holding `SKILL.md`; the `README.md` index every
 * upstream plugin ships beside them is a file and is skipped silently.
 */
async function discoverSkills(directory: string, problems: string[]): Promise<readonly DiscoveredSkill[]> {
  const entries = await readdirOrNone(directory)
  if (entries === undefined) return []
  const skills: DiscoveredSkill[] = []
  for (const entry of sortByName(entries)) {
    if (!entry.isDirectory()) continue
    const skill = await discoverSkill(join(directory, entry.name), entry.name, problems)
    if (skill !== undefined) skills.push(skill)
  }
  return sortedBy(skills, skill => skill.name)
}

/** Read one skill directory into a candidate, reporting why an unusable one was skipped. */
async function discoverSkill(directory: string, directoryName: string, problems: string[]): Promise<DiscoveredSkill | undefined> {
  const file = join(directory, SKILL_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    problems.push(`skill "${directoryName}" has no readable ${SKILL_FILE}: ${errorMessage(error)}`)
    return undefined
  }
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === undefined) {
    problems.push(`skill "${directoryName}" has no YAML frontmatter block`)
    return undefined
  }
  const name = stringField(frontmatter.data, 'name')
  const description = stringField(frontmatter.data, 'description')
  if (name === undefined || description === undefined) {
    problems.push(`skill "${directoryName}" frontmatter requires name and description`)
    return undefined
  }
  if (!SKILL_NAME.test(name)) {
    problems.push(`skill "${directoryName}" declares invalid name "${name}"`)
    return undefined
  }
  if (name !== directoryName) {
    problems.push(`skill "${directoryName}" declares name "${name}", which must equal its directory name`)
    return undefined
  }
  const modelInvocable = await modelInvocableOf(directory, name, problems)
  if (modelInvocable === undefined) return undefined
  const license = stringField(frontmatter.data, 'license')
  const metadata = metadataOf(frontmatter.data, license)
  return {
    name,
    description,
    ...optionalField('whenToUse', stringField(frontmatter.data, 'whenToUse')),
    file,
    directory: await realpath(directory),
    modelInvocable,
    ...metadata === undefined ? {} : { metadata },
  }
}

/**
 * Read a skill's own interface metadata for its invocation policy.
 *
 * A missing file means the skill declares no policy and is model-invocable, which
 * matches the shipped default. A present but unusable file drops the skill, because
 * ignoring unreadable invocation data could expose a skill on a disabled surface.
 */
async function modelInvocableOf(directory: string, name: string, problems: string[]): Promise<boolean | undefined> {
  const file = join(directory, SKILL_UI_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (isAbsentPathError(error)) return true
    problems.push(`skill "${name}" has an unreadable ${SKILL_UI_FILE}: ${errorMessage(error)}`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    problems.push(`skill "${name}" has invalid YAML in ${SKILL_UI_FILE}: ${errorMessage(error)}`)
    return undefined
  }
  const policy = nestedRecord(parsed, 'policy')
  const allowed = policy?.allow_implicit_invocation
  if (allowed === undefined) return true
  if (typeof allowed !== 'boolean') {
    problems.push(`skill "${name}" declares a non-boolean policy.allow_implicit_invocation`)
    return undefined
  }
  return allowed
}

/**
 * Read every agent definition under one plugin's `agents/` directory.
 *
 * Only this TOML location declares registered agents. A plugin-level
 * `agents/*.md` file is a worker protocol prompt, not an agent: upstream's own
 * go-review skill states that those filenames are not callable agent names.
 */
async function discoverAgentDefinitions(
  directory: string,
  pluginId: string,
  problems: string[],
): Promise<readonly DiscoveredAgentDefinition[]> {
  const entries = await readdirOrNone(directory)
  if (entries === undefined) return []
  const definitions: DiscoveredAgentDefinition[] = []
  for (const entry of sortByName(entries)) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue
    const definition = await discoverAgentDefinition(join(directory, entry.name), pluginId, problems)
    if (definition !== undefined) definitions.push(definition)
  }
  return sortedBy(definitions, definition => definition.name)
}

/**
 * The bundle's own name, which a root agent definition is attributed to.
 *
 * A marketplace manifest names the bundle; a directory holding none is named by
 * its own last segment, which is the layout a person installed by hand.
 */
async function bundleNameOf(root: string): Promise<string> {
  const manifest = await readJsonObject(join(root, CODEX_MARKETPLACE))
    ?? await readJsonObject(join(root, CLAUDE_MARKETPLACE))
  return stringField(manifest, 'name') ?? root.slice(root.lastIndexOf('/') + 1)
}

/** Read one agent definition TOML file, reporting why an unusable one was skipped. */
async function discoverAgentDefinition(
  file: string,
  pluginId: string,
  problems: string[],
): Promise<DiscoveredAgentDefinition | undefined> {
  const stem = basenameWithoutExtension(file)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    problems.push(`agent definition "${stem}" cannot be read: ${errorMessage(error)}`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseToml(raw)
  } catch (error) {
    problems.push(`agent definition "${stem}" is not valid TOML: ${errorMessage(error)}`)
    return undefined
  }
  /* v8 ignore start -- A TOML document is a table by grammar, so this guard only fires if the parser starts returning a non-table. */
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push(`agent definition "${stem}" is not a TOML table`)
    return undefined
  }
  /* v8 ignore stop */
  const table = parsed as Record<string, unknown>
  const name = stringField(table, 'name')
  const description = stringField(table, 'description')
  const instructions = stringField(table, 'developer_instructions')
  if (name === undefined || description === undefined || instructions === undefined) {
    problems.push(`agent definition "${stem}" requires name, description, and developer_instructions`)
    return undefined
  }
  if (name !== stem) {
    problems.push(`agent definition "${stem}" declares name "${name}", which must equal its file stem`)
    return undefined
  }
  const toolName = name.replaceAll('-', '_')
  if (!TOOL_NAME.test(toolName)) {
    problems.push(`agent definition "${name}" yields public tool name "${toolName}", which is not a legal tool name`)
    return undefined
  }
  const sandboxMode = stringField(table, 'sandbox_mode')
  return {
    pluginId,
    name,
    description,
    ...optionalField('model', stringField(table, 'model')),
    ...optionalField('reasoningEffort', stringField(table, 'model_reasoning_effort')),
    ...optionalField('sandboxMode', sandboxMode),
    instructions,
    skillReferences: [...instructions.matchAll(SKILL_REFERENCE)].map(match => match[1] as string),
    toolName,
    deniedTools: sandboxMode === READ_ONLY_SANDBOX ? MUTATING_TOOLS : [],
  }
}

/**
 * Read one MCP server declaration.
 *
 * The declaration's field set is validated here because upstream ships no JSON
 * schema for it: a declaration missing a field this host consumes is reported
 * rather than written as a row with an absent value.
 */
async function discoverMcpServers(
  file: string,
  pluginId: string,
  problems: string[],
): Promise<readonly DiscoveredMcpServer[]> {
  const manifest = await readJsonObject(file)
  if (manifest === undefined) return []
  const name = stringField(manifest, 'name')
  const type = stringField(manifest, 'type')
  const run = nestedRecord(manifest, 'run')
  const command = stringField(run, 'command')
  if (name === undefined || type === undefined || command === undefined) {
    problems.push(`MCP declaration ${file} requires name, type, and run.command`)
    return []
  }
  const args = stringArray(run, 'args')
  const secrets = stringArray(manifest, 'secrets')
  const configuration = stringArray(manifest, 'configuration')
  if (args === undefined || secrets === undefined || configuration === undefined) {
    problems.push(`MCP declaration ${file} requires run.args, secrets, and configuration arrays`)
    return []
  }
  const missing = secrets.filter(secret => (process.env[secret] ?? '') === '')
  const placeholders = args.filter(argument => PLACEHOLDER_PATH.test(argument))
  const actionable = missing.length === 0 && placeholders.length === 0
  if (!actionable) {
    const reasons = [
      ...placeholders.length === 0 ? [] : [`${placeholders.length} placeholder argument(s)`],
      ...missing.length === 0 ? [] : [`unset ${missing.join(', ')}`],
    ]
    problems.push(`MCP server "${name}" is declared but not actionable: ${reasons.join('; ')}`)
  }
  const entrypoint = stringField(run, 'entrypoint')
  return [{
    pluginId,
    name,
    type,
    command,
    args,
    ...optionalField('entrypoint', entrypoint),
    secrets,
    configuration,
    actionable,
  }]
}

/** An upstream argument a person must replace before the server can start. */
const PLACEHOLDER_PATH = /^\/path\/to\//

/** Read one JSON object, or undefined when the file is absent or unusable. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/** Read a directory's entries, or undefined when the directory is absent. */
async function readdirOrNone(directory: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isAbsentPathError(error)) return undefined
    throw error
  }
}

/**
 * Read one skill's current instruction body.
 *
 * A load re-reads the file rather than trusting discovery's earlier read, so a
 * body edited between the two takes effect on the next load with no revision
 * protocol, matching how the filesystem provider treats a body.
 * @param file - absolute path of the skill's `SKILL.md`.
 * @param signal - cancels the read for the current caller.
 * @returns the trimmed body, or undefined when the file is gone or unparsable.
 */
export async function readSkillBody(file: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  let raw: string
  try {
    raw = await readFile(file, { encoding: 'utf8', signal })
  } catch {
    return undefined
  }
  signal?.throwIfAborted()
  return parseFrontmatter(raw)?.body.trim()
}

/** Parse a `---` delimited YAML frontmatter block into its data and body. */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      const yaml = raw.slice(firstLineEnd + 1, lineStart)
      let parsed: unknown
      try {
        parsed = parseYaml(yaml)
      } catch {
        return undefined
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return {
        data: parsed as Record<string, unknown>,
        body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  /* v8 ignore next -- Every loop iteration returns inside the body, so the loop cannot exit here. */
  return undefined
}

/** The frontmatter `metadata` object plus `license`, when either is present. */
function metadataOf(data: Record<string, unknown>, license: string | undefined): Readonly<Record<string, unknown>> | undefined {
  const metadata = data.metadata
  const base = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
  const merged = { ...base, ...license === undefined ? {} : { license } }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/**
 * Read one nested object field, or undefined when its holder or the field is not
 * an object. The holder is `unknown` because one call site has parsed YAML and
 * another a manifest field that may be absent.
 */
function nestedRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  const holder = asRecord(source)
  const value = holder?.[key]
  return asRecord(value)
}

/** Narrow one unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one non-empty string field of a possibly absent holder, or undefined. */
function stringField(source: unknown, key: string): string | undefined {
  const value = asRecord(source)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one string-array field, or undefined when it is absent or wrongly typed. */
function stringArray(source: unknown, key: string): string[] | undefined {
  const value = asRecord(source)?.[key]
  if (value === undefined) return []
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value as string[]
    : undefined
}

/** Omit one optional key entirely rather than storing an explicit `undefined`. */
function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V }
}

/** Sort directory entries by name for a deterministic catalog. */
function sortByName<T extends { readonly name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name))
}

/** Sort a result list by one derived key for a deterministic catalog. */
function sortedBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)))
}

/** The filename stem, which an agent definition's `name` must equal. */
function basenameWithoutExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/** Whether a filesystem failure means the path is simply absent. */
function isAbsentPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Render an arbitrary failure without trusting coercion. */
function errorMessage(error: unknown): string {
  return String(error)
}
