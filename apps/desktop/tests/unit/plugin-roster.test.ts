/**
 * Plugin roster: what a shipped build discovers and what it must never carry.
 *
 * The exclusion set is a security invariant, so its cases are pinned by name and
 * by shape: a directory that IS present is reported rather than skipped, and a
 * directory that is absent changes nothing. Discovery itself stays name-agnostic, so
 * a plugin added to either tree ships without a code change here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_EXCLUSIONS,
  describeExclusions,
  discoverPlugins,
  discoverSkills,
  partitionPlugins,
} from '../../../../scripts/plugin-roster.mjs'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** Create a harness-checkout-shaped scratch tree. */
function makeCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-roster-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  return dir
}

/** Write one plugin directory; a manifest without a bundle patch is not a plugin. */
function addPlugin(root: string, name: string, options: { manifest?: boolean; patch?: boolean; packageName?: string } = {}): void {
  const dir = join(root, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  if (options.manifest !== false) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: options.packageName ?? `dsh-${name}` }))
  }
  if (options.patch !== false) writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
}

/** Write one skill directory with the frontmatter the provider requires. */
function addSkill(root: string, category: string, name: string, frontmatter: string | undefined): void {
  const dir = join(root, 'skills', category, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), frontmatter === undefined ? '# no frontmatter\n' : `---\n${frontmatter}\n---\n\n# ${name}\n`)
}

describe('plugin discovery', () => {
  it('discovers every plugin the checkout carries, whatever it is called', () => {
    const root = makeCheckout()
    addPlugin(root, 'alpha')
    addPlugin(root, 'brand-new-plugin')
    expect(discoverPlugins(root).map((plugin) => plugin.name)).toEqual(['alpha', 'brand-new-plugin'])
  })

  it('requires both a manifest and a bundle patch layer', () => {
    const root = makeCheckout()
    addPlugin(root, 'complete')
    addPlugin(root, 'no-patch', { patch: false })
    addPlugin(root, 'no-manifest', { manifest: false })
    addPlugin(root, 'no-name', { packageName: '' })
    expect(discoverPlugins(root).map((plugin) => plugin.name)).toEqual(['complete'])
  })

  it('carries the manifest name, which is the bundle a profile lists', () => {
    const root = makeCheckout()
    addPlugin(root, 'directory-name', { packageName: 'dsh-manifest-name' })
    const [plugin] = discoverPlugins(root)
    expect(plugin?.packageName).toBe('dsh-manifest-name')
    expect(plugin?.patchPath).toBe(join(root, 'plugins', 'directory-name', 'cordis.patch.yml'))
  })

  it('ignores a directory that is not one, and reads only the named plugin trees', () => {
    const root = makeCheckout()
    writeFileSync(join(root, 'plugins', 'stray-file'), 'not a directory')
    addPlugin(root, 'kept')
    mkdirSync(join(root, 'elsewhere', 'ignored'), { recursive: true })
    writeFileSync(join(root, 'elsewhere', 'ignored', 'package.json'), JSON.stringify({ name: 'dsh-ignored' }))
    writeFileSync(join(root, 'elsewhere', 'ignored', 'cordis.patch.yml'), '- insert: []\n')
    expect(discoverPlugins(root).map((plugin) => plugin.name)).toEqual(['kept'])
  })

  it('names every excluded directory in the roster', () => {
    expect([...PLUGIN_EXCLUSIONS.keys()].sort()).toEqual(['_security-review', 'crescendo-attacker', 'web-search-searxng'])
  })
})

describe('plugin exclusion', () => {
  it('refuses each excluded directory that IS present, and reports it', () => {
    const root = makeCheckout()
    addPlugin(root, 'crescendo-attacker', { packageName: 'dsh-crescendo-attacker' })
    addPlugin(root, '_security-review', { packageName: 'dsh-security-review' })
    addPlugin(root, 'web-search-searxng', { packageName: 'dsh-web-search-searxng' })
    addPlugin(root, 'real-plugin')

    const { shipped, excluded } = partitionPlugins(discoverPlugins(root))
    expect(shipped.map((plugin) => plugin.name)).toEqual(['real-plugin'])
    expect(excluded.map((plugin) => plugin.name)).toEqual(['_security-review', 'crescendo-attacker', 'web-search-searxng'])
    const report = describeExclusions(excluded)
    expect(report).toContain('crescendo-attacker')
    expect(report).toContain('_security-review')
    expect(report).toContain('web-search-searxng')
  })

  it('changes nothing when every excluded directory is absent', () => {
    const root = makeCheckout()
    addPlugin(root, 'real-plugin')
    const { shipped, excluded } = partitionPlugins(discoverPlugins(root))
    expect(shipped.map((plugin) => plugin.name)).toEqual(['real-plugin'])
    expect(excluded).toEqual([])
    expect(describeExclusions(excluded)).toBe('')
  })

  it('excludes by directory name even when the manifest claims another', () => {
    const root = makeCheckout()
    addPlugin(root, 'crescendo-attacker', { packageName: 'dsh-innocent-name' })
    const { shipped, excluded } = partitionPlugins(discoverPlugins(root))
    expect(shipped).toEqual([])
    expect(excluded.map((plugin) => plugin.name)).toEqual(['crescendo-attacker'])
  })
})

describe('skill discovery', () => {
  it('takes a directory bundle and a flat file that both declare a name and description', () => {
    const root = makeCheckout()
    addSkill(root, 'generic-skills', 'bundle', 'name: bundle-skill\ndescription: does a thing')
    mkdirSync(join(root, 'skills', 'third-party-skills'), { recursive: true })
    writeFileSync(join(root, 'skills', 'third-party-skills', 'flat.md'), '---\nname: flat-skill\ndescription: another thing\n---\n')
    expect(discoverSkills(root).map((skill) => skill.name)).toEqual(['bundle-skill', 'flat-skill'])
  })

  it('skips a candidate without a usable name and description', () => {
    const root = makeCheckout()
    addSkill(root, 'generic-skills', 'no-frontmatter', undefined)
    addSkill(root, 'generic-skills', 'no-name', 'description: only a description')
    addSkill(root, 'generic-skills', 'empty-name', 'name: \'description: has a name\'')
    addSkill(root, 'generic-skills', 'no-description', 'name: lonely')
    addSkill(root, 'generic-skills', 'usable', 'name: usable\ndescription: fine')
    expect(discoverSkills(root).map((skill) => skill.name)).toEqual(['usable'])
  })

  it('names the skill directory the home skill root receives', () => {
    const root = makeCheckout()
    addSkill(root, 'generic-skills', 'directory-name', 'name: declared-name\ndescription: fine')
    const [skill] = discoverSkills(root)
    expect(skill?.name).toBe('declared-name')
    expect(skill?.dir).toBe(join(root, 'skills', 'generic-skills', 'directory-name'))
    expect(skill?.file).toBe(join(root, 'skills', 'generic-skills', 'directory-name', 'SKILL.md'))
  })

  it('ignores a markdown file directly under the skills root', () => {
    const root = makeCheckout()
    writeFileSync(join(root, 'skills', 'README.md'), '---\nname: readme\ndescription: not a skill\n---\n')
    expect(discoverSkills(root)).toEqual([])
  })
})
