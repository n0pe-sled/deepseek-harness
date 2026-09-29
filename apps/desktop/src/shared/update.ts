/**
 * Update state shared by the main process, the shell preload, and the renderer,
 * plus the version comparison the check runs on.
 *
 * Pure functions only: the main process, `scripts/`, and the renderer all import
 * this module, so it must not touch the filesystem, Electron, or the network.
 */

/** Where the update check is in its lifecycle. */
export type UpdatePhase =
  /** Nothing has been checked yet in this run. */
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  /** This build cannot update itself, and `reason` says why. */
  | 'unsupported'

/**
 * One point-in-time view of the updater. Pushed wholesale on every change, the
 * way `InstanceView` is: the payload is small and a diffing protocol would cost
 * more than it saves.
 */
export interface UpdateSnapshot {
  /** The running app version, from the bundle's Info.plist. */
  version: string
  /** CPU architecture of this build (`arm64` or `x64`), which selects the asset. */
  arch: string
  /** Path of the `.app` an install would replace, when one was resolved. */
  installTarget?: string
  phase: UpdatePhase
  /** Newer version found on the release feed. */
  latestVersion?: string
  /** The release's tag, which is what the feed actually names. */
  latestTag?: string
  /** Release title or tag, for display. */
  releaseName?: string
  /** The `.dmg` asset this build would install. */
  assetName?: string
  assetUrl?: string
  /** Download progress in bytes; `total` is 0 when the feed gave no size. */
  receivedBytes?: number
  totalBytes?: number
  /** Where the downloaded `.dmg` is on disk. */
  downloadPath?: string
  /**
   * Release body, trimmed to a readable length. Remote content: render it as
   * text, never as HTML.
   */
  notes?: string
  releasedAt?: string
  /** HTML URL of the release page, for a manual install. */
  releaseUrl?: string
  /**
   * Why this build cannot update itself, or why the last attempt failed. Always
   * set for `unsupported` and `error`; may be set alongside other phases for a
   * non-fatal note such as a missing checksum.
   */
  reason?: string
  /** Path of the updater's own log, so a failed install leaves a trail to read. */
  logPath?: string
  /** Set once an install has been launched, so the window can stop offering it. */
  installStartedAt?: number
  /** Set when the user pressed Skip for `latestVersion`. */
  skipped?: boolean
}

/** One parsed semantic version, after dropping any `v` prefix and build metadata. */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

/** `0.1.4`, `v0.1.4`, `1.2.3-rc.1`. Anything else does not parse. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a version or release tag.
 *
 * Returns undefined rather than a best guess for anything that is not
 * `major.minor.patch`: a tag the updater cannot order must never be reported as
 * "older", which would silently hide a real release.
 *
 * @param raw - the version or tag, with or without a leading `v`.
 * @returns the parsed version, or undefined when it is not three numeric parts.
 */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/**
 * Order two versions by semver precedence: release numbers first, then the
 * prerelease rule that `1.0.0-rc.1` sorts below `1.0.0`. Build metadata is
 * ignored, as the specification requires.
 *
 * @param a - left version or tag.
 * @param b - right version or tag.
 * @returns a negative number when `a` precedes `b`, positive when it follows,
 *   zero when they are equal, and undefined when either side does not parse.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined) return undefined

  for (const part of ['major', 'minor', 'patch'] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** A version with no prerelease outranks the same release numbers with one. */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const shared = Math.min(left.length, right.length)
  for (let i = 0; i < shared; i += 1) {
    const a = left[i]
    const b = right[i]
    if (a === undefined || b === undefined) break
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    // Numeric identifiers always sort below alphanumeric ones.
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  // Every shared identifier matched, so the shorter set is the lower one.
  if (left.length === right.length) return 0
  return left.length < right.length ? -1 : 1
}

/**
 * Whether `candidate` is a version worth offering over `current`.
 *
 * A version that does not parse answers false: the caller then skips that release
 * instead of inventing an ordering for it.
 *
 * @param candidate - the release version or tag under consideration.
 * @param current - the running app version.
 * @returns true only when `candidate` is strictly newer than `current`.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const order = compareVersions(candidate, current)
  return order !== undefined && order > 0
}

/** Trim release notes to something a window can hold, on a line boundary. */
export const NOTES_LIMIT = 8000

/**
 * Shorten release notes for display without cutting mid-line.
 *
 * @param notes - the release body, which may be empty or absent.
 * @returns the notes, or undefined when there are none to show.
 */
export function trimNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined
  const trimmed = notes.trim()
  if (trimmed === '') return undefined
  if (trimmed.length <= NOTES_LIMIT) return trimmed
  const clipped = trimmed.slice(0, NOTES_LIMIT)
  const lastBreak = clipped.lastIndexOf('\n')
  return `${lastBreak > NOTES_LIMIT / 2 ? clipped.slice(0, lastBreak) : clipped}\n\n[release notes truncated]`
}

/**
 * Whether a snapshot should call attention to itself: an update exists that the
 * user has not skipped, or one is already downloaded and waiting on them.
 *
 * @param snapshot - the updater's current state.
 * @returns true when the shell should offer the update.
 */
export function isUpdatePending(snapshot: UpdateSnapshot): boolean {
  if (snapshot.skipped === true) return false
  return snapshot.phase === 'available' || snapshot.phase === 'downloading' || snapshot.phase === 'ready'
}
