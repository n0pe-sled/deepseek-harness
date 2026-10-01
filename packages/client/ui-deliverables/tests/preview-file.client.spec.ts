/** Local preview reader rejects workspace escapes and unbounded files. */
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPreviewFile } from '../src/preview-file.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preview-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'report.txt'), 'hello')
  await writeFile(join(root, 'secret.txt'), 'secret')
  return { root, cwd, signal: new AbortController().signal }
}

describe('workspace preview reader', () => {
  it('reads exact-limit files without changing them', async () => {
    const { cwd, signal } = await fixture()
    expect(await readPreviewFile(cwd, 'report.txt', 5, signal)).toBe(Buffer.from('hello').toString('base64'))
  })
  it('rejects traversal, absolute escapes, and symbolic-link escapes', async () => {
    const { root, cwd, signal } = await fixture()
    await symlink(join(root, 'secret.txt'), join(cwd, 'link.txt'))
    for (const path of ['../secret.txt', join(root, 'secret.txt'), 'link.txt']) {
      await expect(readPreviewFile(cwd, path, 100, signal)).rejects.toThrow('inside the session workspace')
    }
  })
  it.skipIf(platform() === 'win32')('rejects FIFOs without waiting for a writer', async () => {
    const { cwd, signal } = await fixture()
    execFileSync('mkfifo', [join(cwd, 'pipe')])
    await expect(readPreviewFile(cwd, 'pipe', 100, signal)).rejects.toThrow('regular files')
  })
  it('rejects oversized files, directories, and cancelled reads', async () => {
    const { cwd, signal } = await fixture()
    await expect(readPreviewFile(cwd, 'report.txt', 4, signal)).rejects.toThrow('byte limit')
    await mkdir(join(cwd, 'dir'))
    await expect(readPreviewFile(cwd, 'dir', 100, signal)).rejects.toThrow('regular files')
    await expect(readPreviewFile(cwd, 'report.txt', 100, AbortSignal.abort())).rejects.toThrow()
  })
})
