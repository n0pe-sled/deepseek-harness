/**
 * Gated live test: drives the REAL sandbox launcher against the REAL container
 * runtime, mirroring the handoff's phase-1 gate. Skipped unless
 * `DSH_SANDBOX_PROBE=1`. The instance is fully isolated: its DSH_HOME is a
 * fresh temp directory, never the user's real one.
 *
 *   DSH_SANDBOX_PROBE=1 pnpm vitest run tests/unit/sandbox-launch.integration.test.ts
 *
 * To cover the case the launcher's PATH widening exists for, a Finder launch
 * where docker is installed but absent from PATH, run the gate under launchd's PATH:
 *
 *   env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" DSH_SANDBOX_PROBE=1 \
 *     "$(command -v node)" ./node_modules/vitest/vitest.mjs run \
 *     tests/unit/sandbox-launch.integration.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { containerName, resolveSandboxOptions, startSandboxedDsh } from '../../src/main/instances/sandbox.ts'
import { containerPath, findExecutable } from '../../src/main/instances/exec-path.ts'

const GATED = process.env.DSH_SANDBOX_PROBE === '1'
/** Image under test: the published one by default, or a locally built tag. */
const IMAGE = process.env.DSH_SANDBOX_IMAGE ?? 'ghcr.io/n0pe-sled/dsh-sandbox:latest'
const d = GATED ? describe : describe.skip

d('sandbox launch (live, gated)', () => {
  const instanceId = `e2e-${Date.now().toString(36)}`
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-sandbox-e2e-'))
  const logs: string[] = []
  let endpoint: string | undefined
  let stop: (() => Promise<void>) | undefined

  afterAll(async () => {
    await stop?.()
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('boots the container, reports a loopback endpoint, and serves describe', async () => {
    const handle = await startSandboxedDsh({
      name: containerName(instanceId),
      sandbox: { ...resolveSandboxOptions({ image: IMAGE }), dshHome },
      log: (line) => logs.push(line),
    })
    endpoint = handle.endpoint
    stop = handle.stop
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    // The published relay serves the real GUI: this is the gate a plain port
    // publish fails (connection reset) when the relay is missing.
    const page = await fetch(`${endpoint}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>')

    // A tokenless API call answers 200 through the published loopback port, so
    // the harness trust fence is satisfied exactly as it is over the ssh
    // tunnel — settings and privileged methods work with no token machinery.
    const response = await fetch(`${endpoint}/api/host.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-1', method: 'host.describe', payload: {} }),
    })
    expect(response.status).toBe(200)
  }, 240_000)

  it('stops the container so nothing is left holding the port', async () => {
    if (endpoint === undefined || stop === undefined) throw new Error('the launch test did not run')
    await stop()
    // Gone, not merely stopped: `docker rm -f` is what stop does, so a
    // reconnect can never adopt a half-dead container.
    const docker = findExecutable('docker', containerPath(process.env.PATH ?? '', process.env.HOME))
    expect(docker).toBeDefined()
    const inspect = spawnSync(docker ?? 'docker', ['inspect', '--format', '{{.State.Status}}', containerName(instanceId)], { encoding: 'utf8' })
    // The command must have run: a failed lookup would pass the next assertion
    // for the wrong reason.
    expect(inspect.error).toBeUndefined()
    expect(inspect.status).not.toBe(0)
  })
})
