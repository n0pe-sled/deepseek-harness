/**
 * Version ordering, which decides whether a release is offered at all.
 *
 * A tag the parser cannot read must never be treated as older: that would hide a
 * real release silently. These cases pin the parser's refusals as much as its
 * orderings, because the refusal is what the check acts on.
 */
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isNewerVersion,
  isUpdatePending,
  parseVersion,
  trimNotes,
  NOTES_LIMIT,
} from '../../src/shared/update.ts'

describe('parseVersion', () => {
  it('reads three numeric parts, with or without a tag prefix', () => {
    expect(parseVersion('0.1.4')).toEqual({ major: 0, minor: 1, patch: 4, prerelease: [] })
    expect(parseVersion('v0.1.4')).toEqual({ major: 0, minor: 1, patch: 4, prerelease: [] })
    expect(parseVersion(' v12.30.7 ')).toEqual({ major: 12, minor: 30, patch: 7, prerelease: [] })
  })

  it('keeps the prerelease identifiers and drops build metadata', () => {
    expect(parseVersion('1.2.3-rc.1')?.prerelease).toEqual(['rc', '1'])
    expect(parseVersion('1.2.3+build.9')?.prerelease).toEqual([])
    expect(parseVersion('1.2.3-rc.1+build.9')?.prerelease).toEqual(['rc', '1'])
  })

  it('refuses anything that is not three numeric parts', () => {
    // A date tag, a two-part tag, and a range all reach here from a real feed,
    // and ordering them would invent a comparison the tag does not support.
    expect(parseVersion('2026-09-29')).toBeUndefined()
    expect(parseVersion('0.1')).toBeUndefined()
    expect(parseVersion('0.1.4.5')).toBeUndefined()
    expect(parseVersion('^0.1.4')).toBeUndefined()
    expect(parseVersion('nightly')).toBeUndefined()
    expect(parseVersion('')).toBeUndefined()
    expect(parseVersion('v')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders by release number', () => {
    expect(compareVersions('0.1.3', '0.1.4')).toBe(-1)
    expect(compareVersions('0.1.4', '0.1.3')).toBe(1)
    expect(compareVersions('0.2.0', '0.1.99')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('v0.1.3', '0.1.3')).toBe(0)
  })

  it('compares numbers rather than their text', () => {
    // Text comparison would put 10 below 9, which a release count reaches.
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
  })

  it('sorts a prerelease below the release it precedes', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('sorts numeric prerelease identifiers below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1)
  })

  it('answers undefined when either side does not parse', () => {
    // Distinct from 0 and from any ordering: the caller has to skip the release
    // rather than decide which of two unreadable tags is newer.
    expect(compareVersions('0.1.3', 'nightly')).toBeUndefined()
    expect(compareVersions('nightly', '0.1.3')).toBeUndefined()
  })
})

describe('isNewerVersion', () => {
  it('reports only a strictly newer version', async () => {
    expect(isNewerVersion('v0.1.4', '0.1.3')).toBe(true)
    expect(isNewerVersion('0.1.3', '0.1.3')).toBe(false)
    expect(isNewerVersion('0.1.2', '0.1.3')).toBe(false)
  })

  it('reports false for a tag that does not parse', async () => {
    expect(isNewerVersion('nightly', '0.1.3')).toBe(false)
    expect(isNewerVersion('0.1.4', 'not-a-version')).toBe(false)
  })
})

describe('trimNotes', () => {
  it('drops empty notes rather than showing an empty box', () => {
    expect(trimNotes(undefined)).toBeUndefined()
    expect(trimNotes('')).toBeUndefined()
    expect(trimNotes('  \n\n ')).toBeUndefined()
  })

  it('leaves notes that fit alone', () => {
    expect(trimNotes('  a fix and a feature  ')).toBe('a fix and a feature')
  })

  it('clips long notes on a line boundary and says so', () => {
    const line = `${'x'.repeat(200)}\n`
    const clipped = trimNotes(line.repeat(60))
    expect(clipped).toBeDefined()
    expect(clipped!.endsWith('[release notes truncated]')).toBe(true)
    expect(clipped!.length).toBeLessThan(NOTES_LIMIT + 64)
    // The clip lands on a line boundary, so no line arrives half written.
    expect(clipped!.startsWith('x'.repeat(200))).toBe(true)
  })
})

describe('isUpdatePending', () => {
  it('is true while an update waits on the user', async () => {
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'available' })).toBe(true)
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'ready' })).toBe(true)
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'downloading' })).toBe(true)
  })

  it('is false when nothing waits, and when the version was skipped', async () => {
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'idle' })).toBe(false)
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'error' })).toBe(false)
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'unsupported' })).toBe(false)
    expect(isUpdatePending({ version: '0.1.3', arch: 'arm64', phase: 'available', skipped: true })).toBe(false)
  })
})
