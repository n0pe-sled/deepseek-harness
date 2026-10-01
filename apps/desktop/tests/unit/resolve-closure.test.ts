/**
 * The closure resolver decides whether a staged harness can boot, so its rules
 * are pinned here: each case is a real failure this staging hit while being
 * built, and each one silently shipped a harness that died at boot.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { entryExists, findUnresolvedDependencies, resolveFrom } from '../../scripts/lib/resolve-closure.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** Write one package into a closure's node_modules. */
function addPackage(root: string, name: string, manifest: unknown, files: Record<string, string> = {}): string {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
  return dir
}

function closure(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-closure-'))
  dirs.push(root)
  return root
}

describe('entryExists', () => {
  it('accepts a bare relative main (json-schema-to-ts style)', () => {
    const root = closure()
    const dir = addPackage(root, 'pkg', { name: 'pkg', main: 'lib/cjs/index.js' }, { 'lib/cjs/index.js': '' })
    expect(entryExists(dir)).toBe(true)
  })

  it('accepts an extensionless main resolved by CommonJS rules', () => {
    const root = closure()
    const dir = addPackage(root, 'pkg', { name: 'pkg', main: './index' }, { 'index.js': '' })
    expect(entryExists(dir)).toBe(true)
  })

  it('accepts an extensionless directory main that holds index.js', () => {
    const root = closure()
    const dir = addPackage(root, 'pkg', { name: 'pkg', main: 'index' }, { 'index/index.js': '' })
    expect(entryExists(dir)).toBe(true)
  })

  it('ignores a missing types target when the runtime target exists', () => {
    const root = closure()
    const dir = addPackage(root, 'pkg', {
      name: 'pkg',
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
    }, { 'lib/index.js': '' })
    expect(entryExists(dir)).toBe(true)
  })

  it('reports a package whose runtime target is genuinely absent', () => {
    const root = closure()
    const dir = addPackage(root, 'pkg', { name: 'pkg', main: './lib/index.js' })
    expect(entryExists(dir)).toBe(false)
  })
})

describe('resolveFrom', () => {
  it('walks up from the importer to the closure root', () => {
    const root = closure()
    const consumer = addPackage(root, '@scope/consumer', { name: '@scope/consumer' })
    addPackage(root, 'dep', { name: 'dep', main: './index.js' }, { 'index.js': '' })
    expect(resolveFrom(consumer, 'dep')).toBe(join(root, 'node_modules', 'dep'))
  })
})

describe('findUnresolvedDependencies', () => {
  it('reports a dependency that only exists where the importer cannot reach it', () => {
    const root = closure()
    // A package nested inside another's tree cannot see a sibling that lives
    // only at the closure root: this is the cordis-plugin-group failure.
    const nested = addPackage(root, 'outer', { name: 'outer', dependencies: { invisible: '^1.0.0' } })
    void nested
    addPackage(join(root, 'node_modules', 'outer'), 'invisible', { name: 'invisible', main: './index.js' })
    // Put the dependency somewhere Node will not look from `outer`.
    const elsewhere = closure()
    addPackage(elsewhere, 'invisible', { name: 'invisible', main: './index.js' })
    expect(findUnresolvedDependencies(root).map((e) => e.name)).toContain('invisible')
  })

  it('is satisfied when any copy of the declaring package can resolve the dependency', () => {
    const root = closure()
    // Two copies of the consumer: one cannot resolve `dep`, one can. Reporting
    // a miss here made the staging completion loop copy `cordis` into itself
    // until the filesystem refused the path.
    const nested = addPackage(join(root, 'node_modules', 'outer'), 'consumer', {
      name: 'consumer',
      dependencies: { dep: '^1.0.0' },
    })
    void nested
    addPackage(root, 'consumer', { name: 'consumer', dependencies: { dep: '^1.0.0' } })
    addPackage(root, 'dep', { name: 'dep', main: './index.js' }, { 'index.js': '' })
    expect(findUnresolvedDependencies(root)).toHaveLength(0)
  })

  it('treats a peer that is not installed anywhere as optional', () => {
    const root = closure()
    addPackage(root, 'ws', { name: 'ws', peerDependencies: { bufferutil: '^1.0.0' } })
    expect(findUnresolvedDependencies(root)).toHaveLength(0)
  })

  it('reports a peer that is installed but unusable', () => {
    const root = closure()
    addPackage(root, 'app-boot', { name: 'app-boot', peerDependencies: { 'cordis-plugin-group': 'workspace:^' } })
    addPackage(root, 'cordis-plugin-group', { name: 'cordis-plugin-group', main: './lib/index.js' })
    expect(findUnresolvedDependencies(root).map((e) => e.name)).toContain('cordis-plugin-group')
  })

  it('never reports a missing real dependency as optional', () => {
    const root = closure()
    addPackage(root, 'pkg', { name: 'pkg', dependencies: { missing: '^1.0.0' } })
    expect(findUnresolvedDependencies(root).map((e) => e.name)).toEqual(['missing'])
  })

  it('ignores node builtins, including the node: spelling', () => {
    const root = closure()
    addPackage(root, 'pkg', { name: 'pkg', dependencies: { 'node:fs': '*', path: '*', worker_threads: '*' } })
    expect(findUnresolvedDependencies(root)).toHaveLength(0)
  })

  it('ignores a missing @types package, which has no runtime entry by design', () => {
    const root = closure()
    addPackage(root, 'pkg', { name: 'pkg', dependencies: { '@types/node': '^22.0.0' } })
    expect(findUnresolvedDependencies(root)).toHaveLength(0)
  })

  it('accepts declaration-only dependencies with an empty main field', () => {
    const root = closure()
    addPackage(root, 'pkg', { name: 'pkg', dependencies: { csstype: '^3.2.3' } })
    addPackage(root, 'csstype', { name: 'csstype', main: '', types: 'index.d.ts' }, { 'index.d.ts': '' })
    expect(findUnresolvedDependencies(root)).toEqual([])
  })

  it('ignores an installed .d.ts-only package such as undici-types', () => {
    const root = closure()
    addPackage(root, 'pkg', { name: 'pkg', dependencies: { 'undici-types': '^7.0.0' } })
    // undici-types ships no runtime entry, only declarations.
    addPackage(root, 'undici-types', { name: 'undici-types' }, { 'index.d.ts': '' })
    expect(findUnresolvedDependencies(root)).toHaveLength(0)
  })
})
