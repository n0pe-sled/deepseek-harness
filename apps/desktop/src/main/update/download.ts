/**
 * Downloading one release's disk image and recording its digest.
 *
 * The image is streamed into a partial file and renamed only once it is complete,
 * so an interrupted download can never be mistaken for one ready to install. If a
 * digest is known, the rename waits for it: a partially written or replaced image
 * is refused rather than handed to the installer.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReleaseAsset } from './types.ts'

/**
 * Ceiling on one download. The image is roughly 175 MB, so a response an order of
 * magnitude past that is a runaway rather than a release.
 */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** How long a download may stall before it is cut off. */
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** What one completed download produced. */
export interface DownloadResult {
  path: string
  bytes: number
  /** Digest of the bytes on disk, always computed. */
  sha256: string
  /**
   * Whether `sha256` was compared against a digest the release publishes. False
   * means the image was read end to end but nothing external confirmed it.
   */
  verified: boolean
}

/**
 * Download a release asset to `dest`.
 *
 * @param options - the asset, where to put it, an optional token and expected
 *   digest, an injectable fetch, and a progress callback.
 * @returns what landed on disk and whether it was confirmed against a digest.
 * @throws when the response fails, when the body is truncated, when it exceeds
 *   {@link MAX_DOWNLOAD_BYTES}, or when the bytes do not match `expectedSha256`.
 *   Every failure removes the partial file.
 */
export async function downloadAsset(options: {
  asset: ReleaseAsset
  dest: string
  token?: string
  expectedSha256?: string
  fetchImpl?: typeof fetch
  onProgress?: (received: number, total: number) => void
}): Promise<DownloadResult> {
  const { asset, dest } = options
  const doFetch = options.fetchImpl ?? fetch
  const part = `${dest}.part`
  const expected = options.expectedSha256?.toLowerCase()

  await mkdir(dirname(dest), { recursive: true })
  await rm(part, { force: true })

  const headers: Record<string, string> = { accept: 'application/octet-stream' }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`

  let response: Response
  try {
    response = await doFetch(asset.url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`could not reach the download for ${asset.name}: ${cause}`)
  }
  if (!response.ok) {
    throw new Error(`download of ${asset.name} failed: HTTP ${String(response.status)}`)
  }
  if (response.body === null) {
    throw new Error(`download of ${asset.name} returned no body`)
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  const total = Number.isFinite(declared) && declared > 0 ? declared : (asset.size ?? 0)
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${asset.name} is ${String(total)} bytes, past the ${String(MAX_DOWNLOAD_BYTES)} byte limit`)
  }

  const hash = createHash('sha256')
  let received = 0
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          received += chunk.byteLength
          if (received > MAX_DOWNLOAD_BYTES) {
            throw new Error(`${asset.name} exceeded ${String(MAX_DOWNLOAD_BYTES)} bytes`)
          }
          hash.update(chunk)
          options.onProgress?.(received, total)
          yield chunk
        }
      },
      createWriteStream(part),
    )
  } catch (error) {
    // Nothing usable can come of a partial image, so it goes away here rather
    // than being left for a later run to find and install.
    await rm(part, { force: true })
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`download of ${asset.name} did not finish: ${cause}`)
  }

  const sha256 = hash.digest('hex')
  if (expected !== undefined && expected !== sha256) {
    await rm(part, { force: true })
    throw new Error(
      `${asset.name} did not match the digest the release publishes: `
      + `expected ${expected}, read ${sha256}`,
    )
  }

  const sized = await sizeOf(part)
  if (total > 0 && sized !== total) {
    await rm(part, { force: true })
    throw new Error(
      `${asset.name} arrived truncated: expected ${String(total)} bytes, read ${String(sized)}`,
    )
  }

  await rename(part, dest)
  return { path: dest, bytes: sized, sha256, verified: expected !== undefined }
}

/** Size of a file in bytes. */
async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size
}

/** Size of a local file in bytes, or undefined when it is not there. */
export async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    // A file that is not there has no size, which is the caller's answer too.
    return undefined
  }
}

/**
 * Digest of a file already on disk, so a later run can compare it against what
 * the release publishes.
 *
 * @param path - the file to read.
 * @returns the SHA-256 digest as lowercase hex.
 */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}
