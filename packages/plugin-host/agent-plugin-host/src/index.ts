/**
 * Host one installed Claude Code / Codex agent-plugin bundle.
 *
 * `dsh plugin install <plugin>@<marketplace>` writes one row naming this plugin
 * with the installed bundle's directory. This plugin then contributes what that
 * bundle carries: its skills to `ctx.skills`, one model-facing delegation tool
 * per `agents/*.toml` definition so an agent can call the installed agents by
 * name, and its `mcp/manifest.json` declarations to consumers that write MCP
 * client rows.
 *
 * The bundle is read in place and never rewritten, so a skill body that references
 * `../../references/…` keeps resolving against the installed plugin's own
 * subdirectories, and an upstream `git pull` reaches the next catalog read.
 *
 * @module @deepseek-ai/dsh-agent-plugin-host
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import {
  discoverBundle,
  readSkillBody,
  type BundleDiscovery,
  type DiscoveredAgentDefinition,
  type DiscoveredMcpServer,
  type DiscoveredPlugin,
  type DiscoveredSkill,
} from './discovery.ts'

export const name = 'agent-plugin-host'

/**
 * Re-exported for the package's own tests and for any consumer that needs the
 * discovery result without contributing the plugin, e.g. a listing command that
 * reports what an installed bundle carries.
 */
export { discoverBundle, readSkillBody } from './discovery.ts'
export type {
  BundleDiscovery,
  DiscoveredAgentDefinition,
  DiscoveredMcpServer,
  DiscoveredPlugin,
  DiscoveredSkill,
} from './discovery.ts'

/** The skill registry must exist before this plugin can contribute to it. */
export const inject = ['skills']

/**
 * Precedence rank of a skill an installed agent plugin contributes.
 *
 * Above `BUNDLED_SKILL_RANK` (600), so a person's own project, custom, and user
 * roots — and the deployment's bundled row — all win a duplicate name. An
 * installed plugin is content the person added; it must never shadow the content
 * that was already there.
 */
export const AGENT_PLUGIN_SKILL_RANK = 650

/** Origin bucket reported on every skill this plugin contributes. */
export const AGENT_PLUGIN_SKILL_SOURCE = 'agent-plugin'

/** The `ctx.subagents` provider every definition's delegation tool starts on. */
const DEFAULT_SUBAGENT_PROVIDER = 'spawn'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The installed agent-plugin bundles this deployment carries. */
    agentPlugins: AgentPluginDirectory
  }
}

/** Plugin configuration, written into the row `dsh plugin install` appends. */
export interface Config {
  /**
   * Absolute path of the installed bundle root: one plugin directory, or a
   * marketplace directory holding `plugins/`.
   */
  bundleRoot: string
  /**
   * Provider name on `ctx.skills`. Omission uses the first discovered plugin's
   * id, which is unique across a marketplace, so two installed plugins never
   * collide unless a marketplace ships two plugins under one id.
   */
  providerName?: string
  /** `ctx.subagents` provider every definition's delegation tool starts on. */
  subagentProvider?: string
  /**
   * Whether a delegated child can be followed up and resumed. `continuable`
   * matches the shipped presets and requires a provider with the
   * `prepareContinuable` capability.
   */
  backgroundMode?: 'one-shot' | 'continuable'
}

export const Config: Schema<Config> = z.object({
  bundleRoot: z.string().required(),
  providerName: z.string(),
  subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('continuable'),
})

/** One skill provider backed by one installed bundle root. */
class AgentPluginSkillProvider implements SkillProvider {
  constructor(
    private readonly ctx: Context,
    readonly name: string,
    private readonly root: string,
  ) {}

  /**
   * List the installed bundle's skills for the current lookup context.
   *
   * Discovery re-reads the tree on every call, so a bundle the person upgrades
   * or edits reaches the next catalog observation without a restart.
   * @param options - lookup options; a failed discovery is contained, not thrown.
   * @returns the bundle's skills, or an incomplete observation when the root
   *   could not be read this time.
   */
  async list(options: SkillLookupOptions): Promise<SkillProviderObservation> {
    options.signal?.throwIfAborted()
    let discovery: BundleDiscovery
    try {
      discovery = await discoverBundle(this.root)
    } catch (error) {
      this.ctx.logger.warn(`agent-plugin-host: "${this.root}" could not be re-read: ${String(error)}`)
      return { candidates: [], complete: false }
    }
    const candidates: SkillCandidate[] = []
    for (const skill of pluginSkills(discovery)) {
      candidates.push(toCandidate(skill, this.name))
    }
    return { candidates, complete: true }
  }

  /**
   * Load one skill's current body and confirm it still declares the selected name.
   * @param candidate - the winning candidate this provider returned.
   * @param options - lookup options; `signal` cancels the read.
   * @returns the loaded skill, or undefined when it moved or its name changed.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as { file: string; directory: string }
    const body = await readSkillBody(locator.file, options.signal)
    if (body === undefined) return undefined
    return {
      name: candidate.name,
      description: candidate.description,
      ...candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse },
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.file,
      ...candidate.metadata === undefined ? {} : { metadata: candidate.metadata },
      content: body,
    }
  }
}

/**
 * Exposes the installed bundles a deployment carries.
 *
 * The consumer is out of process — the Web GUI's Skills & MCP settings section
 * — so this is a service face rather than a private closure.
 */
export class AgentPluginDirectory extends Service {  constructor(ctx: Context, private readonly root: string) {
  super(ctx, 'agentPlugins')
}

/**
   * List every plugin the installed bundle carries.
   * @returns the discovered plugins, or an empty list when the root is unreadable.
   */
async list(): Promise<readonly DiscoveredPlugin[]> {
  return (await this.read()).plugins
}

/**
   * List every MCP server the installed bundle declares.
   * @returns the declarations, each reporting whether it can be activated.
   */
async listMcpServers(): Promise<readonly DiscoveredMcpServer[]> {
  const discovery = await this.read()
  return discovery.plugins.flatMap(plugin => plugin.mcpServers)
}

/**
   * List every agent definition the installed bundle carries.
   * @returns the definitions with the public tool name each is reached through.
   */
async listAgentDefinitions(): Promise<readonly DiscoveredAgentDefinition[]> {
  const discovery = await this.read()
  return discovery.plugins.flatMap(plugin => plugin.agents)
}

/** Re-read the installed bundle, reporting an unreadable root as empty. */
private async read(): Promise<BundleDiscovery> {
  try {
    return await discoverBundle(this.root)
  } catch (error) {
    this.ctx.logger.warn(`agent-plugin-host: "${this.root}" could not be read: ${String(error)}`)
    return { root: this.root, plugins: [], skills: [], problems: [] }
  }
}
}

/**
 * Contribute one installed agent-plugin bundle.
 * @param ctx - Cordis context carrying the skill registry.
 * @param config - the installed bundle's root directory and delegation defaults.
 * @returns a promise that settles once the bundle is contributed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const discovery = await discoverBundle(config.bundleRoot)
  for (const problem of discovery.problems) {
    ctx.logger.warn(`agent-plugin-host: ${problem}`)
  }
  if (discovery.plugins.length === 0) {
    throw new Error(
      `agent-plugin-host: "${discovery.root}" carries no plugin manifest; `
      + 'a bundle root is one plugin directory or a marketplace directory holding plugins/',
    )
  }
  const providerName = config.providerName ?? discovery.plugins[0]?.id
  /* v8 ignore start -- `stringField` rejects an empty manifest name, and an
     empty plugin list throws above, so no path reaches an absent id. */
  if (providerName === undefined) {
    throw new Error('agent-plugin-host: no plugin id is available to name the skill provider')
  }
  /* v8 ignore stop */
  ctx.skills.registerProvider(() => new AgentPluginSkillProvider(ctx, providerName, config.bundleRoot))
  mountDelegationTools(ctx, discovery, config)
  ctx.plugin(AgentPluginDirectory, config.bundleRoot)
}

/**
 * Mount one model-facing delegation tool per agent definition.
 *
 * The tool is the shipped subagent consumer, so each definition reaches the
 * child's persona, tool scope, and route through the same contract every other
 * delegation uses. Children join the delegating agent's preset composition, so an
 * installed agent can call another installed agent.
 */
function mountDelegationTools(ctx: Context, discovery: BundleDiscovery, config: Config): void {
  const seen = new Set<string>()
  for (const plugin of discovery.plugins) {
    for (const definition of plugin.agents) {
      if (seen.has(definition.toolName)) {
        ctx.logger.warn(
          `agent-plugin-host: agent "${definition.name}" from "${plugin.id}" is skipped: `
          + `public tool name "${definition.toolName}" is already registered`,
        )
        continue
      }
      seen.add(definition.toolName)
      ctx.plugin(toolSubagent, delegationRowFor(definition, config))
    }
  }
}

/**
 * The delegation row one agent definition mounts.
 *
 * `deny` carries only the tools the definition must not reach, so a definition
 * with no denial mounts the shipped consumer's own defaults rather than an empty
 * filter, which `tools.restrict()` rejects outright.
 * @param definition - the discovered definition to delegate through.
 * @param config - the deployment's provider, background mode, and route defaults.
 * @returns the `tool-subagent` row config for this definition.
 */
export function delegationRowFor(definition: DiscoveredAgentDefinition, config: Config): toolSubagent.Config {
  return {
    provider: config.subagentProvider ?? DEFAULT_SUBAGENT_PROVIDER,
    toolName: definition.toolName,
    backgroundMode: config.backgroundMode ?? 'continuable',
    persona: definition.instructions,
    ...definition.deniedTools.length === 0
      ? {}
      : { toolFilter: { deny: [...definition.deniedTools] } },
  }
}

/** Every skill an installed bundle contributes: plugin skills then standalone skills. */
function pluginSkills(discovery: BundleDiscovery): readonly DiscoveredSkill[] {
  return [...discovery.plugins.flatMap(plugin => plugin.skills), ...discovery.skills]
}

/** Project one discovered skill onto a registry candidate. */
function toCandidate(skill: DiscoveredSkill, provider: string): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    invocation: { modelInvocable: skill.modelInvocable, userInvocable: true },
    source: AGENT_PLUGIN_SKILL_SOURCE,
    provider,
    resourceBase: { kind: 'directory', path: skill.directory },
    rank: AGENT_PLUGIN_SKILL_RANK,
    locator: { file: skill.file, directory: skill.directory },
    path: skill.file,
    ...skill.metadata === undefined ? {} : { metadata: skill.metadata },
  }
}
