/**
 * Closure discovery and selection.
 *
 * Selection is where a wrong answer ships the wrong bytes: the fork and upstream
 * publish under one package name and the same version string, so the version
 * alone proves nothing and the revision plus target is what identifies a
 * closure. A miss must refuse, never fall back to something installable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClosureNotFoundError,
  findClosures,
  metaTarget,
  readHarnessMeta,
  selectClosure,
} from '../../src/main/instances/closure-catalog.ts'
import { parseTarget } from '../../src/shared/harness-target.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

/** Create one staged-closure-shaped directory. */
function addClosure(
  resources: string,
  name: string,
  meta: Record<string, unknown> | undefined,
  options: { cli?: boolean } = {},
): string {
  const root = join(resources, name)
  mkdirSync(join(root, 'lib'), { recursive: true })
  if (options.cli !== false) writeFileSync(join(root, 'lib', 'bin.js'), '// cli')
  if (meta !== undefined) writeFileSync(join(root, 'harness-meta.json'), JSON.stringify(meta))
  return root
}

function makeResources(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-closures-'))
  dirs.push(dir)
  return dir
}

const LINUX = parseTarget('linux-x64-glibc')

describe('readHarnessMeta', () => {
  it('reads a record', () => {
    const resources = makeResources()
    const root = addClosure(resources, 'harness', { version: '1.0.0', revision: 'abc' })
    expect(readHarnessMeta(root)?.revision).toBe('abc')
  })

  it('is undefined for a malformed record rather than throwing', () => {
    const resources = makeResources()
    const root = addClosure(resources, 'harness', undefined)
    writeFileSync(join(root, 'harness-meta.json'), '{ not json')
    expect(readHarnessMeta(root)).toBeUndefined()
  })
})

describe('metaTarget', () => {
  it('builds a target from the recorded platform and arch', () => {
    expect(metaTarget({ platform: 'linux', arch: 'x64' })).toEqual({ platform: 'linux', arch: 'x64', libc: 'glibc' })
    expect(metaTarget({ platform: 'darwin', arch: 'arm64' })).toEqual({ platform: 'darwin', arch: 'arm64' })
  })

  it('honours a recorded musl libc', () => {
    expect(metaTarget({ platform: 'linux', arch: 'arm64', libc: 'musl' }))
      .toEqual({ platform: 'linux', arch: 'arm64', libc: 'musl' })
  })

  it('is undefined when the record does not name a target', () => {
    // Older records predate the target fields; they must not be selectable.
    expect(metaTarget({ version: '1.0.0', revision: 'abc' })).toBeUndefined()
    expect(metaTarget({ platform: 'plan9', arch: 'x64' })).toBeUndefined()
  })
})

describe('findClosures', () => {
  it('finds only directories that are actually closures', () => {
    const resources = makeResources()
    addClosure(resources, 'harness', { version: '0.1.1-rc.2', revision: 'aaa', platform: 'darwin', arch: 'arm64' })
    addClosure(resources, 'harness-linux-x64', { version: '0.1.1-rc.2', revision: 'bbb', platform: 'linux', arch: 'x64', libc: 'glibc' })
    // Not closures: no CLI entry, no record, or unrelated to harness.
    addClosure(resources, 'harness-broken', { version: '1', revision: 'c', platform: 'linux', arch: 'x64' }, { cli: false })
    addClosure(resources, 'harness-unrecorded', undefined)
    addClosure(resources, 'harness-stale', { version: '1', revision: 'd' })
    mkdirSync(join(resources, 'other'), { recursive: true })

    const found = findClosures(resources).map((entry) => entry.key).sort()
    expect(found).toEqual([
      '0.1.1-rc.2-aaa-darwin-arm64',
      '0.1.1-rc.2-bbb-linux-x64-glibc',
    ])
  })

  it('is empty for a missing directory', () => {
    expect(findClosures('/definitely/not/here')).toEqual([])
  })
})

describe('selectClosure', () => {
  const darwinEntry = {
    key: '0.1.1-rc.2-aaa-darwin-arm64',
    root: '/r/harness',
    cli: '/r/harness/lib/bin.js',
    meta: { version: '0.1.1-rc.2', revision: 'aaa', platform: 'darwin', arch: 'arm64' },
    target: parseTarget('darwin-arm64'),
  }
  const linuxEntry = {
    key: '0.1.1-rc.2-aaa-linux-x64-glibc',
    root: '/r/harness-linux-x64',
    cli: '/r/harness-linux-x64/lib/bin.js',
    meta: { version: '0.1.1-rc.2', revision: 'aaa', platform: 'linux', arch: 'x64', libc: 'glibc' },
    target: LINUX,
  }

  it('prefers the exact cache key', () => {
    expect(selectClosure([darwinEntry, linuxEntry], { key: linuxEntry.key, target: LINUX }).root)
      .toBe('/r/harness-linux-x64')
  })

  it('falls back to another revision for the same target', () => {
    // A revision difference is a cache miss on the remote, not an
    // incompatibility: the developer restaged and has not restaged everything.
    const older = { ...linuxEntry, key: '0.1.1-rc.2-zzz-linux-x64-glibc', meta: { ...linuxEntry.meta, revision: 'zzz' } }
    expect(selectClosure([darwinEntry, older], { key: linuxEntry.key, target: LINUX }).meta.revision).toBe('zzz')
  })

  it('picks the newest staging when several revisions share a target', () => {
    const older = { ...linuxEntry, key: 'k-old', meta: { ...linuxEntry.meta, revision: 'old', stagedAt: '2026-01-01T00:00:00Z' } }
    const newer = { ...linuxEntry, key: 'k-new', meta: { ...linuxEntry.meta, revision: 'new', stagedAt: '2026-09-25T00:00:00Z' } }
    expect(selectClosure([older, newer], { key: 'missing', target: LINUX }).meta.revision).toBe('new')
  })

  it('refuses, naming what exists, rather than choosing a wrong-platform closure', () => {
    // The worst outcome is silently shipping a darwin closure to a linux host:
    // it would boot far enough to look plausible and fail at native load.
    let caught: unknown
    try {
      selectClosure([darwinEntry], { key: 'missing', target: LINUX })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClosureNotFoundError)
    expect((caught as ClosureNotFoundError).available).toEqual(['0.1.1-rc.2-aaa-darwin-arm64'])
    expect((caught as Error).message).toContain('linux-x64-glibc')
    expect((caught as Error).message).toContain('--target linux-x64-glibc')
  })

  it('never reaches a registry: the refusal points at the staging script', () => {
    try {
      selectClosure([], { key: 'missing', target: LINUX })
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as Error).message).toContain('stage-harness.mjs')
      expect((error as Error).message).not.toContain('npm install')
    }
  })
})
