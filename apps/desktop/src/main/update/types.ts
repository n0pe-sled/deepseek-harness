/**
 * What one release of this app offers an update check: the version it carries, the
 * artifacts attached to it, and where a user can read about it.
 */

/** One file attached to a release. */
export interface ReleaseAsset {
  /** File name as published, which is what the arch and format are read from. */
  name: string
  /** Direct download URL for the asset. */
  url: string
  size?: number
}

/** One release, narrowed to the fields an update check uses. */
export interface Release {
  /** The tag, which is the version this check compares against the running app. */
  tag: string
  /** Release title, when the release carries one. */
  name?: string
  /** Release body: remote content, rendered as text and never as HTML. */
  body?: string
  draft: boolean
  prerelease: boolean
  htmlUrl?: string
  publishedAt?: string
  assets: ReleaseAsset[]
}
