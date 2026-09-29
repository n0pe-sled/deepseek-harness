/**
 * Downloading the image, and what the app knows about the bytes afterward.
 *
 * An image that arrived truncated or was never confirmed against a digest the
 * release publishes must not be handed to the installer, and a failed download must
 * leave nothing behind for a later run to find and install.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadAsset, fileSize, MAX_DOWNLOAD_BYTES, sha256Of } from '../../src/main/update/download.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-download-'))
  dirs.push(dir)
  return dir
}

/** A response that streams the given chunks and reports the given length. */
function streamingResponse(chunks: readonly Uint8Array[], declaredLength?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: declaredLength === undefined ? {} : { 'content-length': String(declaredLength) },
  })
}

const ASSET = { name: 'DSH Desktop-0.1.5-arm64.dmg', url: 'https://example.test/a.dmg', size: 8 }
const IMAGE = new TextEncoder().encode('an-image')

/** The digest of the bytes the download cases serve. */
const IMAGE_SHA256 = createHash('sha256').update(IMAGE).digest('hex')

describe('downloadAsset', () => {
  it('writes the image and answers its digest', async () => {
    const dest = join(await tempDir(), ASSET.name)
    const result = await downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })
    expect(result.path).toBe(dest)
    expect(result.bytes).toBe(IMAGE.byteLength)
    expect(result.sha256).toBe(IMAGE_SHA256)
    expect(await readFile(dest, 'utf8')).toBe('an-image')
    // Nothing external confirmed these bytes, and the answer has to say so.
    expect(result.verified).toBe(false)
  })

  it('leaves no partial file behind once the image lands', async () => {
    const dir = await tempDir()
    const dest = join(dir, ASSET.name)
    await downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })
    expect(await fileSize(`${dest}.part`)).toBeUndefined()
  })

  it('reports whether the release confirmed the bytes', async () => {
    const dest = join(await tempDir(), ASSET.name)
    const result = await downloadAsset({
      asset: ASSET,
      dest,
      expectedSha256: IMAGE_SHA256,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })
    expect(result.verified).toBe(true)
  })

  it('ignores case in a published digest', async () => {
    const dest = join(await tempDir(), ASSET.name)
    const result = await downloadAsset({
      asset: ASSET,
      dest,
      expectedSha256: IMAGE_SHA256.toUpperCase(),
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })
    expect(result.verified).toBe(true)
  })

  it('refuses bytes that do not match the published digest', async () => {
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      expectedSha256: 'f'.repeat(64),
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })).rejects.toThrow(/did not match the digest the release publishes/u)
    // A mismatched image is worse than no image, so it goes away.
    expect(await fileSize(`${dest}.part`)).toBeUndefined()
    expect(await fileSize(dest)).toBeUndefined()
  })

  it('refuses an image that arrived truncated', async () => {
    // A short body is how an interrupted transfer presents itself, and the
    // declared length is the only evidence that it was short.
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE.slice(0, 4)], IMAGE.byteLength)),
    })).rejects.toThrow(/arrived truncated: expected 8 bytes, read 4/u)
    expect(await fileSize(`${dest}.part`)).toBeUndefined()
  })

  it('refuses a body longer than the declared length', async () => {
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE, IMAGE], IMAGE.byteLength)),
    })).rejects.toThrow(/arrived truncated/u)
  })

  it('aborts a body past the download ceiling', async () => {
    const dest = join(await tempDir(), ASSET.name)
    const oversized = new Uint8Array(MAX_DOWNLOAD_BYTES + 1)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([oversized], oversized.byteLength)),
    })).rejects.toThrow(/past the 1073741824 byte limit/u)
  })

  it('removes the partial file when the stream fails midway', async () => {
    const dir = await tempDir()
    const dest = join(dir, ASSET.name)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(IMAGE)
        controller.error(new Error('connection reset'))
      },
    })
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
    })).rejects.toThrow(/did not finish: connection reset/u)
    expect(await fileSize(`${dest}.part`)).toBeUndefined()
  })

  it('removes a partial file left by an earlier run before it starts', async () => {
    const dir = await tempDir()
    const dest = join(dir, ASSET.name)
    await writeFile(`${dest}.part`, 'stale half-image', 'utf8')
    await downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength)),
    })
    expect(await readFile(dest, 'utf8')).toBe('an-image')
  })

  it('names the HTTP status when the download is refused', async () => {
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 403 })),
    })).rejects.toThrow(`download of ${ASSET.name} failed: HTTP 403`)
  })

  it('names the network cause when the request never lands', async () => {
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    })).rejects.toThrow(`could not reach the download for ${ASSET.name}: getaddrinfo ENOTFOUND`)
  })

  it('refuses a success response that carries no body', async () => {
    const dest = join(await tempDir(), ASSET.name)
    await expect(downloadAsset({
      asset: ASSET,
      dest,
      fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    })).rejects.toThrow(`download of ${ASSET.name} returned no body`)
  })

  it('sends the token as an authorization header and nothing else', async () => {
    let seen: RequestInit | undefined
    const dest = join(await tempDir(), ASSET.name)
    await downloadAsset({
      asset: ASSET,
      dest,
      token: 'secret-token',
      fetchImpl: (_url, init) => {
        seen = init
        return Promise.resolve(streamingResponse([IMAGE], IMAGE.byteLength))
      },
    })
    const headers = seen?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(headers.accept).toBe('application/octet-stream')
  })
})

describe('sha256Of', () => {
  it('reads the digest of a file on disk', async () => {
    const path = join(await tempDir(), 'image.bin')
    await writeFile(path, IMAGE)
    expect(await sha256Of(path)).toBe(IMAGE_SHA256)
  })
})

describe('fileSize', () => {
  it('answers undefined for a file that is not there', async () => {
    expect(await fileSize(join(await tempDir(), 'absent.bin'))).toBeUndefined()
  })
})
