import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-plugin-host'
import type {} from '@deepseek-ai/dsh-tools'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('agent-plugin-host snapshot requires an overlay path')
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('agent-plugin-host-snapshot', rootConfigPath, [
  ...loadOverlayPatches('agent-plugin-host-snapshot', basePatchPath),
  ...loadOverlayPatches('agent-plugin-host-snapshot', overlayPath),
])

try {
  const agentId = SessionId('agent-plugin-host-snapshot')
  const session = ctx.sessions.create(agentId, { meta: { cwd: process.cwd() } })
  const agent: Agent = {
    ctx: new Context(),
    id: agentId,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('agent-plugin-host snapshot must receive the catalog at the step boundary') },
    cancel: () => {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const catalog = decision.kind === 'enter'
    ? decision.messages.find(message => message.role === 'user'
      && message.source.kind === 'skill-catalog')?.content
    : undefined
  const definitions = await ctx.agentPlugins.listAgentDefinitions()
  const mcp = await ctx.agentPlugins.listMcpServers()
  const plugins = (await ctx.agentPlugins.list()).map(plugin => ({
    id: plugin.id,
    displayName: plugin.displayName ?? null,
    version: plugin.version ?? null,
    skills: plugin.skills.map(skill => skill.name),
    agents: plugin.agents.map(definition => definition.name),
    mcpServers: plugin.mcpServers.map(server => server.name),
  }))
  const result = await ctx.tools.execute({
    callId: CallId('agent-plugin-host-snapshot'),
    name: 'skill',
    arguments: { name: 'alpha' },
    signal: new AbortController().signal,
  })
  const value = (result as { value?: { content?: unknown; resourceBase?: { path?: string } } }).value
  const resourceBase = value?.resourceBase?.path
  // The reference sits two levels above the skill's own directory, which only
  // resolves while the bundle is read in place: a flattened copy would resolve it
  // against the skill root instead.
  const reference = resourceBase === undefined
    ? null
    : await readFile(resolve(resourceBase, '../../references/note.md'), 'utf8').catch(() => null)
  process.stdout.write(`${JSON.stringify({
    catalog: catalog ?? null,
    nodes: ctx.tools.get('reviewer') === undefined ? [] : ['reviewer'],
    worker: ctx.tools.get('worker') === undefined ? [] : ['worker'],
    definitions,
    mcp,
    plugins,
    result,
    reference,
    resourceBaseAbsolute: resourceBase !== undefined && isAbsolute(resourceBase),
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
