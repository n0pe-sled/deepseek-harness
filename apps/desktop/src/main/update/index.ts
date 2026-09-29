/**
 * AppUpdater: the app's own update check, download, and install.
 *
 * It owns one state snapshot and pushes it to listeners the way InstanceManager
 * pushes instance views, so the update window and the session bar render the same
 * value without polling. Nothing here reaches the network until something asks it to,
 * so importing this module costs the shell nothing.
 *
 * The token the check authenticates with is read at check time and never stored
 * (see catalog.ts). No snapshot field and no error message can carry it.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { trimNotes, isNewerVersion } from '../../shared/update.ts'
import type { UpdateSnapshot } from '../../shared/update.ts'
import type { Release, ReleaseAsset } from './types.ts'
import { DEFAULT_REPO, listReleases, readGhToken } from './catalog.ts'
import { publishedDigest, selectDmgAsset, selectRelease } from './select.ts'
import { downloadAsset } from './download.ts'
import { enclosingBundle, installPlan, launchInstaller } from './install.ts'

/** How long after launch an unfinished install is worth reporting. */
const INSTALL_REPORT_DELAY_MS = 60_000

/** Bytes between progress pushes, so one image does not send thousands of frames. */
const PROGRESS_STEP_BYTES = 1024 * 1024

/** Where the installer writes its progress, under the user's own logs. */
export const UPDATE_LOG_PATH = `${homedir()}/Library/Logs/DSH Desktop/update.log`

/** An install this app launched, recorded so a later run can report how it went. */
interface InstallRecord {
  schemaVersion: 1
  /** The version the install was launched from. */
  fromVersion: string
  /** The version the installed image carries. */
  toVersion: string
  /** The bundle the installer replaced. */
  appBundle: string
  /** Where the installer wrote its progress. */
  logPath: string
  startedAt: number
}

/** A release the user asked not to be offered again. */
interface SkipRecord {
  schemaVersion: 1
  version: string
  skippedAt: number
}

export interface UpdaterOptions {
  /** The running app version, which the check compares releases against. */
  version: string
  /** This build's architecture, which selects the image asset. */
  arch: string
  /**
   * Whether this build can install over itself. A development run has no bundle
   * to replace, and offering an update it cannot install is a false promise.
   * The bundle itself is read from the running executable, so it cannot be
   * configured into place from here.
   */
  installable: boolean
  /** Where a download, and the install records, live. */
  userDataDir: string
  /** `owner/repo` to read releases from, overriding the default feed. */
  repo?: string
  /** Reads the token at check time; defaults to the environment and `gh`. */
  token?: () => Promise<string | undefined>
  /** Runs the release request; injected so tests need no network. */
  fetchImpl?: typeof fetch
}

/** The updater: what the IPC layer and the window call. */
export class AppUpdater {
  private snapshot: UpdateSnapshot
  private readonly options: UpdaterOptions
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>()
  private readonly repo: string
  private release: Release | undefined
  private asset: ReleaseAsset | undefined
  private releases: Release[] = []
  private checking: Promise<UpdateSnapshot> | undefined
  private downloading: Promise<UpdateSnapshot> | undefined
  private skipped: string | undefined
  private progressAt = 0
  private installListener: (() => void) | undefined

  constructor(options: UpdaterOptions) {
    this.options = options
    this.repo = options.repo ?? DEFAULT_REPO
    const installTarget = options.installable ? enclosingBundle(process.execPath) : undefined
    this.snapshot = {
      version: options.version,
      arch: options.arch,
      ...(installTarget === undefined ? {} : { installTarget }),
      phase: options.installable ? 'idle' : 'unsupported',
      ...(options.installable
        ? {}
        : { reason: 'this build did not come from an application bundle, so it cannot replace itself' }),
    }
  }

  /** The current state. */
  state(): UpdateSnapshot {
    return this.snapshot
  }

  /**
   * Subscribe to state changes.
   *
   * @param listener - called with the new state after every change.
   * @returns the unsubscribe.
   */
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Subscribe to the moment an install starts.
   *
   * The installer waits for this process to exit, so the app quits the moment
   * one is launched rather than waiting for the user to close it. One listener
   * is enough for the whole app, and the last one registered wins.
   *
   * @param listener - called once, when an install has been launched.
   */
  onInstallStarted(listener: () => void): void {
    this.installListener = listener
  }

  /**
   * Reconcile what a previous run left behind: a skipped version, an install that
   * did not land, and a download that never completed.
   *
   * Called once at startup, before the first check.
   */
  async load(): Promise<void> {
    this.skipped = (await this.readJson<SkipRecord>(this.skipFile()))?.version
    await this.discardPartialDownloads()

    const record = await this.readJson<InstallRecord>(this.installFile())
    if (record === undefined || record.schemaVersion !== 1) return
    if (record.toVersion === this.options.version) {
      this.report(`installed ${record.toVersion}, and this build is running it`)
      await this.remove(this.installFile())
      return
    }
    if (Date.now() - record.startedAt < INSTALL_REPORT_DELAY_MS) return
    // The app came back on the version it was updating from, so the install did
    // not land. The log says why, so the report names where to read it.
    this.report(
      `an install of ${record.toVersion} did not complete, and this build is still ${record.fromVersion}. `
      + `Its log is at ${record.logPath}`,
    )
  }

  /**
   * Look for a release newer than this build.
   *
   * @param options - `silent` marks the launch check, which is the same request
   *   with an outcome the shell only shows when it finds something.
   * @returns the resulting state.
   */
  async check(options: { silent?: boolean } = {}): Promise<UpdateSnapshot> {
    if (!this.options.installable) return this.snapshot
    // A second check while one runs has the same answer, so it waits for that
    // one rather than starting a request of its own.
    if (this.checking !== undefined) return this.checking
    const running = this.runCheck(options.silent === true)
    this.checking = running
    try {
      return await running
    } finally {
      this.checking = undefined
    }
  }

  /** Download the image the last check selected, and record its digest. */
  async download(): Promise<UpdateSnapshot> {
    if (!this.options.installable) return this.snapshot
    if (this.downloading !== undefined) return this.downloading
    const running = this.runDownload()
    this.downloading = running
    try {
      return await running
    } finally {
      this.downloading = undefined
    }
  }

  /**
   * Replace this bundle with the downloaded image and relaunch.
   *
   * The caller quits the app once this returns; the installer waits for that
   * exit before it touches the bundle.
   *
   * @returns the resulting state, which is `installing` only once the installer
   *   is actually running.
   */
  async installAndRelaunch(): Promise<UpdateSnapshot> {
    const asset = this.asset
    const imagePath = this.snapshot.downloadPath
    if (this.snapshot.phase !== 'ready' || asset === undefined || imagePath === undefined) {
      return this.snapshot
    }

    let plan
    try {
      plan = installPlan(process.execPath, imagePath, this.logPath(), process.pid)
    } catch (error) {
      // A build outside a bundle reaches here, which is the same reason a
      // development run reports `unsupported`.
      return this.set({ phase: 'error', reason: describe(error) })
    }
    await this.writeJson(this.installFile(), {
      schemaVersion: 1,
      fromVersion: this.options.version,
      toVersion: this.snapshot.latestVersion ?? '',
      appBundle: plan.appBundle,
      logPath: plan.logPath,
      startedAt: Date.now(),
    } satisfies InstallRecord)

    try {
      launchInstaller(plan)
    } catch (error) {
      return this.set({ phase: 'error', reason: `could not start the installer: ${describe(error)}` })
    }
    const started = this.set({ phase: 'installing', installStartedAt: Date.now() })
    this.installListener?.()
    return started
  }

  /** Stop offering the version the last check found. */
  async skipVersion(): Promise<UpdateSnapshot> {
    const version = this.snapshot.latestVersion
    if (version === undefined) return this.snapshot
    this.skipped = version
    await this.writeJson(this.skipFile(), {
      schemaVersion: 1,
      version,
      skippedAt: Date.now(),
    } satisfies SkipRecord)
    return this.set({ skipped: true })
  }

  /** The check itself: read a token, read the feed, pick a release and image. */
  private async runCheck(silent: boolean): Promise<UpdateSnapshot> {
    this.set({ phase: 'checking', latestVersion: undefined, latestTag: undefined, reason: undefined })
    try {
      const token = await this.readToken()
      const catalog = await listReleases({
        repo: this.repo,
        ...(token === undefined ? {} : { token }),
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      })
      this.releases = catalog.releases

      const outcome = selectRelease(catalog.releases, this.options.version)
      const release = outcome.release
      if (release === undefined) {
        return this.set({ phase: 'idle', reason: outcome.reason ?? 'no newer release was found' })
      }

      // A user who skipped a release keeps their choice until something newer
      // than the skipped version appears.
      if (this.skipped !== undefined && !isNewerAfter(release.tag, this.skipped)) {
        this.release = release
        return this.set({
          phase: 'available',
          latestVersion: normalize(release.tag),
          latestTag: release.tag,
          skipped: true,
          ...releaseFields(release),
        })
      }

      const image = selectDmgAsset(release, this.options.arch)
      this.release = release
      this.asset = image.asset
      if (image.asset === undefined) {
        return this.set({
          phase: 'error',
          latestVersion: normalize(release.tag),
          latestTag: release.tag,
          reason: image.reason ?? `release ${release.tag} carries no image to install`,
          ...releaseFields(release),
        })
      }

      return this.set({
        phase: 'available',
        latestVersion: normalize(release.tag),
        latestTag: release.tag,
        assetName: image.asset.name,
        assetUrl: image.asset.url,
        skipped: false,
        ...releaseFields(release),
      })
    } catch (error) {
      const reason = describe(error)
      // A silent check that cannot reach the feed stays quiet: it runs at launch
      // and a dialog about a network blip would turn it into a nuisance.
      return this.set({ phase: silent ? 'idle' : 'error', reason })
    }
  }

  /** The download itself, with progress, then the digest check. */
  private async runDownload(): Promise<UpdateSnapshot> {
    if (this.asset === undefined || this.release === undefined || this.snapshot.phase !== 'available') {
      return this.snapshot
    }
    const asset = this.asset
    const dest = join(this.downloadDir(), asset.name)
    this.progressAt = 0
    this.set({ phase: 'downloading', receivedBytes: 0, reason: undefined })

    try {
      const token = await this.readToken()
      const expected = publishedDigest(this.releases, asset)
      const result = await downloadAsset({
        asset,
        dest,
        ...(token === undefined ? {} : { token }),
        ...(expected === undefined ? {} : { expectedSha256: expected }),
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        onProgress: (received, total) => {
          if (received - this.progressAt < PROGRESS_STEP_BYTES && received < total) return
          this.progressAt = received
          this.set({ phase: 'downloading', receivedBytes: received, totalBytes: total })
        },
      })
      return this.set({
        phase: 'ready',
        downloadPath: result.path,
        receivedBytes: result.bytes,
        totalBytes: result.bytes,
        // Saying an image was verified when the release publishes no digest for
        // it would be a claim this app cannot support.
        ...(result.verified
          ? {}
          : { reason: `release ${this.release.tag} publishes no digest for ${asset.name}, so its bytes were read but not confirmed against one` }),
      })
    } catch (error) {
      return this.set({ phase: 'error', reason: describe(error) })
    }
  }

  /** Read the token, or undefined when this machine has none. */
  private async readToken(): Promise<string | undefined> {
    if (this.options.token !== undefined) return this.options.token()
    return readGhToken(process.env, process.env.PATH ?? '')
  }

  /** Report something a previous run needs to say, without changing the phase. */
  private report(reason: string): void {
    this.set({ reason })
  }

  /** Publish a state change, keeping the fields the caller did not mention. */
  private set(patch: Partial<UpdateSnapshot>): UpdateSnapshot {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener(this.snapshot)
    return this.snapshot
  }

  /** A part file is an interrupted download, and can never be installed. */
  private async discardPartialDownloads(): Promise<void> {
    try {
      const entries = await fs.readdir(this.downloadDir())
      for (const entry of entries) {
        if (entry.endsWith('.part')) await this.remove(join(this.downloadDir(), entry))
      }
    } catch {
      // No download directory yet, which is what a first run has.
    }
  }

  /** Where the installer writes its progress. */
  private logPath(): string {
    return UPDATE_LOG_PATH
  }

  private installFile(): string {
    return join(this.options.userDataDir, 'update', 'last-install.json')
  }

  private skipFile(): string {
    return join(this.options.userDataDir, 'skipped-update.json')
  }

  private downloadDir(): string {
    return join(this.options.userDataDir, 'updates')
  }

  /** Read a record this app wrote, treating anything unreadable as absent. */
  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T
    } catch {
      // Absent or unreadable both mean this run has no record to reconcile,
      // which is the state a first run is in.
      return undefined
    }
  }

  /** Write a record, failing the caller rather than losing it. */
  private async writeJson(path: string, value: unknown): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  /** Remove a record this app no longer needs. */
  private async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true })
  }
}

/** The release fields a snapshot carries, skipping the ones it lacks. */
function releaseFields(release: Release): Partial<UpdateSnapshot> {
  const notes = trimNotes(release.body)
  return {
    ...(release.name === undefined ? {} : { releaseName: release.name }),
    ...(release.htmlUrl === undefined ? {} : { releaseUrl: release.htmlUrl }),
    ...(release.publishedAt === undefined ? {} : { releasedAt: release.publishedAt }),
    ...(notes === undefined ? {} : { notes }),
  }
}

/** Whether `tag` is newer than a skipped version, which lifts the skip. */
function isNewerAfter(tag: string, skipped: string): boolean {
  return isNewerVersion(tag, skipped)
}

/** A readable one-line reason from anything thrown. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The version without its tag prefix, for display and comparison. */
function normalize(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}
