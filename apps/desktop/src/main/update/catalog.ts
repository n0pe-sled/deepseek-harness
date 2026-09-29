/**
 * Reading the release feed this app updates from.
 *
 * The feed is GitHub Releases on a private repository, so every request needs a
 * token. The token is read at check time from the environment or from the `gh` CLI
 * on this machine, never embedded in the app: anything shipped inside the .dmg can
 * be read out of its asar, and a token with repository access is the last thing
 * that should travel with the app.
 *
 * Nothing here imports Electron, so the selection rules can be tested directly.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import type { Release, ReleaseAsset } from './types.ts'

/** The repository releases are published to. */
export const DEFAULT_REPO = 'n0pe-sled/deepseek-harness'

/** GitHub's REST API. Overridable for a GitHub Enterprise host. */
export const DEFAULT_API_BASE = 'https://api.github.com'

/** Cap on releases read per check: the newest usable one is all the check needs. */
const PER_PAGE = 20

/** A check must finish or fail within a bounded time, because one runs at launch. */
export const REQUEST_TIMEOUT_MS = 15_000

/** A `gh` that has not answered by now is treated as absent. */
const GH_TIMEOUT_MS = 10_000

/** A release feed: which repository it came from, and what it published. */
export interface ReleaseCatalog {
  repo: string
  releases: Release[]
}

/** Minimal form of the GitHub release fields this app reads. */
interface RawRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  html_url?: unknown
  published_at?: unknown
  created_at?: unknown
  assets?: unknown
}

/** Minimal form of one attached file. */
interface RawAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
}

/**
 * A token to authenticate the release request with, or undefined when this machine
 * has none.
 *
 * `GH_TOKEN` wins over `GITHUB_TOKEN`, and either wins over the CLI, so a script
 * or a CI job can point the check at a token it controls.
 *
 * @param env - environment to read the two token variables from.
 * @param pathValue - PATH to search for the `gh` binary on.
 * @param run - runs `gh auth token`; injected so tests need no CLI on the machine.
 * @param searchDirs - directories to search after PATH, defaulting to the ones a
 *   package manager installs `gh` into.
 * @returns the token, or undefined when neither the environment nor `gh` supplies one.
 */
export async function readGhToken(
  env: NodeJS.ProcessEnv = process.env,
  pathValue: string = env.PATH ?? '',
  run: (ghPath: string) => Promise<string | undefined> = runGhAuthToken,
  searchDirs: readonly string[] = GH_INSTALL_DIRS,
): Promise<string | undefined> {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  const ghPath = findGh(pathValue, searchDirs)
  if (ghPath === undefined) return undefined
  return run(ghPath)
}

/**
 * Where `gh` lands when it is installed by a package manager. A macOS app
 * launched from Finder inherits launchd's PATH, which holds none of these, so
 * searching only the inherited PATH would report "no token" on a machine where
 * `gh` is installed and signed in.
 */
export const GH_INSTALL_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/**
 * The first executable `gh` on PATH, with the install directories appended.
 *
 * @param pathValue - PATH to search first.
 * @param searchDirs - directories to search after PATH.
 * @returns the absolute path of `gh`, or undefined when it is not installed.
 */
export function findGh(
  pathValue: string = process.env.PATH ?? '',
  searchDirs: readonly string[] = GH_INSTALL_DIRS,
): string | undefined {
  const dirs = [...pathValue.split(':'), ...searchDirs]
  for (const dir of dirs) {
    if (dir === '') continue
    const candidate = `${dir}/gh`
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not an executable here. The next directory may have it.
    }
  }
  return undefined
}

/**
 * Ask `gh` for the token it holds.
 *
 * The token goes to the caller and nowhere else. `gh` keeps it in the user's own
 * configuration, and this app has no reason to hold a second copy.
 */
async function runGhAuthToken(ghPath: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(ghPath, ['auth', 'token'], { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      // A missing `gh`, a signed-out `gh`, and a timeout all mean the same thing
      // to the caller: there is no token here.
      if (error !== null) {
        resolve(undefined)
        return
      }
      const token = stdout.trim()
      resolve(token === '' ? undefined : token)
    })
  })
}

/**
 * List releases newest first, keeping only what an update check reads.
 *
 * @param options - repository, token, API base, and an injectable fetch.
 * @returns the releases the repository publishes, newest first by creation time.
 * @throws when the request fails, naming the HTTP status or the network cause. A
 *   404 with no token is reported as an authentication problem, because on a
 *   private repository that is what it means.
 */
export async function listReleases(options: {
  repo?: string
  token?: string
  apiBase?: string
  fetchImpl?: typeof fetch
}): Promise<ReleaseCatalog> {
  const repo = options.repo ?? DEFAULT_REPO
  const apiBase = options.apiBase ?? DEFAULT_API_BASE
  const token = options.token
  const doFetch = options.fetchImpl ?? fetch
  const url = `${apiBase}/repos/${repo}/releases?per_page=${String(PER_PAGE)}`

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-desktop-updater',
    'x-github-api-version': '2022-11-28',
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    // fetch rejects with a generic TypeError for every network cause, so the cause
    // has to be read off the error rather than assumed.
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`could not reach GitHub (${apiBase}): ${cause}`)
  }

  if (!response.ok) {
    if (response.status === 404 && token === undefined) {
      throw new Error(
        `GitHub reported no repository at ${repo}, and no token was found. `
        + 'A private repository needs `gh auth login`, GH_TOKEN, or GITHUB_TOKEN.',
      )
    }
    throw new Error(`GitHub returned HTTP ${String(response.status)} reading ${repo} releases`)
  }

  const body: unknown = await response.json()
  if (!Array.isArray(body)) throw new Error('GitHub returned an unexpected releases response')
  return { repo, releases: body.flatMap((entry) => narrowRelease(entry)) }
}

/** Keep one release when it carries the fields the check compares. */
function narrowRelease(entry: unknown): Release[] {
  if (typeof entry !== 'object' || entry === null) return []
  const raw = entry as RawRelease
  if (typeof raw.tag_name !== 'string' || raw.tag_name.trim() === '') return []
  const assets = Array.isArray(raw.assets) ? raw.assets.flatMap((asset) => narrowAsset(asset)) : []
  const published = typeof raw.published_at === 'string'
    ? raw.published_at
    : typeof raw.created_at === 'string' ? raw.created_at : undefined
  return [{
    tag: raw.tag_name,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
    draft: raw.draft === true,
    prerelease: raw.prerelease === true,
    ...(typeof raw.html_url === 'string' ? { htmlUrl: raw.html_url } : {}),
    ...(published === undefined ? {} : { publishedAt: published }),
    assets,
  }]
}

/** Keep one asset when it has both a name and somewhere to download it from. */
function narrowAsset(entry: unknown): ReleaseAsset[] {
  if (typeof entry !== 'object' || entry === null) return []
  const raw = entry as RawAsset
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return []
  if (typeof raw.browser_download_url !== 'string' || raw.browser_download_url.trim() === '') return []
  return [{
    name: raw.name,
    url: raw.browser_download_url,
    ...(typeof raw.size === 'number' && Number.isFinite(raw.size) ? { size: raw.size } : {}),
  }]
}
