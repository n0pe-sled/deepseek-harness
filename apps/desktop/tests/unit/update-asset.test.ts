/**
 * Disk image selection: which attached file an install would use.
 *
 * The app is built per architecture and its native addons do not run on the other
 * one, so an image for the wrong architecture must not be installed even when it is
 * the only one the release carries.
 */
import { describe, expect, it } from 'vitest'
import { archOf, isDmg, nameMentionsArch, publishedDigest, selectDmgAsset } from '../../src/main/update/select.ts'
import type { Release } from '../../src/main/update/types.ts'

/** One release carrying the named files. */
function release(tag: string, names: string[], body?: string): Release {
  return {
    tag,
    draft: false,
    prerelease: false,
    ...(body === undefined ? {} : { body }),
    assets: names.map((name) => ({ name, url: `https://example.test/${name}`, size: 10 })),
  }
}

describe('isDmg', () => {
  it('accepts the image format of a platform and nothing else', () => {
    expect(isDmg('DSH Desktop-0.1.4-arm64.dmg', 'darwin')).toBe(true)
    expect(isDmg('DSH Desktop-0.1.4-arm64.zip', 'darwin')).toBe(false)
    // Update metadata and checksum sidecars sit beside the image in a release.
    expect(isDmg('latest-mac.yml', 'darwin')).toBe(false)
    expect(isDmg('SHA256SUMS', 'darwin')).toBe(false)
  })
})

describe('nameMentionsArch', () => {
  it('finds the architecture as a whole token', () => {
    expect(nameMentionsArch('DSH Desktop-0.1.4-arm64.dmg', 'arm64')).toBe(true)
    expect(nameMentionsArch('DSH Desktop-0.1.4-x64.dmg', 'x64')).toBe(true)
    expect(nameMentionsArch('DSH Desktop-0.1.4-x86_64.dmg', 'x64')).toBe(true)
  })

  it('does not match one architecture inside another', () => {
    // `x64` is a substring of `arm64`, and installing the other
    // architecture's image produces an app that cannot load its own addons.
    expect(nameMentionsArch('DSH Desktop-0.1.4-arm64.dmg', 'x64')).toBe(false)
    expect(nameMentionsArch('DSH Desktop-0.1.4-universal.dmg', 'arm64')).toBe(false)
  })
})

describe('selectDmgAsset', () => {
  it('prefers the image built for this architecture', () => {
    const chosen = selectDmgAsset(
      release('v0.1.5', ['DSH Desktop-0.1.5-x64.dmg', 'DSH Desktop-0.1.5-arm64.dmg']),
      'arm64',
      'darwin',
    )
    expect(chosen.asset?.name).toBe('DSH Desktop-0.1.5-arm64.dmg')
    expect(chosen.reason).toBeUndefined()
  })

  it('refuses a lone image built for the other architecture', () => {
    const chosen = selectDmgAsset(
      release('v0.1.5', ['DSH Desktop-0.1.5-x64.dmg']),
      'arm64',
      'darwin',
    )
    expect(chosen.asset).toBeUndefined()
    expect(chosen.reason).toBe(
      'release v0.1.5 has no arm64 disk image (it carries DSH Desktop-0.1.5-x64.dmg)',
    )
  })

  it('accepts one unnamed-architecture image', () => {
    // A release that names no architecture says nothing against this build, so
    // refusing its only image would hide a release that is almost certainly right.
    const chosen = selectDmgAsset(release('v0.1.5', ['DSH Desktop-0.1.5.dmg']), 'arm64', 'darwin')
    expect(chosen.asset?.name).toBe('DSH Desktop-0.1.5.dmg')
    expect(chosen.reason).toBeUndefined()
  })

  it('accepts one unnamed-architecture image beside other-architecture images', () => {
    const chosen = selectDmgAsset(
      release('v0.1.5', ['DSH Desktop-0.1.5.dmg', 'DSH Desktop-0.1.5-x64.dmg']),
      'arm64',
      'darwin',
    )
    expect(chosen.asset?.name).toBe('DSH Desktop-0.1.5.dmg')
  })

  it('prefers a named image over an unnamed one', () => {
    const chosen = selectDmgAsset(
      release('v0.1.5', ['DSH Desktop-0.1.5.dmg', 'DSH Desktop-0.1.5-arm64.dmg']),
      'arm64',
      'darwin',
    )
    expect(chosen.asset?.name).toBe('DSH Desktop-0.1.5-arm64.dmg')
  })

  it('names the release when it carries no image at all', () => {
    const chosen = selectDmgAsset(release('v0.1.5', ['source.zip', 'latest-mac.yml']), 'arm64', 'darwin')
    expect(chosen.asset).toBeUndefined()
    expect(chosen.reason).toBe('release v0.1.5 carries no disk image to install')
  })

  it('drops a refused asset name from the reason', () => {
    const chosen = selectDmgAsset(release('v0.1.5', ['source.zip']), 'arm64', 'darwin')
    expect(chosen.reason).not.toContain('source.zip')
  })
})

describe('archOf', () => {
  it('reads the architecture a name commits to', () => {
    expect(archOf('DSH Desktop-0.1.5-arm64.dmg')).toBe('arm64')
    expect(archOf('DSH Desktop-0.1.5-x64.dmg')).toBe('x64')
    expect(archOf('DSH Desktop-0.1.5-x86_64.dmg')).toBe('x64')
  })

  it('answers undefined when the name says nothing either way', () => {
    expect(archOf('DSH Desktop-0.1.5.dmg')).toBeUndefined()
    expect(archOf('DSH Desktop-0.1.5-universal.dmg')).toBeUndefined()
  })
})

describe('publishedDigest', () => {
  it('reads a digest the release publishes for the image', () => {
    const body = [
      'Fixes and features.',
      '',
      `abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  DSH Desktop-0.1.5-arm64.dmg`,
    ].join('\n')
    expect(publishedDigest([release('v0.1.5', ['DSH Desktop-0.1.5-arm64.dmg'], body)],
      { name: 'DSH Desktop-0.1.5-arm64.dmg', url: 'https://example.test/a.dmg' }))
      .toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')
  })

  it('accepts the star form sha256sum writes', () => {
    const digest = 'b1946ac92492d2347c6235b4d2611184b1946ac92492d2347c6235b4d2611184'
    const body = `${digest}  *DSH Desktop-0.1.5-arm64.dmg`
    expect(publishedDigest([release('v0.1.5', [], body)],
      { name: 'DSH Desktop-0.1.5-arm64.dmg', url: 'https://example.test/a.dmg' }))
      .toBe(digest)
  })

  it('refuses a digest that is not a full SHA-256', () => {
    // A short token beside the name is not a digest, and comparing an image
    // against it would report a verification that never happened.
    expect(publishedDigest([release('v0.1.5', [], 'abc  DSH Desktop-0.1.5-arm64.dmg')],
      { name: 'DSH Desktop-0.1.5-arm64.dmg', url: 'https://example.test/a.dmg' }))
      .toBeUndefined()
  })

  it('answers undefined rather than inventing a digest', () => {
    // A digest this app made up would be compared against itself and would
    // report a verification that never happened.
    expect(publishedDigest([release('v0.1.5', [], 'no checksums here')],
      { name: 'DSH Desktop-0.1.5-arm64.dmg', url: 'https://example.test/a.dmg' }))
      .toBeUndefined()
  })
})
