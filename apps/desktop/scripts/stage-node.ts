/** Download the target's pinned Node distribution and retain its executable and license. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatTarget, type StageTarget } from '../src/shared/harness-target.ts'

/** Official release pinned alongside its SHA-256 digests from nodejs.org/dist. */
export const NODE_VERSION = '24.21.0'
const CHECKSUMS: Record<string, string> = {
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-arm64-glibc': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'linux-x64-glibc': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
}

/**
 * Reject unsupported targets before fetching an archive.
 * @param target - Operating system, architecture, and libc to package.
 * @returns The official archive basename and pinned SHA-256 digest.
 */
export function nodeDistribution(target: StageTarget): { name: string; sha256: string } {
  const sha256 = CHECKSUMS[formatTarget(target)]
  if (sha256 === undefined) throw new Error(`no bundled Node runtime for ${formatTarget(target)}`)
  return { name: `node-v${NODE_VERSION}-${target.platform}-${target.arch}`, sha256 }
}

/**
 * Verify downloaded bytes before passing them to tar; throw on mismatch.
 * @param bytes - Complete downloaded archive.
 * @param expected - Pinned hexadecimal SHA-256 digest.
 */
export function verifyNodeArchive(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Node runtime archive SHA-256 mismatch')
  }
}

/**
 * Stage bin/node and the upstream license without executing the target binary.
 * @param target - Target of the containing harness payload.
 * @param output - Directory receiving bin/node and NODE-LICENSE.
 * @returns Resolves after verified extraction and copying; rejects on download or filesystem failure.
 */
export async function stageNode(target: StageTarget, output: string): Promise<void> {
  const { name, sha256 } = nodeDistribution(target)
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  verifyNodeArchive(bytes, sha256)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-node-'))
  try {
    const archive = join(scratch, 'node.tar.gz')
    writeFileSync(archive, bytes)
    execFileSync('tar', ['xzf', archive, '-C', scratch, `${name}/bin/node`, `${name}/LICENSE`])
    mkdirSync(join(output, 'bin'), { recursive: true })
    cpSync(join(scratch, name, 'bin/node'), join(output, 'bin/node'))
    chmodSync(join(output, 'bin/node'), 0o755)
    cpSync(join(scratch, name, 'LICENSE'), join(output, 'NODE-LICENSE'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
