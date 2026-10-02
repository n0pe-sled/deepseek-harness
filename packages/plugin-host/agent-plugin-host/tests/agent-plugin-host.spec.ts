import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as AgentPluginHost from '@deepseek-ai/dsh-agent-plugin-host'
import { discoverBundle, readSkillBody } from '@deepseek-ai/dsh-agent-plugin-host'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Write one file, creating its directory. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Write the plugin manifest pair every fixture plugin carries. */
async function putManifests(pluginDir: string, manifest: Record<string, unknown>): Promise<void> {
  await put(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest))
  await put(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
}

/** A minimal usable skill body. */
function skill(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${extra}`
}

/** A minimal agent definition. */
function agent(name: string, sandboxMode: string): string {
  return [
    `name = "${name}"`,
    `description = "Fixture ${name}."`,
    'model = "fixture-model"',
    'model_reasoning_effort = "high"',
    `sandbox_mode = "${sandboxMode}"`,
    '',
    'developer_instructions = """',
    `You are the \`${name}\` fixture agent.`,
    '"""',
    '',
  ].join('\n')
}

/**
 * Build a marketplace-shaped bundle: one plugin with two skills, one agent
 * definition, one worker protocol prompt, one MCP declaration, and one reference
 * two levels above a skill.
 */
async function marketplaceFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-')))
  roots.push(root)
  const plugin = join(root, 'plugins', 'demo')
  await putManifests(plugin, {
    name: 'demo',
    version: '1.0.0',
    description: 'Fixture plugin.',
    interface: { displayName: 'Demo' },
  })
  await put(join(plugin, 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'Alpha.', '- Read `../../references/note.md`.'))
  await put(join(plugin, 'references', 'note.md'), 'reference\n')
  await put(join(plugin, 'skills', 'beta', 'SKILL.md'), skill('beta', 'Beta.'))
  await put(
    join(plugin, 'skills', 'beta', 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: false\n',
  )
  await put(join(plugin, 'agents', 'reviewer.toml'), agent('reviewer', 'read-only'))
  await put(join(plugin, 'agents', 'worker.md'), '---\nname: worker\ndescription: Protocol prompt.\n---\n')
  await put(join(plugin, 'mcp', 'manifest.json'), JSON.stringify({
    name: 'fixture_mcp',
    type: 'stdio',
    run: { command: 'uv', args: ['--directory', '/path/to/fixture', 'run', 'main.py'], entrypoint: 'main.py' },
    secrets: ['FIXTURE_TOKEN'],
    configuration: ['FIXTURE_URL'],
  }))
  return root
}

describe('dsh-agent-plugin-host discovery', () => {
  it('reads a marketplace bundle in place', async () => {
    const root = await marketplaceFixture()
    const discovery = await discoverBundle(root)

    expect(discovery.problems).toHaveLength(1)
    expect(discovery.problems[0]).toContain('fixture_mcp')
    expect(discovery.plugins).toHaveLength(1)
    const plugin = discovery.plugins[0]
    expect(plugin?.id).toBe('demo')
    expect(plugin?.displayName).toBe('Demo')
    expect(plugin?.version).toBe('1.0.0')
    expect(plugin?.skills.map(entry => entry.name)).toEqual(['alpha', 'beta'])
    expect(plugin?.agents.map(entry => entry.name)).toEqual(['reviewer'])
    expect(plugin?.mcpServers.map(entry => entry.name)).toEqual(['fixture_mcp'])
  })

  it('resolves a skill directory through its real path, not the link', async () => {
    const root = await marketplaceFixture()
    const linked = `${root}-link`
    roots.push(linked)
    await symlink(root, linked, 'dir')

    const discovery = await discoverBundle(linked)
    const alpha = discovery.plugins[0]?.skills.find(entry => entry.name === 'alpha')

    expect(alpha?.directory).toBe(join(root, 'plugins', 'demo', 'skills', 'alpha'))
    // The body's own reference sits two levels above the skill directory, so it
    // resolves only while the resource base is that directory.
    await expect(readSkillBody(alpha?.file ?? '')).resolves.toContain('../../references/note.md')
  })

  it('drops model invocation when the skill interface metadata forbids it', async () => {
    const discovery = await discoverBundle(await marketplaceFixture())
    const skills = discovery.plugins[0]?.skills ?? []

    expect(skills.find(entry => entry.name === 'alpha')?.modelInvocable).toBe(true)
    expect(skills.find(entry => entry.name === 'beta')?.modelInvocable).toBe(false)
  })

  it('maps a read-only definition to the mutating tools it must not reach', async () => {
    const discovery = await discoverBundle(await marketplaceFixture())
    const definition = discovery.plugins[0]?.agents[0]

    expect(definition?.toolName).toBe('reviewer')
    expect(definition?.instructions).toContain('`reviewer` fixture agent')
    expect(definition?.model).toBe('fixture-model')
    expect(definition?.reasoningEffort).toBe('high')
    expect(definition?.sandboxMode).toBe('read-only')
    expect(definition?.deniedTools).toEqual(['write', 'edit'])
  })

  it('leaves a workspace-write definition every tool', async () => {
    const root = await marketplaceFixture()
    await put(join(root, 'plugins', 'demo', 'agents', 'writer.toml'), agent('writer', 'workspace-write'))

    const discovery = await discoverBundle(root)
    const definition = discovery.plugins[0]?.agents.find(entry => entry.name === 'writer')

    expect(definition?.deniedTools).toEqual([])
  })

  it('never reads a markdown worker protocol as an agent definition', async () => {
    const discovery = await discoverBundle(await marketplaceFixture())

    expect(discovery.plugins[0]?.agents.map(entry => entry.name)).toEqual(['reviewer'])
  })

  it('holds an MCP declaration back while a placeholder path remains', async () => {
    const root = await marketplaceFixture()
    const server = (await discoverBundle(root)).plugins[0]?.mcpServers[0]

    expect(server?.actionable).toBe(false)
    expect(server?.args).toContain('/path/to/fixture')
  })

  it('activates an MCP declaration once its path and secret are supplied', async () => {
    const root = await marketplaceFixture()
    await put(join(root, 'plugins', 'demo', 'mcp', 'manifest.json'), JSON.stringify({
      name: 'fixture_mcp',
      type: 'stdio',
      run: { command: 'uv', args: ['--directory', '/opt/fixture', 'run', 'main.py'] },
      secrets: [],
      configuration: ['FIXTURE_URL'],
    }))

    const server = (await discoverBundle(root)).plugins[0]?.mcpServers[0]

    expect(server?.actionable).toBe(true)
    expect(server?.command).toBe('uv')
  })

  it('reads a single plugin directory as one plugin', async () => {
    const root = await marketplaceFixture()
    const discovery = await discoverBundle(join(root, 'plugins', 'demo'))

    expect(discovery.plugins.map(plugin => plugin.id)).toEqual(['demo'])
  })

  it('reports a plugin directory that declares no manifest', async () => {
    const root = await marketplaceFixture()
    await mkdir(join(root, 'plugins', 'nameless'), { recursive: true })

    const discovery = await discoverBundle(root)

    expect(discovery.problems.some(problem => problem.includes('nameless'))).toBe(true)
    expect(discovery.plugins.map(plugin => plugin.id)).toEqual(['demo'])
  })

  it('reports two manifests that disagree on a shared identity field', async () => {
    const root = await marketplaceFixture()
    await put(
      join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '2.0.0' }),
    )

    const discovery = await discoverBundle(root)

    expect(discovery.problems.some(problem => problem.includes('version'))).toBe(true)
  })

  it('reports a skill whose name differs from its directory', async () => {
    const root = await marketplaceFixture()
    await put(join(root, 'plugins', 'demo', 'skills', 'gamma', 'SKILL.md'), skill('delta', 'Gamma.'))

    const discovery = await discoverBundle(root)

    expect(discovery.problems.some(problem => problem.includes('gamma'))).toBe(true)
    expect(discovery.plugins[0]?.skills.map(entry => entry.name)).toEqual(['alpha', 'beta'])
  })

  it('fails loud when the caller names a root that is not a directory', async () => {
    await expect(discoverBundle(join(tmpdir(), 'agent-plugin-host-absent'))).rejects.toThrow(/cannot be read/)
  })
})

describe('dsh-agent-plugin-host contribution', () => {
  it('contributes the bundle and withdraws it on disposal', async () => {
    const root = await marketplaceFixture()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    const catalog = await ctx.skills.list()
    expect(catalog.map(skill => skill.name)).toEqual(['alpha', 'beta'])
    expect(catalog.every(skill => skill.provider === 'demo')).toBe(true)
    expect(catalog[0]?.resourceBase).toEqual({
      kind: 'directory',
      path: join(root, 'plugins', 'demo', 'skills', 'alpha'),
    })
    expect(catalog.find(skill => skill.name === 'beta')?.invocation.modelInvocable).toBe(false)
    expect((await ctx.skills.get('alpha'))?.content).toContain('../../references/note.md')

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ranks an installed skill below a project skill of the same name', async () => {
    const root = await marketplaceFixture()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.register({
      name: 'alpha',
      description: 'The project owns this name.',
      content: 'project',
      source: 'project-dsh',
    })
    await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    const winner = (await ctx.skills.list()).find(skill => skill.name === 'alpha')

    expect(winner?.source).toBe('project-dsh')
    expect(AgentPluginHost.AGENT_PLUGIN_SKILL_RANK).toBeGreaterThan(600)
  })

  it('fails loud when the named root carries no plugin manifest', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-empty-')))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)

    await expect(ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' }))
      .rejects.toThrow(/carries no plugin manifest/)
  })

  it('exposes the installed bundle on its catalog service', async () => {
    const root = await marketplaceFixture()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    expect((await ctx.agentPlugins.list()).map(plugin => plugin.id)).toEqual(['demo'])
    expect((await ctx.agentPlugins.listMcpServers()).map(server => server.name)).toEqual(['fixture_mcp'])
    expect((await ctx.agentPlugins.listAgentDefinitions()).map(entry => entry.toolName)).toEqual(['reviewer'])
  })
})
