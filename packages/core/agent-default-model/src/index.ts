/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * A deployment may pin no selection at all: the shipped product pre-installs no
 * model provider, so the picker asks the user for one and each turn is refused
 * where it needs a route rather than starting on a model nothing serves.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model; undefined when the deployment pins none. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Settings namespace carrying the default model selection for future Agents. */
export const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = settingsNamespace('agent-default-model')

/**
 * Stored and composed default model selection. A section naming neither field
 * selects nothing: an unpinned composition entry and a selection the user cleared
 * are both valid, and neither is a missing required value.
 */
export interface AgentDefaultModelSettings {
  /** Registered provider route. */
  provider?: string
  /** Provider-owned model id. */
  model?: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: string
}

/** Schema of the default Agent model settings section. */
export const AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA: z<AgentDefaultModelSettings> = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

/**
 * Composition entry for the default model selection. Both fields or neither:
 * an entry naming one alone pins no selection, and the deployment sees that as
 * the unpinned state rather than as a half-configured one.
 */
export interface Config {
  /** Registered provider route. */
  provider?: string
  /** Provider-owned model id. */
  model?: string
}

/**
 * Project stored settings onto the Agent-facing selection type.
 * @param settings - the resolved settings section.
 * @returns a detached provider, model, and optional reasoning selection, or
 * undefined when the section names no usable pair.
 */
function selection(settings: AgentDefaultModelSettings): ModelSelection | undefined {
  const { provider, model } = settings
  // A user-editable document reaches this point as strings, so an empty value
  // counts as unnamed here rather than as a route nothing serves.
  if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
  return {
    provider,
    model,
    ...settings.reasoningEffort === undefined || settings.reasoningEffort === ''
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/**
 * Owns the default model selection independently of any Host or transport.
 * The composition entry remains usable without a settings provider; when one
 * is mounted, its user layer is read live. An entry that pins no pair leaves
 * every consumer in the unselected state.
 */
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string(),
    model: z.string(),
  })

  private source: () => AgentDefaultModelSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentDefaultModel')
    const entry: AgentDefaultModelSettings = {
      ...config.provider === undefined ? {} : { provider: config.provider },
      ...config.model === undefined ? {} : { model: config.model },
    }
    this.source = () => entry
    installSettingsSection(ctx, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, AGENT_DEFAULT_MODEL_SETTINGS_SCHEMA, entry, {
      setSource: (current) => { this.source = current },
      // Every consumer reads through currentSelection(), so no registration-level fact
      // needs rebuilding when the settings document changes.
      onChange: () => {},
    })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection, or
   * undefined when neither the composition entry nor the saved settings section
   * names a provider and a model.
   */
  currentSelection(): ModelSelection | undefined {
    return selection(this.source())
  }

  /**
   * Save the complete default model selection. A deployment without a settings
   * provider keeps its composition entry.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    await this.ctx.get('settings')?.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider,
      model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    })
  }
}

export default AgentDefaultModelConfig
