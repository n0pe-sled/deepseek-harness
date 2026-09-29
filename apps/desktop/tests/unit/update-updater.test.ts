/**
 * The updater's own state machine, driven end to end with a fake feed.
 *
 * These cases are about what the app does with a feed, not about parsing one:
 * which release reaches the window, what a skip survives, and what a run reports
 * about the install the previous run launched. Each one answers with a real state
 * and real files under a temporary user data directory.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppUpdater } from '../../src/main/update/index.ts'
import type { UpdateSnapshot } from '../../src/shared/update.ts'

/** The bytes the fake feed serves as the disk image. */
const IMAGE = new TextEncoder().encode('a disk image')
const IMAGE_SHA256 = createHash('sha256').update(IMAGE).digest('hex')
const ASSET_NAME = 'DSH Desktop-0.1.5-arm64.dmg'

let dirs: string[] = []
let userDataDir: string

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'dsh-updater-'))
  dirs.push(userDataDir)
})

afterEach(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** Body of the fake download response. */
function imageBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(IMAGE)
      controller.close()
    },
  })
}

/**
 * A fetch that answers the release list with `releases` and every download with
 * the image bytes. `requested` records the URLs the check and download asked for.
 */
function fakeFeed(releases: unknown[], requested: string[] = []): typeof fetch {
  return (input) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/releases')) {
      return Promise.resolve(new Response(JSON.stringify(releases), { status: 200 }))
    }
    return Promise.resolve(new Response(imageBody(), {
      status: 200,
      headers: { 'content-length': String(IMAGE.byteLength) },
    }))
  }
}

/** One release in the feed's own field spelling. */
function feedRelease(tag: string, extra: Record<string, unknown> = {}): unknown {
  return {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://example.test/${tag}`,
    published_at: '2026-09-29T00:00:00Z',
    body: extra.body ?? '',
    assets: [{
      name: ASSET_NAME,
      browser_download_url: `https://example.test/${ASSET_NAME}`,
      size: IMAGE.byteLength,
    }],
    ...extra,
  }
}

/** An updater over a fresh user data directory, with the feed injected. */
function withFeed(releases: unknown[], options: { requested?: string[] } = {}): AppUpdater {
  return new AppUpdater({
    version: '0.1.4',
    arch: 'arm64',
    installable: true,
    userDataDir,
    repo: 'owner/repo',
    token: () => Promise.resolve('a-token'),
    fetchImpl: fakeFeed(releases, options.requested ?? []),
  })
}

/** A feed whose newest release is 0.1.5 over the running 0.1.4. */
function feedWithNewerRelease(body?: string): unknown[] {
  return [feedRelease('v0.1.5', body === undefined ? {} : { body })]
}

/** An updater whose only release carries the given notes. */
function updaterWithBody(body: string): AppUpdater {
  return withFeed(feedWithNewerRelease(body))
}

describe('AppUpdater check', () => {
  it('offers the newest release and selects this architecture', async () => {
    const updater = withFeed(feedWithNewerRelease())
    await updater.load()

    const snapshot = await updater.check()
    expect(snapshot.phase).toBe('available')
    expect(snapshot.latestVersion).toBe('0.1.5')
    expect(snapshot.latestTag).toBe('v0.1.5')
    expect(snapshot.assetName).toBe(ASSET_NAME)
    expect(snapshot.installTarget).toBeUndefined()
    expect(snapshot.skipped).toBe(false)
  })

  it('reports the running build as current when nothing is newer', async () => {
    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    const snapshot = await updater.check()
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.latestVersion).toBeUndefined()
    expect(snapshot.reason).toBe('no release is newer than 0.1.4')
  })

  it('carries the release notes into the state', async () => {
    const updater = updaterWithBody('Fixes and features.')
    await updater.load()

    expect((await updater.check()).notes).toBe('Fixes and features.')
  })

  it('refuses a release that carries no image for this architecture', async () => {
    const updater = withFeed([{
      tag_name: 'v0.1.5',
      draft: false,
      prerelease: false,
      assets: [{ name: 'DSH Desktop-0.1.5-x64.dmg', browser_download_url: 'https://example.test/x.dmg' }],
    }])
    await updater.load()

    const snapshot = await updater.check()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.reason).toContain('has no arm64 disk image')
  })

  it('reports a newer release it cannot install rather than ignoring it', async () => {
    const updater = withFeed([{ tag_name: 'v0.1.5', draft: false, prerelease: false, assets: [] }])
    await updater.load()

    const snapshot = await updater.check()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.latestVersion).toBe('0.1.5')
    expect(snapshot.reason).toBe('release v0.1.5 carries no disk image to install')
  })

  it('stays quiet when a silent check cannot reach GitHub', async () => {
    // The launch check runs whether or not the machine is online, and an error
    // state from a network blip would raise a dialog nobody asked for.
    const updater = new AppUpdater({
      version: '0.1.4',
      arch: 'arm64',
      installable: true,
      userDataDir,
      token: () => Promise.resolve(undefined),
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    })
    await updater.load()

    const snapshot = await updater.check({ silent: true })
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.reason).toContain('getaddrinfo ENOTFOUND')
  })

  it('refuses to check at all when the build cannot replace itself', async () => {
    const requested: string[] = []
    const updater = new AppUpdater({
      version: '0.1.4',
      arch: 'arm64',
      installable: false,
      userDataDir,
      fetchImpl: fakeFeed(feedWithNewerRelease(), requested),
    })

    const snapshot = await updater.check()
    expect(snapshot.phase).toBe('unsupported')
    expect(snapshot.reason).toContain('cannot replace itself')
    // An unpackaged run must not reach GitHub either.
    expect(requested).toEqual([])
  })
})

describe('AppUpdater download', () => {
  it('downloads the selected image and reports its bytes', async () => {
    const updater = withFeed(feedWithNewerRelease(`  ${IMAGE_SHA256}  ${ASSET_NAME}`))
    await updater.load()
    await updater.check()

    const progress: number[] = []
    updater.subscribe((snapshot: UpdateSnapshot) => {
      if (snapshot.phase === 'downloading') progress.push(snapshot.receivedBytes ?? 0)
    })
    const snapshot = await updater.download()

    expect(snapshot.phase).toBe('ready')
    expect(snapshot.downloadPath).toBe(join(userDataDir, 'updates', ASSET_NAME))
    expect(snapshot.receivedBytes).toBe(IMAGE.byteLength)
    expect(snapshot.totalBytes).toBe(IMAGE.byteLength)
    // The release published a digest for this asset, so it was confirmed.
    expect(snapshot.reason).toBeUndefined()
    expect(progress).toContain(IMAGE.byteLength)
    expect((await stat(snapshot.downloadPath!)).size).toBe(IMAGE.byteLength)
  })

  it('says an image was not confirmed when the release publishes no digest', async () => {
    const updater = withFeed(feedWithNewerRelease())
    await updater.load()
    await updater.check()

    const snapshot = await updater.download()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.reason).toContain('publishes no digest')
  })

  it('reports a download it cannot finish instead of a ready image', async () => {
    const requested: string[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(IMAGE)
        controller.error(new Error('connection reset'))
      },
    })
    const updater = new AppUpdater({
      version: '0.1.4',
      arch: 'arm64',
      installable: true,
      userDataDir,
      token: () => Promise.resolve('a-token'),
      fetchImpl: (input) => {
        const url = String(input)
        requested.push(url)
        if (url.includes('/releases')) {
          return Promise.resolve(new Response(JSON.stringify(feedWithNewerRelease()), { status: 200 }))
        }
        return Promise.resolve(new Response(stream, { status: 200 }))
      },
    })
    await updater.load()
    await updater.check()

    const snapshot = await updater.download()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.reason).toContain('did not finish')
    expect(snapshot.downloadPath).toBeUndefined()
  })

  it('refuses to download before a release has been chosen', async () => {
    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()
    await updater.check()

    const snapshot = await updater.download()
    expect(snapshot.phase).toBe('idle')
    expect(snapshot.downloadPath).toBeUndefined()
  })

  it('runs one download when two are asked for at once', async () => {
    let downloads = 0
    const updater = new AppUpdater({
      version: '0.1.4',
      arch: 'arm64',
      installable: true,
      userDataDir,
      token: () => Promise.resolve('a-token'),
      fetchImpl: (input) => {
        const url = String(input)
        if (url.includes('/releases')) {
          return Promise.resolve(new Response(JSON.stringify(feedWithNewerRelease()), { status: 200 }))
        }
        downloads += 1
        return Promise.resolve(new Response(imageBody(), {
          status: 200,
          headers: { 'content-length': String(IMAGE.byteLength) },
        }))
      },
    })
    await updater.load()
    await updater.check()

    const [first, second] = await Promise.all([updater.download(), updater.download()])
    expect(downloads).toBe(1)
    expect(first.phase).toBe('ready')
    expect(second.phase).toBe('ready')
  })
})

describe('AppUpdater skip', () => {
  it('stops offering the version the check found', async () => {
    const updater = withFeed(feedWithNewerRelease())
    await updater.load()
    await updater.check()

    const snapshot = await updater.skipVersion()
    expect(snapshot.skipped).toBe(true)
    // The choice outlives this run, so a restart does not raise it again.
    const record = JSON.parse(await readFile(join(userDataDir, 'skipped-update.json'), 'utf8')) as {
      schemaVersion: number
      version: string
    }
    expect(record.schemaVersion).toBe(1)
    expect(record.version).toBe('0.1.5')
  })

  it('keeps the skipped version skipped across a restart', async () => {
    const first = withFeed(feedWithNewerRelease())
    await first.load()
    await first.check()
    await first.skipVersion()

    const second = withFeed(feedWithNewerRelease())
    await second.load()
    const snapshot = await second.check()
    expect(snapshot.phase).toBe('available')
    expect(snapshot.skipped).toBe(true)
  })

  it('offers a release strictly newer than the skipped one', async () => {
    const first = withFeed(feedWithNewerRelease())
    await first.load()
    await first.check()
    await first.skipVersion()

    const second = withFeed([feedRelease('v0.1.6')])
    await second.load()
    const snapshot = await second.check()
    expect(snapshot.phase).toBe('available')
    expect(snapshot.latestVersion).toBe('0.1.6')
    expect(snapshot.skipped).toBe(false)
  })
})

describe('AppUpdater install reconciliation', () => {
  it('reports an install that landed on this version', async () => {
    // The app comes back on the version the installer replaced it with, which is
    // the only evidence in this process that the install worked.
    await mkdir(join(userDataDir, 'update'), { recursive: true })
    await writeFile(join(userDataDir, 'update', 'last-install.json'), JSON.stringify({
      schemaVersion: 1,
      fromVersion: '0.1.4',
      toVersion: '0.1.4',
      appBundle: '/Applications/DSH Desktop.app',
      logPath: '/tmp/update.log',
      startedAt: Date.now(),
    }), 'utf8')

    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    expect(updater.state().reason).toBe('installed 0.1.4, and this build is running it')
    // The record is spent, so a later run cannot report the same install twice.
    await expect(readFile(join(userDataDir, 'update', 'last-install.json'), 'utf8')).rejects.toThrow()
  })

  it('reports an install that did not land', async () => {
    await mkdir(join(userDataDir, 'update'), { recursive: true })
    await writeFile(join(userDataDir, 'update', 'last-install.json'), JSON.stringify({
      schemaVersion: 1,
      fromVersion: '0.1.4',
      toVersion: '0.1.5',
      appBundle: '/Applications/DSH Desktop.app',
      logPath: '/tmp/update.log',
      startedAt: Date.now() - 120_000,
    }), 'utf8')

    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    expect(updater.state().reason).toBe(
      'an install of 0.1.5 did not complete, and this build is still 0.1.4. '
      + 'Its log is at /tmp/update.log',
    )
  })

  it('waits before reporting an install this run launched', async () => {
    // A record written moments ago belongs to an install that is still working,
    // and reporting it as failed would be wrong while it runs.
    await mkdir(join(userDataDir, 'update'), { recursive: true })
    await writeFile(join(userDataDir, 'update', 'last-install.json'), JSON.stringify({
      schemaVersion: 1,
      fromVersion: '0.1.4',
      toVersion: '0.1.5',
      appBundle: '/Applications/DSH Desktop.app',
      logPath: '/tmp/update.log',
      startedAt: Date.now(),
    }), 'utf8')

    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    expect(updater.state().reason).toBeUndefined()
  })

  it('removes a part file an interrupted download left behind', async () => {
    await mkdir(join(userDataDir, 'updates'), { recursive: true })
    await writeFile(join(userDataDir, 'updates', `${ASSET_NAME}.part`), 'half an image', 'utf8')

    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    await expect(readFile(join(userDataDir, 'updates', `${ASSET_NAME}.part`), 'utf8')).rejects.toThrow()
  })

  it('ignores a record it cannot read rather than failing to start', async () => {
    await mkdir(join(userDataDir, 'update'), { recursive: true })
    await writeFile(join(userDataDir, 'update', 'last-install.json'), 'not json', 'utf8')

    const updater = withFeed([feedRelease('v0.1.4')])
    await updater.load()

    expect(updater.state().phase).toBe('idle')
    expect(updater.state().reason).toBeUndefined()
  })
})
