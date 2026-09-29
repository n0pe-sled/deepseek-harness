/**
 * Choosing which release and which `.dmg` an update should offer.
 *
 * Every rule here answers with a reason when it refuses, because "no update" and
 * "the feed carries something this app cannot read" are different answers and the
 * user needs to be able to tell them apart.
 */
import { isNewerVersion, parseVersion } from '../../shared/update.ts'
import type { Release, ReleaseAsset } from './types.ts'

/** Why a feed produced no update, when that is worth saying out loud. */
export interface SelectionOutcome {
  /** The release to offer, when one is newer and carries an installable image. */
  release?: Release
  asset?: ReleaseAsset
  /** Set when no release was offered, naming the reason. */
  reason?: string
}

/**
 * The newest release this app should offer over the running version.
 *
 * Drafts and prereleases are ignored, and a tag that does not parse as a version
 * is skipped rather than treated as older: an unreadable tag is not evidence that
 * the running build is current.
 *
 * @param releases - the feed's releases, in any order.
 * @param runningVersion - the version of the running app.
 * @param options - `allowPrerelease` opts prereleases in, for a user tracking them.
 * @returns the newest usable release, or a reason when none is offered.
 */
export function selectRelease(
  releases: readonly Release[],
  runningVersion: string,
  options: { allowPrerelease?: boolean } = {},
): SelectionOutcome {
  const usable = releases.filter((release) => {
    if (release.draft) return false
    if (release.prerelease && options.allowPrerelease !== true) return false
    return parseVersion(release.tag) !== undefined
  })
  if (usable.length === 0) {
    return { reason: reasonsForEmptyFeed(releases, options.allowPrerelease === true) }
  }

  const newer = usable.filter((release) => isNewerVersion(release.tag, runningVersion))
  if (newer.length === 0) {
    return { reason: `no release is newer than ${runningVersion}` }
  }

  // The list is non-empty here, so the first entry is the running best.
  let newest = newer[0] as Release
  for (const candidate of newer) {
    if (isNewerVersion(candidate.tag, newest.tag)) newest = candidate
  }
  return { release: newest }
}

/** Distinguish "nothing published" from "everything published was skipped". */
function reasonsForEmptyFeed(releases: readonly Release[], allowPrerelease: boolean): string {
  if (releases.length === 0) return 'this repository has published no releases yet'
  const published = releases.filter((release) => !release.draft)
  if (published.length === 0) return 'every published release is still a draft'
  const stable = published.filter((release) => !release.prerelease)
  if (!allowPrerelease && stable.length === 0) {
    return 'every published release is a prerelease'
  }
  const tags = published.map((release) => release.tag).join(', ')
  return `no release tag reads as a semantic version (${tags})`
}

/**
 * The disk image to install from a release.
 *
 * The image name carries the architecture because this app is built per architecture
 * and its native addons do not run on the other one. An image that names the other
 * architecture is therefore refused even when it is the only one the release
 * publishes, because installing it leaves an app that cannot start. An image that
 * names no architecture is accepted, because then nothing contradicts this build.
 *
 * @param release - the release chosen to install.
 * @param arch - this build's architecture (`arm64` or `x64`).
 * @param platform - this build's platform, which decides the archive suffixes read.
 * @returns the image, or a reason naming what the release actually carries.
 */
export function selectDmgAsset(
  release: Release,
  arch: string,
  platform: string = process.platform,
): { asset?: ReleaseAsset; reason?: string } {
  const images = release.assets.filter((asset) => isDmg(asset.name, platform))
  if (images.length === 0) {
    return { reason: `release ${release.tag} carries no disk image to install` }
  }

  const candidates = images.filter((asset) => archOf(asset.name) === undefined || nameMentionsArch(asset.name, arch))
  // An image that names this build's architecture wins over one that names
  // none, and only then does the file name break the tie.
  const named = candidates.filter((asset) => archOf(asset.name) !== undefined)
  const pool = named.length > 0 ? named : candidates
  const chosen = pool.reduce<ReleaseAsset | undefined>(
    (best, candidate) => (best === undefined || candidate.name > best.name ? candidate : best),
    undefined,
  )
  if (chosen !== undefined) return { asset: chosen }

  const names = images.map((asset) => asset.name).join(', ')
  return {
    reason: `release ${release.tag} has no ${arch} disk image (it carries ${names})`,
  }
}

/**
 * The architecture an image name commits to, or undefined when it names none.
 *
 * `undefined` is not "not this architecture": it means the name says nothing
 * either way, which is what lets an unnamed image stand as the only candidate.
 *
 * @param name - the asset's file name.
 * @returns the architecture, or undefined when the name carries no architecture.
 */
export function archOf(name: string): string | undefined {
  if (nameMentionsArch(name, 'arm64')) return 'arm64'
  if (nameMentionsArch(name, 'x64')) return 'x64'
  return undefined
}

/** Whether an asset is a disk image for `platform`. */
export function isDmg(name: string, platform: string = process.platform): boolean {
  if (platform === 'darwin') return name.toLowerCase().endsWith('.dmg')
  if (platform === 'win32') return name.toLowerCase().endsWith('.exe')
  return name.toLowerCase().endsWith('.appimage')
}

/**
 * Whether an asset name names an architecture.
 *
 * The token must not be followed by another word character, which is what keeps
 * `x64` from matching inside `arm64`.
 *
 * @param name - the asset's file name.
 * @param arch - the architecture to look for (`arm64`, `x64`).
 * @returns true when the name carries that architecture.
 */
export function nameMentionsArch(name: string, arch: string): boolean {
  const lower = name.toLowerCase()
  const tokens = arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : [arch.toLowerCase()]
  return tokens.some((token) => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'u').test(lower))
}

/**
 * The digest a release publishes for an asset, when it publishes one.
 *
 * A manual install path is the only reason to publish a digest, so the feed may not
 * carry one, and its absence is reported rather than hidden.
 *
 * @param releases - every release in the feed.
 * @param asset - the image about to be installed.
 * @returns the expected digest, or undefined when the feed publishes none.
 */
export function publishedDigest(releases: readonly Release[], asset: ReleaseAsset): string | undefined {
  const pattern = new RegExp(`([0-9a-f]{64})\\s+\\*?${escapeForRegExp(asset.name)}`, 'iu')
  for (const release of releases) {
    const match = pattern.exec(release.body ?? '')
    if (match?.[1] !== undefined) return match[1].toLowerCase()
  }
  return undefined
}

/** Escape a literal string for use inside a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
