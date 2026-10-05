import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contributesAgentDefinition,
  disableNestedDelegation,
  dumpPatchList,
  enableNestedDelegation,
  installRowFor,
  installRowId,
  isInstallRow,
  parsePatchList,
  readMarketplace,
  resolveMarketplaceSource,
  runAgentPluginCommand,
  withInstallRow,
} from '../src/agent-plugins.ts'

const homes: string[] = []
let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-agent-plugins-'))
  homes.push(home)
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Write one file, creating its directory. */
async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

/** Write a marketplace root holding one plugin with one agent definition. */
async function marketplaceFixture(withAgent = true): Promise<string> {
  const root = join(home, 'skills')
  await put(join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'fixture-skills',
    plugins: [{ name: 'demo' }],
  }))
  const plugin = join(root, 'plugins', 'demo')
  await put(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    description: 'Fixture plugin.',
  }))
  await put(join(plugin, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha.\n---\n\n# Alpha\n')
  if (withAgent) {
    await put(join(plugin, 'agents', 'reviewer.toml'), 'name = "reviewer"\n')
    await put(join(plugin, 'agents', 'worker.md'), '---\nname: worker\n---\n')
  }
  return root
}

describe('dsh plugin marketplace', () => {
  it('reads the Codex marketplace manifest and its plugin ids', async () => {
    const root = await marketplaceFixture()

    expect(readMarketplace(root)).toEqual({ name: 'fixture-skills', plugins: ['demo'] })
  })

  it('reads the Claude marketplace when the Codex one is absent', async () => {
    const root = await marketplaceFixture()
    await rm(join(root, '.agents', 'plugins', 'marketplace.json'), { force: true })
    await put(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'claude-fixture',
      plugins: [{ name: 'demo' }],
    }))

    expect(readMarketplace(root).name).toBe('claude-fixture')
  })

  it('refuses a directory that is not a marketplace, naming both paths', async () => {
    const root = join(home, 'not-a-marketplace')
    await mkdir(root, { recursive: true })

    expect(() => readMarketplace(root)).toThrow(/marketplace\.json/)
  })

  it('references a local path where it already lives', async () => {
    const root = await marketplaceFixture()

    expect(resolveMarketplaceSource(root, home)).toEqual({
      name: 'fixture-skills',
      path: root,
      origin: root,
      kind: 'local',
    })
  })

  it('refuses a specification that is neither a path nor an owner/repo', () => {
    expect(() => resolveMarketplaceSource('nope', home)).toThrow(/neither an existing path nor an owner\/repo/)
  })
})

describe('dsh plugin install rows', () => {
  it('derives the row id from the plugin id', () => {
    expect(installRowId('demo')).toBe('agent-plugin-demo')
  })

  it('recognizes only a row naming the host plugin with a derived id', () => {
    expect(isInstallRow(installRowFor('demo', '/bundle/demo'))).toBe(true)
    expect(isInstallRow({ id: 'agent-plugin-demo', name: 'something-else' })).toBe(false)
    expect(isInstallRow({ id: 'other', name: '@deepseek-ai/dsh-agent-plugin-host' })).toBe(false)
    expect(isInstallRow(undefined)).toBe(false)
  })

  it('inserts into an existing insert list', () => {
    const rows = [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }]
    const next = withInstallRow(rows, installRowFor('demo', '/bundle/demo'), true)

    expect(next).toEqual([
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { insert: [installRowFor('demo', '/bundle/demo')] },
    ])
  })

  it('appends to the existing insert list rather than nesting another', () => {
    const rows = [{ insert: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }] }]
    const next = withInstallRow(rows, installRowFor('demo', '/bundle/demo'), true)

    expect(next).toEqual([{
      insert: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona' },
        installRowFor('demo', '/bundle/demo'),
      ],
    }])
  })

  it('preserves a hand-written expression and every unrelated row', () => {
    const rows = parsePatchList([
      '# a comment',
      '- id: agent-presets',
      '  config:',
      '    default: !!js process.env.DSH_MODE',
      '',
    ].join('\n'))
    const next = withInstallRow(rows, installRowFor('demo', '/bundle/demo'), true)

    expect(dumpPatchList(next)).toContain('!!js process.env.DSH_MODE')
    expect(dumpPatchList(next)).toContain('agent-presets')
    expect(dumpPatchList(next)).toContain('agent-plugin-demo')
  })

  it('replaces a row for the same plugin and keeps another plugin row', () => {
    const first = withInstallRow([], installRowFor('demo', '/bundle/demo'), true)
    const both = withInstallRow(first, installRowFor('other', '/bundle/other'), true)
    const moved = withInstallRow(both, installRowFor('demo', '/moved/demo'), true)

    const rows = (moved[0] as { insert: { config: { bundleRoot: string } }[] }).insert
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.config.bundleRoot)).toEqual(['/moved/demo', '/bundle/other'])
  })

  it('removes only the named row and drops an emptied insert list', () => {
    const rows = withInstallRow([], installRowFor('demo', '/bundle/demo'), true)

    expect(withInstallRow(rows, installRowFor('demo', '/bundle/demo'), false)).toEqual([])
  })

  it('refuses a patch file that is not a list', () => {
    expect(() => parsePatchList('id: not-a-list\n')).toThrow(/top-level YAML list/)
  })
})

describe('dsh plugin agent definitions', () => {
  it('counts a TOML definition and never a markdown worker protocol', async () => {
    const root = await marketplaceFixture()
    const plugin = join(root, 'plugins', 'demo')

    expect(contributesAgentDefinition(plugin)).toBe(true)
    expect(contributesAgentDefinition(join(plugin, 'skills', 'alpha'))).toBe(false)
  })

  it('reports no definition for a plugin without an agents directory', async () => {
    const root = await marketplaceFixture(false)

    expect(contributesAgentDefinition(join(root, 'plugins', 'demo'))).toBe(false)
  })
})

describe('dsh plugin nested delegation', () => {
  it('turns the setting off only while it is absent', () => {
    expect(enableNestedDelegation(home)).toBe('written')
    expect(enableNestedDelegation(home)).toBe('present')
  })

  it('leaves every other settings section and comment alone', async () => {
    await put(join(home, 'settings.yaml'), '# mine\nmodel: deepseek-v4-pro\n')
    expect(enableNestedDelegation(home)).toBe('written')

    const content = await readFile(join(home, 'settings.yaml'), 'utf8')
    expect(content).toContain('# mine')
    expect(content).toContain('model: deepseek-v4-pro')
    expect(content).toContain('singleLevel: false')
  })

  it('reports a deliberate one-level choice instead of overriding it', async () => {
    await put(join(home, 'settings.yaml'), 'configurable-subagents:\n  singleLevel: true\n')

    expect(enableNestedDelegation(home)).toBe('conflict')
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('singleLevel: true')
  })

  it('removes the key only while it still holds what the install wrote', async () => {
    expect(enableNestedDelegation(home)).toBe('written')
    expect(disableNestedDelegation(home)).toBe(true)
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).not.toContain('singleLevel')
  })

  it('keeps a value the person changed after the install', async () => {
    expect(enableNestedDelegation(home)).toBe('written')
    await put(join(home, 'settings.yaml'), 'configurable-subagents:\n  singleLevel: true\n')

    expect(disableNestedDelegation(home)).toBe(false)
  })
})

describe('dsh plugin command dispatch', () => {
  it('leaves every pnpm argument to the forwarder', () => {
    // Only the `<plugin>@<marketplace>` form whose marketplace was actually
    // added is claimed; everything else must stay pnpm's.
    expect(runAgentPluginCommand('web', ['add', 'lodash'])).toBeUndefined()
    expect(runAgentPluginCommand('web', ['install'])).toBeUndefined()
    expect(runAgentPluginCommand('web', ['install', 'lodash'])).toBeUndefined()
    expect(runAgentPluginCommand('web', ['install', 'demo@unadded'])).toBeUndefined()
    expect(runAgentPluginCommand('web', ['remove', 'lodash'])).toBeUndefined()
    expect(runAgentPluginCommand('web', ['list'])).toBeUndefined()
  })

  it('installs and uninstalls one plugin through the profile patch', async () => {
    const root = await marketplaceFixture()
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })

    expect(runAgentPluginCommand('web', ['marketplace', 'add', root])).toBe(0)
    expect(runAgentPluginCommand('web', ['install', 'demo@fixture-skills'])).toBe(0)

    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const installed = parsePatchList(await readFile(patch, 'utf8'))
    expect(installed).toEqual([{
      insert: [{
        id: 'agent-plugin-demo',
        name: '@deepseek-ai/dsh-agent-plugin-host',
        config: { bundleRoot: join(root, 'plugins', 'demo'), providerName: 'demo' },
      }],
    }])
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('singleLevel: false')

    expect(runAgentPluginCommand('web', ['uninstall', 'demo@fixture-skills'])).toBe(0)

    expect(parsePatchList(await readFile(patch, 'utf8'))).toEqual([])
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).not.toContain('singleLevel')
  })

  it('names the marketplace it could not find', async () => {
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    expect(() => runAgentPluginCommand('web', ['marketplace', 'remove', 'absent']))
      .toThrow(/no marketplace named "absent"/)
  })

  it('refuses to remove a marketplace that still has an install', async () => {
    const root = await marketplaceFixture()
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    runAgentPluginCommand('web', ['marketplace', 'add', root])
    runAgentPluginCommand('web', ['install', 'demo@fixture-skills'])

    expect(() => runAgentPluginCommand('web', ['marketplace', 'remove', 'fixture-skills']))
      .toThrow(/still has demo installed/)
  })
})
