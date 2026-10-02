/**
 * Home seeding: which files a shipped closure may write into a person's home.
 *
 * Every case here is a decision about somebody else's data, so each rule is
 * pinned by its refusal as well as its write: a bundle list a person edited is
 * never rewritten, and a skill entry a person wrote is never replaced. The
 * manifest is read from the closure's own version record, which is what lets the
 * app seed without knowing a plugin name itself.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STOCK_BUNDLES,
  closureBundles,
  linkShippedBundles,
  readHarnessMeta,
  seedHome,
  seedProfileManifest,
  seedSkills,
  shippedBundles,
  skillEntryReplaceable,
} from '../../scripts/seed-home.mjs'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** One closure root holding the version record, a skills payload, and its plugins. */
function makeClosure(options: { plugins?: string[]; skills?: string[] } = {}): string {
  const root = scratch('dsh-closure-')
  writeFileSync(join(root, 'harness-meta.json'), JSON.stringify({
    version: '0.1.1',
    revision: 'abc123',
    plugins: options.plugins ?? [],
    skills: options.skills ?? [],
  }))
  for (const name of options.plugins ?? []) {
    // The staged placement: each plugin the Loader imports by bare name, with the
    // closure's own `node_modules` around it so its peers resolve.
    const dir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
  }
  for (const name of options.skills ?? []) {
    mkdirSync(join(root, 'skills', name), { recursive: true })
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `# ${name}\n`)
  }
  return root
}

/** The bundle list a home's web profile currently carries. */
function bundlesOf(home: string): unknown {
  const path = join(home, 'profiles', 'web', 'package.json')
  return (JSON.parse(readFileSync(path, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles
}

/** The dependency section a home's web profile currently carries. */
function dependenciesOf(home: string): unknown {
  const path = join(home, 'profiles', 'web', 'package.json')
  return (JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: unknown }).dependencies
}

describe('shipped bundle list', () => {
  it('lists the stock bundles and then the shipped plugins, in closure order', () => {
    expect(shippedBundles({ plugins: ['dsh-b', 'dsh-a'] })).toEqual([...STOCK_BUNDLES, 'dsh-b', 'dsh-a'])
  })

  it('lists only the stock bundles for a record with no roster', () => {
    expect(shippedBundles(undefined)).toEqual([...STOCK_BUNDLES])
    expect(shippedBundles({ plugins: 'not-a-list' })).toEqual([...STOCK_BUNDLES])
    expect(shippedBundles({ plugins: [1, 'dsh-a'] })).toEqual([...STOCK_BUNDLES, 'dsh-a'])
  })
})

describe('profile manifest seeding', () => {
  it('writes the shipped list when no manifest exists', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    expect(seedProfileManifest(home, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-a'], closure)).toBe(true)
    expect(bundlesOf(home)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-a'])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.private).toBe(true)
    // The stock pair resolves through the install anchor; a shipped plugin only
    // through the profile's own link into the closure.
    expect(manifest.dependencies).toEqual({
      'dsh-a': `link:${join(closure, 'node_modules', 'dsh-a')}`,
    })
  })

  it('replaces exactly the stock bundle list and changes nothing else', () => {
    const home = scratch('dsh-home-')
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    const before = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-kept': 'link:../../kept' },
      dsh: { profile: { bundles: [...STOCK_BUNDLES] }, other: { kept: true } },
      unrelated: ['kept'],
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(before))
    const closure = makeClosure({ plugins: ['dsh-a'] })
    expect(seedProfileManifest(home, [...STOCK_BUNDLES, 'dsh-a'], closure)).toBe(true)
    const after = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(after).toEqual({
      ...before,
      dependencies: {
        'dsh-kept': 'link:../../kept',
        'dsh-a': `link:${join(closure, 'node_modules', 'dsh-a')}`,
      },
      dsh: { profile: { bundles: [...STOCK_BUNDLES, 'dsh-a'] }, other: { kept: true } },
    })
  })

  it('leaves a bundle list a person edited untouched', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    const edited = {
      name: 'mine',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mine'] } },
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(edited)}\n`)
    expect(seedProfileManifest(home, [...STOCK_BUNDLES, 'dsh-a'], closure)).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toEqual(edited)
  })

  it('leaves a reordered stock list untouched', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: [...STOCK_BUNDLES].reverse() } },
    }))
    expect(seedProfileManifest(home, [...STOCK_BUNDLES, 'dsh-a'], closure)).toBe(false)
    expect(bundlesOf(home)).toEqual([...STOCK_BUNDLES].reverse())
  })

  it('leaves an unreadable manifest untouched', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(seedProfileManifest(home, [...STOCK_BUNDLES, 'dsh-a'], closure)).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{ not json')
  })
})

describe('closure bundle linking', () => {
  it('links every shipped plugin and leaves the stock pair to the install anchor', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a', 'dsh-b'] })
    const { linked, missing } = linkShippedBundles(home, [...STOCK_BUNDLES, 'dsh-a', 'dsh-b'], closure)
    expect(linked).toEqual(['dsh-a', 'dsh-b'])
    expect(missing).toEqual([])
    expect(closureBundles([...STOCK_BUNDLES, 'dsh-a', 'dsh-b'])).toEqual(['dsh-a', 'dsh-b'])
    // The link is what Node's own resolution follows from the profile
    // directory, which is where the Loader imports a bare entry name.
    // Node finds the profile's own link, and the link's realpath is the
    // closure package, which is what makes the plugin's peers resolve there.
    expect(resolveFromAnchor(join(home, 'profiles', 'web', 'package.json'), 'dsh-a'))
      .toBe(join(home, 'profiles', 'web', 'node_modules', 'dsh-a'))
    // Both sides through realpath: macOS resolves the temp root itself through
    // /private, and the link's target is what the plugin's peers resolve from.
    expect(realpathSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-a')))
      .toBe(realpathSync(join(closure, 'node_modules', 'dsh-a')))
    expect(resolveFromAnchor(join(home, 'profiles', 'web', 'package.json'), '@deepseek-ai/dsh-base'))
      .toBeUndefined()
  })

  it('reports a bundle the closure carries no package for, rather than linking it', () => {
    // A record naming a bundle nothing staged would otherwise produce a link to a
    // path that does not exist, which surfaces as a boot failure instead.
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    const { linked, missing } = linkShippedBundles(home, [...STOCK_BUNDLES, 'dsh-a', 'dsh-absent'], closure)
    expect(linked).toEqual(['dsh-a'])
    expect(missing).toEqual(['dsh-absent'])
    expect(existsSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-absent'))).toBe(false)
  })

  it('replaces a link left dangling by a seed of another closure', () => {
    // A home seeded from a development checkout keeps links into it, and the
    // packaged app that later seeds the same home has to repoint them.
    const home = scratch('dsh-home-')
    const stale = scratch('dsh-stale-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    mkdirSync(join(stale, 'node_modules', 'dsh-a', 'lib'), { recursive: true })
    const dest = join(home, 'profiles', 'web', 'node_modules', 'dsh-a')
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(join(stale, 'node_modules', 'dsh-a'), dest)
    rmSync(stale, { recursive: true, force: true })
    expect(skillEntryReplaceable(dest)).toBe(true)
    expect(linkShippedBundles(home, [...STOCK_BUNDLES, 'dsh-a'], closure).linked).toEqual(['dsh-a'])
    expect(realpathSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-a')))
      .toBe(realpathSync(join(closure, 'node_modules', 'dsh-a')))
    expect(skillEntryReplaceable(dest)).toBe(false)
  })

  it('keeps a real directory a person put there', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'] })
    const dest = join(home, 'profiles', 'web', 'node_modules', 'dsh-a')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'dsh-a', mine: true }))
    expect(linkShippedBundles(home, [...STOCK_BUNDLES, 'dsh-a'], closure)).toEqual({
      linked: [],
      missing: [],
    })
    expect(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))).toEqual({
      name: 'dsh-a',
      mine: true,
    })
  })
})

describe('skill seeding', () => {
  it('places a shipped skill and never replaces a real entry', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ skills: ['shipped', 'mine'] })
    mkdirSync(join(home, 'skills', 'mine'), { recursive: true })
    writeFileSync(join(home, 'skills', 'mine', 'SKILL.md'), '# the person wrote this\n')
    expect(seedSkills(home, closure, ['shipped', 'mine'])).toEqual(['shipped'])
    expect(readFileSync(join(home, 'skills', 'shipped', 'SKILL.md'), 'utf8')).toBe('# shipped\n')
  })

  it('replaces a symlink left dangling by an earlier seed', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ skills: ['shipped'] })
    mkdirSync(join(home, 'skills'), { recursive: true })
    symlinkSync(join(home, 'gone'), join(home, 'skills', 'shipped'))
    expect(skillEntryReplaceable(join(home, 'skills', 'shipped'))).toBe(true)
    expect(seedSkills(home, closure, ['shipped'])).toEqual(['shipped'])
    expect(readFileSync(join(home, 'skills', 'shipped', 'SKILL.md'), 'utf8')).toBe('# shipped\n')
  })

  it('keeps a live symlink, which is a dev checkout manager own link', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ skills: ['shipped'] })
    const checkout = scratch('dsh-checkout-')
    mkdirSync(join(home, 'skills'), { recursive: true })
    symlinkSync(checkout, join(home, 'skills', 'shipped'))
    expect(skillEntryReplaceable(join(home, 'skills', 'shipped'))).toBe(false)
    expect(seedSkills(home, closure, ['shipped'])).toEqual([])
  })

  it('places the entries a closure carries and skips the rest', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ skills: ['shipped'] })
    expect(seedSkills(home, closure, ['shipped', 'absent'])).toEqual(['shipped'])
    expect(existsSync(join(home, 'skills', 'absent'))).toBe(false)
  })

  it('writes no other file into the home', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a'], skills: ['shipped'] })
    seedHome(home, closure)
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(home, 'credentials'))).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    expect(readdirNames(home).sort()).toEqual(['profiles', 'skills'])
  })
})

describe('seedHome', () => {
  it('seeds the manifest and the skills from the closure record', () => {
    const home = scratch('dsh-home-')
    const closure = makeClosure({ plugins: ['dsh-a', 'dsh-b'], skills: ['shipped'] })
    const result = seedHome(home, closure)
    expect(result.manifestWritten).toBe(true)
    expect(result.linked).toEqual(['dsh-a', 'dsh-b'])
    expect(result.skills).toEqual(['shipped'])
    expect(bundlesOf(home)).toEqual([...STOCK_BUNDLES, 'dsh-a', 'dsh-b'])
    // Both halves name the same place, so a bundle the manifest lists is the one
    // the profile's link resolves.
    const declared = dependenciesOf(home) as Record<string, string>
    expect(Object.keys(declared)).toEqual(['dsh-a', 'dsh-b'])
    for (const name of ['dsh-a', 'dsh-b']) {
      expect(declared[name]).toBe(`link:${join(closure, 'node_modules', name)}`)
      expect(realpathSync(join(home, 'profiles', 'web', 'node_modules', name)))
        .toBe(realpathSync(join(closure, 'node_modules', name)))
    }
  })

  it('writes no manifest for a closure that ships no plugin', () => {
    const home = scratch('dsh-home-')
    const result = seedHome(home, makeClosure({ skills: ['shipped'] }))
    expect(result.manifestWritten).toBe(false)
    expect(result.linked).toEqual([])
    expect(seedHome(home, makeClosure({ skills: ['shipped'] })).manifestWritten).toBe(false)
  })

  it('reads the record the closure carries and answers nothing without one', () => {
    const closure = makeClosure({ plugins: ['dsh-a'] })
    expect((readHarnessMeta(closure) as { plugins?: string[] } | undefined)?.plugins).toEqual(['dsh-a'])
    expect(readHarnessMeta(scratch('dsh-bare-'))).toBeUndefined()
  })
})

describe('closure plugin placement', () => {
  it('keeps a seeded bundle resolvable from the install anchor', () => {
    const closure = scratch('dsh-closure-')
    // The staged layout: the CLI's package is the install anchor, and every
    // plugin sits at the closure root's `node_modules` beside the closure's own
    // packages, which is the only placement the anchor walk can find.
    writeFileSync(join(closure, 'harness-meta.json'), JSON.stringify({ plugins: ['dsh-a'], skills: [] }))
    const plugin = join(closure, 'node_modules', 'dsh-a', 'lib')
    mkdirSync(plugin, { recursive: true })
    expect(resolveFromAnchor(join(closure, 'harness-meta.json'), 'dsh-a')).toBe(join(plugin, '..'))
  })

  it('leaves a payload beside the closure unresolvable', () => {
    const closure = scratch('dsh-closure-')
    // The rejected placement: a payload the anchor walk never reaches, because
    // Node only probes `node_modules` directories above the anchor.
    mkdirSync(join(closure, 'plugins-src', 'dsh-a'), { recursive: true })
    expect(resolveFromAnchor(join(closure, 'harness-meta.json'), 'dsh-a')).toBeUndefined()
  })
})

/** One package's directory as Node resolves it from an anchor, or undefined. */
function resolveFromAnchor(anchor: string, name: string): string | undefined {
  let current = dirname(anchor)
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Directory entry names of one directory, which is absent in a fresh home. */
function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}
