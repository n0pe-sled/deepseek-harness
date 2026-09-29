/**
 * Sandbox command construction, without a container daemon: the argv ordering
 * rule (app flags, then user args, then image), the built-in defaults, the
 * port parser, runtime detection against fake CLIs, and the remote launch
 * command's shape.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildDockerRunArgs,
  buildRemoteSandboxCommand,
  containerName,
  detectRuntime,
  noRuntimeMessage,
  parseDockerPort,
  resolveSandboxOptions,
} from '../../src/main/instances/sandbox.ts'
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_RELAY_PORT } from '../../src/shared/instance.ts'

const BASE = resolveSandboxOptions(undefined)

describe('resolveSandboxOptions', () => {
  it('defaults to enabled with the published image', () => {
    expect(BASE.enabled).toBe(true)
    expect(BASE.image).toBe(DEFAULT_SANDBOX_IMAGE)
    expect(BASE.image).toContain('ghcr.io/n0pe-sled/dsh-sandbox')
  })

  it('the explicit opt-out is the only path to disabled', () => {
    expect(resolveSandboxOptions({ enabled: false }).enabled).toBe(false)
    expect(resolveSandboxOptions({ enabled: true }).enabled).toBe(true)
    expect(resolveSandboxOptions({}).enabled).toBe(true)
    expect(resolveSandboxOptions(undefined).enabled).toBe(true)
  })

  it('defaults outbound network on and mounts to /workspace', () => {
    const resolved = resolveSandboxOptions({ mounts: [{ hostPath: '/tmp/ws' }], outboundNetwork: false })
    expect(resolved.outboundNetwork).toBe(false)
    expect(resolved.mounts).toEqual([{ hostPath: '/tmp/ws', containerPath: '/workspace', readOnly: false }])
  })
})

describe('buildDockerRunArgs', () => {
  it('publishes the relay port on loopback and binds /data for DSH_HOME', () => {
    const args = buildDockerRunArgs(BASE, 'dsh-sandbox-i1', 40404)
    expect(args.slice(0, 3)).toEqual(['run', '-d', '--name'])
    expect(args).toContain('dsh-sandbox-i1')
    expect(args).toContain(`127.0.0.1:40404:${String(SANDBOX_RELAY_PORT)}`)
    // The image is the LAST argv token: anything after it would silently
    // replace the container command.
    expect(args.at(-1)).toBe(DEFAULT_SANDBOX_IMAGE)
  })

  it('appends user runArgs before the image so they can override deliberately', () => {
    const resolved = resolveSandboxOptions({ runArgs: ['--memory', '2g'] })
    const args = buildDockerRunArgs(resolved, 'dsh-sandbox-i1', 40404)
    expect(args.slice(-3)).toEqual(['--memory', '2g', DEFAULT_SANDBOX_IMAGE])
  })

  it('maps outboundNetwork off to --network none', () => {
    const args = buildDockerRunArgs(resolveSandboxOptions({ outboundNetwork: false }), 'n', 1)
    const network = args.indexOf('--network')
    expect(network).toBeGreaterThan(-1)
    expect(args[network + 1]).toBe('none')
  })

  it('mounts the dsh home and declared mounts read-write by default', () => {
    const resolved = resolveSandboxOptions({
      dshHome: '/home/secret',
      mounts: [{ hostPath: '/tmp/ws', readOnly: true }],
    })
    const args = buildDockerRunArgs(resolved, 'n', 1)
    expect(args).toContain('/home/secret:/data')
    expect(args).toContain('/tmp/ws:/workspace:ro')
  })
})

describe('parseDockerPort', () => {
  it('reads the host port from the relay line', () => {
    expect(parseDockerPort('3081/tcp -> 127.0.0.1:64081\n', SANDBOX_RELAY_PORT)).toBe(64081)
    expect(parseDockerPort('3081/tcp -> 0.0.0.0:64081', SANDBOX_RELAY_PORT)).toBe(64081)
  })

  it('reads the bare form docker prints when a port argument is given', () => {
    // Verified against Docker: `docker port <name> 3081` prints just the address.
    expect(parseDockerPort('127.0.0.1:64712\n', SANDBOX_RELAY_PORT)).toBe(64712)
    expect(parseDockerPort('[::1]:64712', SANDBOX_RELAY_PORT)).toBe(64712)
  })

  it('ignores other ports and garbage', () => {
    expect(parseDockerPort('3000/tcp -> 127.0.0.1:3000', SANDBOX_RELAY_PORT)).toBeUndefined()
    expect(parseDockerPort('', SANDBOX_RELAY_PORT)).toBeUndefined()
    expect(parseDockerPort('Error: No public port', SANDBOX_RELAY_PORT)).toBeUndefined()
  })
})

describe('buildRemoteSandboxCommand', () => {
  it('pulls, replaces, runs, and reports the relay port — in one shell', () => {
    const command = buildRemoteSandboxCommand({
      name: 'dsh-sandbox-i1',
      image: DEFAULT_SANDBOX_IMAGE,
      remoteDshHome: '/home/me/.dsh-desktop/sandboxes',
      runArgs: [],
      outboundNetwork: true,
    })
    expect(command).toContain("docker pull '")
    expect(command).toContain("docker rm -f 'dsh-sandbox-i1'")
    expect(command).toContain(`--publish 127.0.0.1::${String(SANDBOX_RELAY_PORT)}`)
    expect(command).toContain('docker port')
    // The remote home is bind-mounted as the container's /data (quoted, since
    // a path with spaces must survive the remote shell as one token).
    expect(command).toContain("'/home/me/.dsh-desktop/sandboxes':/data")
  })

  it('refuses nothing but quotes everything: args survive as single argv tokens', () => {
    const command = buildRemoteSandboxCommand({
      name: "dsh-sandbox-x'); evil",
      image: DEFAULT_SANDBOX_IMAGE,
      remoteDshHome: '/home/m e',
      runArgs: ['--memory', '2g'],
      outboundNetwork: false,
    })
    expect(command).toContain("'dsh-sandbox-x'\\''); evil'")
    expect(command).toContain("'/home/m e':/data")
    expect(command).toContain('--network none')
  })
})

describe('containerName', () => {
  it('is stable per instance id, so a reconnect adopts the container', () => {
    expect(containerName('abc')).toBe(containerName('abc'))
    expect(containerName('abc')).toBe('dsh-sandbox-abc')
  })
})

/**
 * Runtime detection against fake CLIs, so the branches are covered without a
 * daemon: which CLI wins, and which of the two faults the error names. The
 * caller owns PATH widening (`containerPath`), so detection trusts the
 * environment it is handed and these fixtures control what it can see.
 */
describe('detectRuntime', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  const onlyDir = join(root, 'only')
  const bothDir = join(root, 'both')
  const deadDir = join(root, 'dead')
  const quiet = (): void => undefined
  const shim = (dir: string, name: string, script: string): void => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${script}\n`)
    chmodSync(file, 0o755)
  }

  beforeAll(() => {
    shim(onlyDir, 'podman', 'exit 0')
    shim(bothDir, 'docker', 'exit 0')
    shim(bothDir, 'podman', 'exit 0')
    shim(deadDir, 'docker', 'echo "failed to connect to the docker API" >&2\nexit 1')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const envWith = (pathValue: string): NodeJS.ProcessEnv => ({ PATH: pathValue })

  it('prefers docker and returns its absolute path for the later spawns', async () => {
    const runtime = await detectRuntime(quiet, envWith(bothDir))
    expect(runtime.cli).toBe('docker')
    expect(runtime.bin).toBe(join(bothDir, 'docker'))
  })

  it('falls back to podman when docker is absent', async () => {
    const runtime = await detectRuntime(quiet, envWith(onlyDir))
    expect(runtime.cli).toBe('podman')
    expect(runtime.bin).toBe(join(onlyDir, 'podman'))
  })

  it('carries the environment into the returned runtime', async () => {
    const env = envWith(onlyDir)
    expect((await detectRuntime(quiet, env)).env).toBe(env)
  })

  it('reports a missing runtime and names where it looked', async () => {
    const promise = detectRuntime(quiet, envWith(join(root, 'nowhere')))
    await expect(promise).rejects.toThrow(/no container runtime found/)
    await expect(promise).rejects.toThrow(/Install one to use the sandbox/)
    await expect(promise).rejects.toThrow(join(root, 'nowhere'))
  })

  it('names an installed CLI whose daemon did not answer, not an installer', async () => {
    const promise = detectRuntime(quiet, envWith(deadDir))
    await expect(promise).rejects.toThrow(/docker is installed at .*dead\/docker but did not answer/)
    await expect(promise).rejects.toThrow(/failed to connect to the docker API/)
    await expect(promise).rejects.toThrow(/Start Docker Desktop/)
    await expect(promise).rejects.not.toThrow(/no container runtime found/)
  })

  it('logs one line per candidate so the connection log explains the failure', async () => {
    const lines: string[] = []
    await detectRuntime((line) => lines.push(line), envWith(deadDir)).catch(() => undefined)
    expect(lines.join('\n')).toContain('docker: found at')
    expect(lines.join('\n')).toContain('podman: not installed')
  })
})

describe('noRuntimeMessage', () => {
  it('tells a stopped daemon apart from a missing install', () => {
    const stopped = noRuntimeMessage([{ cli: 'docker', bin: '/usr/local/bin/docker', failure: 'daemon down' }], '/usr/bin')
    expect(stopped).toContain('docker is installed at /usr/local/bin/docker')
    expect(stopped).toContain('Start Docker Desktop')
    expect(stopped).not.toContain('Install one')

    const missing = noRuntimeMessage([{ cli: 'docker' }, { cli: 'podman' }], '/usr/bin:/usr/local/bin')
    expect(missing).toContain('no container runtime found')
    expect(missing).toContain('/usr/local/bin')
    expect(missing).toContain('Install one to use the sandbox')
  })
})
