/** Workspace-contained, bounded file reads for local browser previews. */
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Read a regular file beneath the session workspace, rejecting symlink escapes.
 * @param cwd - authoritative session workspace.
 * @param path - relative or absolute requested file.
 * @param maxBytes - deployment's maximum file size.
 * @param signal - cancellation checked during reads.
 * @returns Base64 bytes; no content is sent to external services.
 */
export async function readPreviewFile(cwd: string, path: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const root = await realpath(cwd)
  const target = await realpath(resolve(root, path))
  const child = relative(root, target)
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Preview files must be inside the session workspace')
  }
  const file = await open(target, constants.O_RDONLY | (platform() === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const info = await file.stat()
    const confirmed = await realpath(target)
    const confirmedChild = relative(root, confirmed)
    const current = await stat(confirmed)
    if (confirmedChild === '..' || confirmedChild.startsWith(`..${sep}`) || isAbsolute(confirmedChild)
      || current.dev !== info.dev || current.ino !== info.ino) {
      throw new Error('Preview path changed while opening; retry')
    }
    if (!info.isFile()) throw new Error('Only regular files can be previewed')
    if (info.size > maxBytes) throw new Error(`Preview exceeds the ${String(maxBytes)} byte limit`)
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1))
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > maxBytes || length > info.size) throw new Error('File grew during preview; retry when writing finishes')
    return bytes.subarray(0, length).toString('base64')
  } finally {
    await file.close()
  }
}
