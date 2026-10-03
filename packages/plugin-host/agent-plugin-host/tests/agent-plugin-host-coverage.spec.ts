import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as AgentPluginHost from '@deepseek-ai/dsh-agent-plugin-host'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** One file's bytes, absent when the path does not exist. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** A fresh bundle root holding one plugin directory. */
async function freshPlugin(): Promise<{ root: string; plugin: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-cov-')))
  roots.push(root)
  const plugin = join(root, 'plugins', 'demo')
  await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo' }))
  return { root, plugin }
}

/** A skill body with the given frontmatter lines. */
function skillBody(lines: readonly string[]): string {
  return `---\n${lines.join('\n')}\n---\n\n# Skill\n`
}

describe('agent-plugin-host bundle root refusals', () => {
  it('refuses a bundle root that is a file', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-cov-')))
    roots.push(root)
    const file = join(root, 'not-a-directory')
    await put(file, 'x\n')

    await expect(AgentPluginHost.discoverBundle(file)).rejects.toThrow(/is not a directory/)
  })
})

describe('agent-plugin-host plugin refusals', () => {
  it('reports a marketplace entry that is a file', async () => {
    const { root } = await freshPlugin()
    await put(join(root, 'plugins', 'loose.md'), 'x\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('marketplace entry "loose.md" is not a directory'))
  })

  it('reports a marketplace plugin that declares no manifest', async () => {
    const { root } = await freshPlugin()
    await mkdir(join(root, 'plugins', 'nameless'), { recursive: true })

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares neither'))
    expect(discovery.problems).toContainEqual(expect.stringContaining('nameless'))
  })

  it('reports a manifest that is valid JSON but not an object', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, '.codex-plugin', 'plugin.json'), '[]')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares neither'))
  })

  it('reports a manifest that declares no name', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ description: 'no name' }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares no manifest name'))
  })

  it('reports two manifests that disagree on a name', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other' }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares name "demo"'))
  })

  it('reports two manifests that disagree on a description', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'left' }))
    await put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'right' }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares description "left"'))
  })

  it('reads a Claude manifest when no Codex manifest exists', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-cov-')))
    roots.push(root)
    const plugin = join(root, 'plugins', 'demo')
    await put(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo',
      description: 'Claude only.',
      version: '2.0.0',
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.id).toBe('demo')
    expect(discovery.plugins[0]?.version).toBe('2.0.0')
    expect(discovery.plugins[0]?.displayName).toBeUndefined()
  })

  it('reads a Codex interface display name', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo',
      description: 'Described.',
      version: '1.0.0',
      interface: { displayName: 'Demo' },
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.displayName).toBe('Demo')
  })
})

describe('agent-plugin-host skill refusals', () => {
  it('skips a skills index file and a directory without a body', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'README.md'), '# Included Skills\n')
    await mkdir(join(plugin, 'skills', 'empty'), { recursive: true })

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills).toEqual([])
  })

  it('reports a skill directory without a readable body', async () => {
    const { root, plugin } = await freshPlugin()
    await mkdir(join(plugin, 'skills', 'gamma'), { recursive: true })

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('has no readable SKILL.md'))
  })

  it('reports a skill without a frontmatter block', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), '# no frontmatter\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('has no YAML frontmatter block'))
  })

  it('reports a skill whose frontmatter omits a required field', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), skillBody(['name: gamma']))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('requires name and description'))
  })

  it('reports a skill whose name is not kebab-case', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'Gamma', 'SKILL.md'), skillBody(['name: Gamma', 'description: Gamma.']))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('declares invalid name "Gamma"'))
  })

  it('reads whenToUse and license metadata when a body declares them', async () => {
    const { root, plugin } = await freshPlugin()
    await put(
      join(plugin, 'skills', 'gamma', 'SKILL.md'),
      skillBody(['name: gamma', 'description: Gamma.', 'whenToUse: When testing.', 'license: MIT']),
    )

    const discovery = await AgentPluginHost.discoverBundle(root)
    const skill = discovery.plugins[0]?.skills[0]

    expect(skill?.metadata).toEqual({ license: 'MIT' })
  })

  it('reads a skill that declares no metadata object', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills[0]?.metadata).toBeUndefined()
  })
})

describe('agent-plugin-host invocation metadata refusals', () => {
  it('reports an unreadable interface file', async () => {
    const { root, plugin } = await freshPlugin()
    const skill = join(plugin, 'skills', 'gamma')
    await put(join(skill, 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))
    await mkdir(join(skill, 'agents', 'openai.yaml'), { recursive: true })

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('has an unreadable'))
  })

  it('reports interface metadata that is not valid YAML', async () => {
    const { root, plugin } = await freshPlugin()
    const skill = join(plugin, 'skills', 'gamma')
    await put(join(skill, 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))
    await put(join(skill, 'agents', 'openai.yaml'), 'policy: [unclosed\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('has invalid YAML in'))
  })

  it('reads an interface file that declares no policy', async () => {
    const { root, plugin } = await freshPlugin()
    const skill = join(plugin, 'skills', 'gamma')
    await put(join(skill, 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))
    await put(join(skill, 'agents', 'openai.yaml'), 'interface:\n  display_name: Gamma\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills[0]?.modelInvocable).toBe(true)
  })

  it('reads an explicit policy that permits invocation', async () => {
    const { root, plugin } = await freshPlugin()
    const skill = join(plugin, 'skills', 'gamma')
    await put(join(skill, 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))
    await put(join(skill, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills[0]?.modelInvocable).toBe(true)
  })

  it('reports a policy that is not a boolean', async () => {
    const { root, plugin } = await freshPlugin()
    const skill = join(plugin, 'skills', 'gamma')
    await put(join(skill, 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.']))
    await put(join(skill, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: nope\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('non-boolean policy.allow_implicit_invocation'))
  })
})

describe('agent-plugin-host agent definition refusals', () => {
  /** Write one agent definition file under a fresh plugin. */
  async function withDefinition(name: string, body: string): Promise<string> {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'agents', name), body)
    return root
  }

  it('reads a definition without an agents directory', async () => {
    const { root } = await freshPlugin()

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.agents).toEqual([])
  })

  it('reports a definition whose file cannot be parsed as TOML', async () => {
    const root = await withDefinition('reviewer.toml', 'name = "unterminated\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('is not valid TOML'))
  })

  it('reads a definition whose file is an empty TOML document', async () => {
    const root = await withDefinition('reviewer.toml', '')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('requires name, description, and developer_instructions'))
  })

  it('reports a definition that omits a required key', async () => {
    const root = await withDefinition('reviewer.toml', 'name = "reviewer"\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('requires name, description, and developer_instructions'))
  })

  it('reports a definition whose name differs from its file stem', async () => {
    const root = await withDefinition(
      'reviewer.toml',
      'name = "other"\ndescription = "D."\ndeveloper_instructions = "I."\n',
    )

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('must equal its file stem'))
  })

  it('reports a definition whose name is not a legal tool name', async () => {
    const root = await withDefinition(
      'reviewer.v2.toml',
      'name = "reviewer.v2"\ndescription = "D."\ndeveloper_instructions = "I."\n',
    )

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('is not a legal tool name'))
  })

  it('reads a definition that declares no sandbox mode', async () => {
    const root = await withDefinition(
      'reviewer.toml',
      'name = "reviewer"\ndescription = "D."\ndeveloper_instructions = "Route to `$other`."\n',
    )

    const discovery = await AgentPluginHost.discoverBundle(root)
    const definition = discovery.plugins[0]?.agents[0]

    expect(definition?.sandboxMode).toBeUndefined()
    expect(definition?.deniedTools).toEqual([])
    expect(definition?.skillReferences).toEqual(['other'])
    expect(definition?.model).toBeUndefined()
    expect(definition?.reasoningEffort).toBeUndefined()
  })

  it('reports a definition whose file cannot be read', async () => {
    const root = await withDefinition('reviewer.toml', 'name = "reviewer"\n')
    const file = join(root, 'plugins', 'demo', 'agents', 'reviewer.toml')
    await chmod(file, 0o000)
    try {
      const discovery = await AgentPluginHost.discoverBundle(root)

      expect(discovery.problems).toContainEqual(expect.stringContaining('cannot be read'))
    } finally {
      await chmod(file, 0o600)
    }
  })
})

describe('agent-plugin-host MCP declaration refusals', () => {
  /** Write one declaration under a fresh plugin. */
  async function withDeclaration(body: string): Promise<string> {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'mcp', 'manifest.json'), body)
    return root
  }

  it('reports a declaration that is not JSON', async () => {
    const root = await withDeclaration('{nope')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.mcpServers).toEqual([])
  })

  it('reports a declaration missing the required fields', async () => {
    const root = await withDeclaration(JSON.stringify({ name: 'mcp' }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('requires name, type, and run.command'))
  })

  it('reports a declaration missing the required arrays', async () => {
    const root = await withDeclaration(JSON.stringify({
      name: 'mcp',
      type: 'stdio',
      run: { command: 'uv', args: 'nope' },
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('requires run.args, secrets, and configuration arrays'))
  })

  it('reports a declaration whose declared secret is set and path is real', async () => {
    const root = await withDeclaration(JSON.stringify({
      name: 'mcp',
      type: 'stdio',
      run: { command: 'uv', args: ['run', 'main.py'], entrypoint: 'main.py' },
      secrets: ['FIXTURE_SET_SECRET'],
      configuration: [],
    }))
    process.env.FIXTURE_SET_SECRET = 'set'
    try {
      const discovery = await AgentPluginHost.discoverBundle(root)
      const server = discovery.plugins[0]?.mcpServers[0]

      expect(server?.actionable).toBe(true)
      expect(server?.entrypoint).toBe('main.py')
      expect(discovery.problems).toEqual([])
    } finally {
      delete process.env.FIXTURE_SET_SECRET
    }
  })

  it('reports every reason a declaration is not actionable', async () => {
    const root = await withDeclaration(JSON.stringify({
      name: 'mcp',
      type: 'stdio',
      run: { command: 'uv', args: ['--directory', '/path/to/server', 'run'] },
      secrets: ['FIXTURE_UNSET_SECRET'],
      configuration: [],
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('1 placeholder argument(s); unset FIXTURE_UNSET_SECRET'))
  })
})

describe('agent-plugin-host live re-read', () => {
  it('reports an empty catalog once the root disappears', async () => {
    const { root } = await freshPlugin()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })
    await expect(ctx.skills.list()).resolves.toEqual([])

    await rm(root, { recursive: true, force: true })

    await expect(ctx.skills.list()).resolves.toEqual([])
    await expect(ctx.agentPlugins.list()).resolves.toEqual([])
    await fiber.dispose()
  })

  it('returns no definition once the body disappears after discovery', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'alpha', 'SKILL.md'), skillBody(['name: alpha', 'description: Alpha.']))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })
    const candidate = (await ctx.skills.list()).find(skill => skill.name === 'alpha')

    await unlink(join(plugin, 'skills', 'alpha', 'SKILL.md'))

    expect(await ctx.skills.get('alpha')).toBeUndefined()
    await fiber.dispose()
    void candidate
  })

  it('names the provider after the plugin id when none is configured', async () => {
    const { root } = await freshPlugin()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root })

    expect((await ctx.skills.snapshot()).skills).toEqual([])
    await fiber.dispose()
  })
})

describe('agent-plugin-host delegation rows', () => {
  it('skips a definition whose tool name another plugin already registered', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-plugin-host-cov-')))
    roots.push(root)
    for (const id of ['one', 'two']) {
      const plugin = join(root, 'plugins', id)
      await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: id }))
      await put(
        join(plugin, 'agents', 'reviewer.toml'),
        'name = "reviewer"\ndescription = "D."\ndeveloper_instructions = "I."\nsandbox_mode = "workspace-write"\n',
      )
    }
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    expect(await ctx.agentPlugins.listAgentDefinitions()).toHaveLength(2)
    await fiber.dispose()
  })
})

describe('agent-plugin-host standalone skills', () => {
  it('contributes a root-level skill beside the plugins', async () => {
    const { root } = await freshPlugin()
    await put(join(root, 'skills', 'solo', 'SKILL.md'), skillBody(['name: solo', 'description: Solo.']))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['solo'])
    await fiber.dispose()
  })

  it('symlinks a bundle root the person installed through', async () => {
    const { root } = await freshPlugin()
    await put(join(root, 'skills', 'solo', 'SKILL.md'), skillBody(['name: solo', 'description: Solo.']))
    const linked = `${root}-link`
    roots.push(linked)
    await symlink(root, linked, 'dir')

    const discovery = await AgentPluginHost.discoverBundle(linked)

    expect(discovery.plugins[0]?.skills).toEqual([])
  })
})

describe('agent-plugin-host body and directory refusals', () => {
  it('returns no body when the file cannot be read', async () => {
    const { plugin } = await freshPlugin()
    const file = join(plugin, 'skills', 'gamma', 'SKILL.md')
    await put(file, skillBody(['name: gamma', 'description: Gamma.']))
    await chmod(file, 0o000)
    try {
      await expect(AgentPluginHost.readSkillBody(file)).resolves.toBeUndefined()
    } finally {
      await chmod(file, 0o600)
    }
  })

  it('returns no body when the frontmatter block never closes', async () => {
    const { plugin } = await freshPlugin()
    const file = join(plugin, 'skills', 'gamma', 'SKILL.md')
    await put(file, '---\nname: gamma\n')

    await expect(AgentPluginHost.readSkillBody(file)).resolves.toBeUndefined()
  })

  it('returns no body when the frontmatter is not a mapping', async () => {
    const { plugin } = await freshPlugin()
    const file = join(plugin, 'skills', 'gamma', 'SKILL.md')
    await put(file, '---\n- gamma\n---\n\n# Gamma\n')

    await expect(AgentPluginHost.readSkillBody(file)).resolves.toBeUndefined()
  })

  it('returns no body when the file holds no newline', async () => {
    const { plugin } = await freshPlugin()
    const file = join(plugin, 'skills', 'gamma', 'SKILL.md')
    await put(file, '---')

    await expect(AgentPluginHost.readSkillBody(file)).resolves.toBeUndefined()
  })

  it('reports a skills directory that cannot be listed', async () => {
    const { root, plugin } = await freshPlugin()
    const skills = join(plugin, 'skills')
    await mkdir(skills, { recursive: true })
    await chmod(skills, 0o000)
    try {
      await expect(AgentPluginHost.discoverBundle(root)).rejects.toThrow(/EACCES|permission denied/)
    } finally {
      await chmod(skills, 0o700)
    }
  })

  it('reports a declaration whose only fault is a placeholder argument', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'mcp', 'manifest.json'), JSON.stringify({
      name: 'mcp',
      type: 'stdio',
      run: { command: 'uv', args: ['--directory', '/path/to/server'] },
      secrets: [],
      configuration: [],
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('1 placeholder argument(s)'))
    expect(discovery.problems).toContainEqual(expect.not.stringContaining('unset'))
  })

  it('reports a declaration whose only fault is an unset credential', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'mcp', 'manifest.json'), JSON.stringify({
      name: 'mcp',
      type: 'stdio',
      run: { command: 'uv', args: ['run', 'main.py'] },
      secrets: ['FIXTURE_ONLY_UNSET'],
      configuration: [],
    }))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('unset FIXTURE_ONLY_UNSET'))
    expect(discovery.problems).toContainEqual(expect.not.stringContaining('placeholder'))
  })

  it('re-reads an installed bundle after its root disappears', async () => {
    const { root } = await freshPlugin()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })
    await ctx.skills.list({ cwd: '/one' })

    await rm(root, { recursive: true, force: true })

    await expect(ctx.skills.list({ cwd: '/two' })).resolves.toEqual([])
    await expect(ctx.skills.snapshot({ cwd: '/two' })).resolves.toEqual({ skills: [], complete: false })
    await fiber.dispose()
  })
})

describe('agent-plugin-host frontmatter and configuration edges', () => {
  it('reads a skill declaring whenToUse, metadata, and a license', async () => {
    const { root, plugin } = await freshPlugin()
    await put(
      join(plugin, 'skills', 'gamma', 'SKILL.md'),
      skillBody(['name: gamma', 'description: Gamma.', 'whenToUse: When testing.', 'metadata:', '  author: fixture']),
    )
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    const summary = (await ctx.skills.list()).find(skill => skill.name === 'gamma')
    const loaded = await ctx.skills.get('gamma')

    expect(summary?.whenToUse).toBe('When testing.')
    expect(loaded?.metadata).toEqual({ author: 'fixture' })
    await fiber.dispose()
  })

  it('reports no metadata when the object is empty', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.', 'metadata: {}']))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills[0]?.metadata).toBeUndefined()
  })

  it('ignores a null metadata value', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), skillBody(['name: gamma', 'description: Gamma.', 'metadata:']))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.plugins[0]?.skills[0]?.metadata).toBeUndefined()
  })

  it('reads a frontmatter block closed by the last line without a newline', async () => {
    const { plugin } = await freshPlugin()
    const file = join(plugin, 'skills', 'gamma', 'SKILL.md')
    await put(file, '---\nname: gamma\ndescription: Gamma.\n---')

    await expect(AgentPluginHost.readSkillBody(file)).resolves.toBe('')
  })

  it('reports an agents directory that cannot be listed', async () => {
    const { root, plugin } = await freshPlugin()
    const agents = join(plugin, 'agents')
    await mkdir(agents, { recursive: true })
    await chmod(agents, 0o000)
    try {
      await expect(AgentPluginHost.discoverBundle(root)).rejects.toThrow(/EACCES|permission denied/)
    } finally {
      await chmod(agents, 0o700)
    }
  })

  it('mounts a one-shot delegation row for a read-only definition', async () => {
    const { root, plugin } = await freshPlugin()
    await put(
      join(plugin, 'agents', 'reviewer.toml'),
      'name = "reviewer"\ndescription = "D."\ndeveloper_instructions = "I."\nsandbox_mode = "read-only"\n',
    )
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, {
      bundleRoot: root,
      providerName: 'demo',
      backgroundMode: 'one-shot',
      subagentProvider: 'spawn',
    })

    expect(await ctx.agentPlugins.listAgentDefinitions()).toHaveLength(1)
    await fiber.dispose()
  })
})

describe('agent-plugin-host delegation row and frontmatter faults', () => {
  it('mounts a read-only definition under the deployment defaults', () => {
    const definition = {
      pluginId: 'demo',
      name: 'reviewer',
      description: 'D.',
      instructions: 'I.',
      skillReferences: [],
      toolName: 'reviewer',
      deniedTools: [],
    }

    expect(AgentPluginHost.delegationRowFor(definition, { bundleRoot: '/b' })).toEqual({
      provider: 'spawn',
      toolName: 'reviewer',
      backgroundMode: 'continuable',
      persona: 'I.',
    })
  })

  it('mounts a denied definition under configured overrides', () => {
    const definition = {
      pluginId: 'demo',
      name: 'reviewer',
      description: 'D.',
      instructions: 'I.',
      skillReferences: [],
      toolName: 'reviewer',
      deniedTools: ['write'],
    }

    expect(AgentPluginHost.delegationRowFor(definition, {
      bundleRoot: '/b',
      subagentProvider: 'acp',
      backgroundMode: 'one-shot',
    })).toEqual({
      provider: 'acp',
      toolName: 'reviewer',
      backgroundMode: 'one-shot',
      persona: 'I.',
      toolFilter: { deny: ['write'] },
    })
  })

  it('reports a skill whose frontmatter is not valid YAML', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'skills', 'gamma', 'SKILL.md'), '---\nname: [unclosed\ndescription: Gamma.\n---\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('has no YAML frontmatter block'))
  })

  it('reports the whole filename when it holds no stem', async () => {
    const { root, plugin } = await freshPlugin()
    await put(
      join(plugin, 'agents', '.toml'),
      'name = "x"\ndescription = "D."\ndeveloper_instructions = "I."\n',
    )

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.problems).toContainEqual(expect.stringContaining('must equal its file stem'))
  })
})

describe('agent-plugin-host root agent definitions', () => {
  /** One definition body with the keys every definition requires. */
  function definitionBody(name: string): string {
    return `name = "${name}"\ndescription = "D."\ndeveloper_instructions = "I."\n`
  }

  it('reads a bundle-level definition shared across the bundle', async () => {
    const { root } = await freshPlugin()
    await put(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'fixture-skills' }))
    await put(join(root, 'agents', 'planner.toml'), definitionBody('planner'))

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.agents).toHaveLength(1)
    expect(discovery.agents[0]?.pluginId).toBe('fixture-skills')
    expect(discovery.agents[0]?.toolName).toBe('planner')
  })

  it('mounts a row for a bundle-level definition', async () => {
    const { root } = await freshPlugin()
    await put(join(root, 'agents', 'planner.toml'), definitionBody('planner'))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    expect(await ctx.agentPlugins.listAgentDefinitions()).toHaveLength(1)
    await fiber.dispose()
  })

  it('reads a bundle-level definition under a non-directory root', async () => {
    const { root } = await freshPlugin()
    await put(join(root, 'agents', 'planner.toml'), definitionBody('planner'))
    await put(join(root, 'agents', 'loose.md'), '# not an agent\n')

    const discovery = await AgentPluginHost.discoverBundle(root)

    expect(discovery.agents.map(entry => entry.name)).toEqual(['planner'])
  })

  it('reports a bundle-level definition that cannot be read', async () => {
    const { root } = await freshPlugin()
    const file = join(root, 'agents', 'planner.toml')
    await put(file, definitionBody('planner'))
    await chmod(file, 0o000)
    try {
      const discovery = await AgentPluginHost.discoverBundle(root)

      expect(discovery.problems).toContainEqual(expect.stringContaining('cannot be read'))
    } finally {
      await chmod(file, 0o600)
    }
  })

  it('skips a shared tool name a plugin row already claimed', async () => {
    const { root, plugin } = await freshPlugin()
    await put(join(plugin, 'agents', 'planner.toml'), definitionBody('planner'))
    await put(join(root, 'agents', 'planner.toml'), definitionBody('planner'))
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(AgentPluginHost, { bundleRoot: root, providerName: 'demo' })

    expect(await ctx.agentPlugins.listAgentDefinitions()).toHaveLength(2)
    await fiber.dispose()
  })
})
