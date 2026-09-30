/** SSH provisioning must boot with no system Node and reject incomplete runtime transfers. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nodeDistribution, verifyNodeArchive } from '../../scripts/stage-node.ts'
import { buildExtractCommand, buildLaunchCommand } from '../../src/main/instances/provision-parse.ts'
import { RemoteProvisioner } from '../../src/main/instances/provision.ts'
import { harnessCacheKey, parseTarget } from '../../src/shared/harness-target.ts'
import type { SshOptions } from '../../src/shared/instance.ts'

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-node-test-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('bundled Node', () => {
  it('selects distinct official archives for each supported target and rejects musl', () => {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc']) {
      expect(nodeDistribution(parseTarget(target)).sha256).toMatch(/^[a-f0-9]{64}$/u)
    }
    expect(() => nodeDistribution(parseTarget('linux-x64-musl'))).toThrow('no bundled Node')
    const bytes = Buffer.from('archive')
    verifyNodeArchive(bytes, createHash('sha256').update(bytes).digest('hex'))
    expect(() => verifyNodeArchive(Buffer.from('corrupted'), createHash('sha256').update(bytes).digest('hex'))).toThrow('SHA-256 mismatch')
  })

  it('changes remote cache identity when the runtime changes', () => {
    const target = parseTarget('linux-x64')
    expect(harnessCacheKey('1', 'abc', target, '24.21.0')).not.toBe(harnessCacheKey('1', 'abc', target))
    expect(harnessCacheKey('1', 'abc', target, '24.21.0')).not.toBe(harnessCacheKey('1', 'abc', target, '24.22.0'))
  })

  it.each([undefined, 'v18.0.0'])('accepts a host with system Node %s', (nodeVersion) => {
    const provisioner = new RemoteProvisioner({ resourcesDir: temporary(), log: vi.fn() })
    expect(() => provisioner.preflight({ platform: 'linux', arch: 'x64', homeWritable: true, nodeVersion }, { host: 'host' })).not.toThrow()
  })

  it.each([undefined, '/custom/node'])('prepares a host without system Node with override %s', async (nodePath) => {
    const resources = temporary()
    const closure = join(resources, 'harness-linux')
    mkdirSync(join(closure, 'lib'), { recursive: true })
    mkdirSync(join(closure, 'bin'))
    writeFileSync(join(closure, 'lib/bin.js'), '')
    writeFileSync(join(closure, 'bin/node'), '', { mode: 0o755 })
    writeFileSync(join(closure, 'harness-meta.json'), JSON.stringify({ version: '1', revision: 'abc', platform: 'linux', arch: 'x64', runtimeVersion: '24.21.0' }))
    const runCommand = vi.fn(async (_opts: SshOptions, command: string) => ({
      code: 0,
      stdout: command.includes('uname')
        ? 'platform=Linux\narch=x86_64\nnode=none\nwritable=yes\nhome=/home/test\n'
        : 'present',
      stderr: '',
    }))
    const provisioner = new RemoteProvisioner({ resourcesDir: resources, log: vi.fn(), runCommand })
    const launch = vi.spyOn(provisioner, 'launch').mockResolvedValue({ remotePort: 3080, reused: false })
    const result = await provisioner.prepare({ host: 'host' }, { nodePath })
    expect(launch).toHaveBeenCalledWith({ host: 'host' }, result.remoteDir, nodePath ?? `${result.remoteDir}/bin/node`)
    expect(result.closureKey).toContain('-node-24.21.0')
    expect(runCommand.mock.calls[1]?.[1]).toContain('test -x')
  })

  it('refuses to commit an extracted closure without executable Node', () => {
    const root = temporary()
    const source = join(root, 'source')
    mkdirSync(join(source, 'lib'), { recursive: true })
    mkdirSync(join(source, 'bin'))
    writeFileSync(join(source, 'lib/bin.js'), '')
    writeFileSync(join(source, 'harness-meta.json'), '{}')
    for (const executable of [false, true]) {
      writeFileSync(join(source, 'bin/node'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(source, 'bin/node'), executable ? 0o755 : 0o644)
      const archive = execFileSync('tar', ['czf', '-', '-C', root, 'source'])
      const run = () => execFileSync('/bin/sh', ['-c', buildExtractCommand(join(root, 'temp'), join(root, 'final'))], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] })
      if (executable) run()
      else expect(run).toThrow()
      expect(existsSync(join(root, 'final'))).toBe(executable)
    }
  })

  it('launches Node and a Node child with no system Node on PATH', async () => {
    const root = join(temporary(), 'host $cash "quote" space')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(root, 'lib'))
    const tools = join(root, 'tools')
    mkdirSync(tools)
    symlinkSync('/bin/sh', join(tools, 'sh'))
    // macOS has no setsid; this shim exercises the real nested shell quoting.
    writeFileSync(join(tools, 'setsid'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
    symlinkSync(process.execPath, join(root, 'bin/node'))
    writeFileSync(join(root, 'lib/bin.js'), `const {execFileSync}=require('node:child_process'); console.log(execFileSync('node',['-e','console.log("child ready")'],{encoding:'utf8'}).trim()); console.log('dsh web: http://127.0.0.1:3080');`)
    const logPath = join(root, 'dsh.log')
    execFileSync('/bin/sh', ['-c', buildLaunchCommand({ closureDir: root, nodePath: join(root, 'bin/node'), logPath, pidPath: join(root, 'dsh.pid') })], { env: { PATH: tools } })
    await vi.waitFor(() => expect(readFileSync(logPath, 'utf8')).toBe('child ready\ndsh web: http://127.0.0.1:3080\n'))
  })
})
