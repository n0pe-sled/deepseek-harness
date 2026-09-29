/**
 * Live remote provisioning against a real SSH host.
 *
 * Disabled by default: it needs a host, a key, and about 300MB of free space
 * there. Enable it with `DSH_REMOTE_PROBE=1` plus the connection details, for
 * example against a Linux container:
 *
 *   DSH_REMOTE_PROBE=1 DSH_PROBE_HOST=127.0.0.1 DSH_PROBE_PORT=2222 \
 *   DSH_PROBE_USER=root DSH_PROBE_KEY=/path/to/key pnpm vitest run tests/unit/remote-provision.integration.test.ts
 *
 * It is a test rather than a script because the parts worth guarding are the
 * ones that fail silently: that a reconnect reuses the running server, that a
 * stopped server is not reported as reusable, that uninstall leaves nothing
 * behind, and above all that no path here reaches a registry.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { InstanceManager } from '../../src/main/instances/manager.ts'
import { InstanceStore } from '../../src/main/instances/store.ts'
import { RemoteProvisioner } from '../../src/main/instances/provision.ts'

const enabled = process.env.DSH_REMOTE_PROBE === '1'
const PROBE_HOST = process.env.DSH_PROBE_HOST ?? '127.0.0.1'
const PROBE_PORT = Number.parseInt(process.env.DSH_PROBE_PORT ?? '22', 10)
const PROBE_USER = process.env.DSH_PROBE_USER ?? ''
const PROBE_KEY = process.env.DSH_PROBE_KEY ?? ''
const RESOURCES = process.env.DSH_PROBE_RESOURCES ?? 'resources'
const REMOTE_ROOT = process.env.DSH_PROBE_ROOT ?? '.dsh-desktop-probe/harness'

const sshOptions = {
  host: PROBE_HOST,
  port: PROBE_PORT,
  ...(PROBE_USER === '' ? {} : { user: PROBE_USER }),
  ...(PROBE_KEY === '' ? {} : { identityFile: PROBE_KEY }),
  strictHostKeyChecking: 'accept-new' as const,
  provision: { remoteRoot: REMOTE_ROOT },
}

/** Run one remote command in the probe, outside the code under test. */
function remote(command: string): string {
  return execFileSync('ssh', [
    ...(PROBE_KEY === '' ? [] : ['-i', PROBE_KEY]),
    '-p', String(PROBE_PORT),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${PROBE_USER === '' ? '' : `${PROBE_USER}@`}${PROBE_HOST}`,
    command,
  ], { encoding: 'utf8' }).trim()
}

const userDataDirs: string[] = []

afterAll(async () => {
  if (!enabled) return
  // Never leave a server or a closure behind on the probe host.
  try {
    const provisioner = new RemoteProvisioner({ resourcesDir: RESOURCES, log: () => undefined })
    const { target, root } = await provisioner.detect(sshOptions, sshOptions.provision)
    const entry = provisioner.selectClosure(target)
    await provisioner.uninstall(sshOptions, `${root}/${entry.key}`)
  } catch {
    // Best-effort cleanup: a failure here must not mask a test result.
  }
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!enabled)('live remote provisioning', () => {
  // A cold run ships about 40MB and starts a server, so the vitest default of
  // 5s is far too tight; each test states its own budget instead.
  const SHIP_TIMEOUT_MS = 300_000

  it('detects the host and preflights it', async () => {
    const provisioner = new RemoteProvisioner({ resourcesDir: RESOURCES, log: () => undefined })
    const { facts, target, root } = await provisioner.detect(sshOptions, sshOptions.provision)
    expect(facts.platform).toBe('linux')
    expect(facts.libc).toBe('glibc')
    expect(target.platform).toBe('linux')
    expect(root.startsWith('/')).toBe(true)
    // Preflight must not throw on a host this test is willing to use.
    expect(() => { provisioner.preflight(facts, sshOptions) }).not.toThrow()
  }, 60_000)

  it('ships, launches, and reports the fork revision and target', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
    userDataDirs.push(userData)
    const store = new InstanceStore(userData)
    const manager = new InstanceManager(store, async () => ({ version: 'probe' }), { resourcesDir: RESOURCES })
    await manager.load()

    const view = manager.addSsh({ name: 'probe', ssh: sshOptions })
    await manager.connect(view.config.id)

    const runtime = manager.views().find((v) => v.config.id === view.config.id)?.runtime
    expect(runtime?.status).toBe('running')
    // The whole point of showing the revision: it is what distinguishes the
    // fork from upstream, which publishes the same version string.
    expect(runtime?.revision).toMatch(/^[0-9a-f]{7,40}$/u)
    expect(runtime?.origin?.provisioned).toBe(true)
    expect(runtime?.origin?.target).toBe('linux-x64-glibc')

    const endpoint = manager.endpointOf(view.config.id)
    expect(endpoint).toBeDefined()
    // A loopback tunnel terminus: the GUI has to answer, and the trust fence
    // has to let a tokenless API call through.
    const page = await fetch(endpoint as string)
    expect(page.status).toBe(200)
    const describe = await fetch(`${endpoint as string}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 't', method: 'host.describe', payload: {} }),
      signal: AbortSignal.timeout(8000),
    })
    expect(describe.status).toBe(200)
    const body = (await describe.json()) as { result?: { ok?: boolean } }
    expect(body.result?.ok).toBe(true)

    await manager.stopAll()
  }, SHIP_TIMEOUT_MS)

  it('reuses a running server on reconnect and starts a fresh one after a stop', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
    userDataDirs.push(userData)
    const store = new InstanceStore(userData)
    const manager = new InstanceManager(store, async () => ({ version: 'probe' }), { resourcesDir: RESOURCES })
    await manager.load()
    const view = manager.addSsh({ name: 'probe', ssh: sshOptions })

    await manager.connect(view.config.id)
    const firstEndpoint = manager.endpointOf(view.config.id)

    // A stopped-then-restarted instance adopts the live server rather than
    // starting a second one, which is what keeps ports from accumulating.
    await manager.stop(view.config.id)
    await manager.connect(view.config.id)
    const restarted = manager.views().find((v) => v.config.id === view.config.id)?.runtime
    expect(restarted?.error ?? 'no error', 'reconnect after stop').toBe('no error')
    expect(restarted?.status, 'reconnect after stop').toBe('running')

    await manager.stopRemoteServer(view.config.id)
    const running = remote('pgrep -c -f "bin[.]js web" || true')
    expect(running === '' || running === '0').toBe(true)

    // With nothing running, connecting has to start one again rather than
    // reporting a stale success against a dead port.
    await manager.connect(view.config.id)
    const fresh = manager.views().find((v) => v.config.id === view.config.id)?.runtime
    expect(fresh?.error ?? 'no error', 'reconnect after remote stop').toBe('no error')
    expect(fresh?.status, 'reconnect after remote stop').toBe('running')
    expect(manager.endpointOf(view.config.id)).not.toBe(firstEndpoint)

    await manager.uninstallRemote(view.config.id)
    await manager.stopAll()
  }, SHIP_TIMEOUT_MS)

  it('uninstall removes the remote directory and leaves no temp behind', async () => {
    const provisioner = new RemoteProvisioner({ resourcesDir: RESOURCES, log: () => undefined })
    const { target, root } = await provisioner.detect(sshOptions, sshOptions.provision)
    const entry = provisioner.selectClosure(target)
    const dir = `${root}/${entry.key}`
    await provisioner.uninstall(sshOptions, dir)
    expect(remote(`test -e ${dir} && echo present || echo gone`)).toBe('gone')
    // `find`, not `ls -d <glob>`: ls echoes the literal pattern when it matches
    // nothing, which would read as a leftover temp directory forever.
    expect(remote(`find ${dir}.tmp -maxdepth 0 2>/dev/null | wc -l | tr -d ' '`)).toBe('0')
  }, 120_000)
})

describe.skipIf(!enabled)('the no-registry property', () => {
  it('never names a package registry in the provisioning sources', async () => {
    // A silent npm fallback would install upstream code under a version string
    // that looks correct, so the absence of any registry path is asserted
    // rather than trusted.
    const { readFileSync, readdirSync } = await import('node:fs')
    const dir = 'src/main/instances'
    const sources = readdirSync(dir).filter((name) => name.endsWith('.ts'))
    expect(sources.length).toBeGreaterThan(0)
    for (const name of sources) {
      const text = readFileSync(join(dir, name), 'utf8')
      // Strip comments: the constraint is documented in prose, and prose is
      // allowed to name what the code must not do.
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
      expect(code, `${name} must not install from a registry`).not.toMatch(/npm\s+(install|i|add|ci)\b/u)
      expect(code, `${name} must not shell out to a registry`).not.toMatch(/['"]@deepseek-ai\/dsh['"]\s*@/u)
    }
  })
})
