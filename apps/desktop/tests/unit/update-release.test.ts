/**
 * Release selection: which release, of everything the feed publishes, an update
 * should offer.
 *
 * A release this app cannot order, or one the feed marks as unpublished, must not
 * be offered: the first would invent a comparison, and the second does not exist
 * for anyone yet.
 */
import { describe, expect, it } from 'vitest'
import { selectRelease } from '../../src/main/update/select.ts'
import type { Release } from '../../src/main/update/types.ts'

/** One release, with an empty body unless a case needs one. */
function release(tag: string, extra: Partial<Release> = {}): Release {
  return { tag, draft: false, prerelease: false, assets: [], ...extra }
}

describe('selectRelease', () => {
  it('offers the newest release above the running version', () => {
    const outcome = selectRelease(
      [release('v0.1.5'), release('v0.1.4'), release('v0.1.3')],
      '0.1.3',
    )
    expect(outcome.release?.tag).toBe('v0.1.5')
  })

  it('offers nothing when the running build is current', () => {
    const outcome = selectRelease([release('v0.1.3'), release('v0.1.2')], '0.1.3')
    expect(outcome.release).toBeUndefined()
    expect(outcome.reason).toBe('no release is newer than 0.1.3')
  })

  it('offers nothing when the running build is ahead of every release', () => {
    // A local build past the last tag is the normal case while a release is
    // being prepared, and offering an older one would be a downgrade.
    const outcome = selectRelease([release('v0.1.3')], '0.1.4')
    expect(outcome.release).toBeUndefined()
    expect(outcome.reason).toBe('no release is newer than 0.1.4')
  })

  it('ignores drafts and prereleases', () => {
    const outcome = selectRelease([
      release('v0.2.0', { draft: true }),
      release('v0.1.9', { prerelease: true }),
      release('v0.1.4'),
    ], '0.1.3')
    expect(outcome.release?.tag).toBe('v0.1.4')
  })

  it('offers a prerelease when prereleases are opted in', () => {
    const outcome = selectRelease([release('v0.2.0-rc.1')], '0.1.3', { allowPrerelease: true })
    expect(outcome.release?.tag).toBe('v0.2.0-rc.1')
  })

  it('skips a tag it cannot order instead of hiding it as older', () => {
    const outcome = selectRelease([release('nightly'), release('v0.1.4')], '0.1.3')
    expect(outcome.release?.tag).toBe('v0.1.4')
  })

  it('names the reason when every published tag is unreadable', () => {
    const outcome = selectRelease([release('2026-09-29'), release('nightly')], '0.1.3')
    expect(outcome.release).toBeUndefined()
    expect(outcome.reason).toBe('no release tag reads as a semantic version (2026-09-29, nightly)')
  })

  it('names an empty feed as empty rather than as an error', () => {
    const outcome = selectRelease([], '0.1.3')
    expect(outcome.release).toBeUndefined()
    expect(outcome.reason).toBe('this repository has published no releases yet')
  })

  it('names an all-draft feed differently from an empty one', () => {
    const outcome = selectRelease([release('v0.1.4', { draft: true })], '0.1.3')
    expect(outcome.reason).toBe('every published release is still a draft')
  })

  it('names an all-prerelease feed differently from an empty one', () => {
    const outcome = selectRelease([release('v0.1.4', { prerelease: true })], '0.1.3')
    expect(outcome.reason).toBe('every published release is a prerelease')
  })
})
