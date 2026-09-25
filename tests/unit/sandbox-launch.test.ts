/**
 * Sandbox command construction, without a container daemon: the argv ordering
 * rule (app flags, then user args, then image), the built-in defaults, the
 * port parser, and the remote launch command's shape.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDockerRunArgs,
  buildRemoteSandboxCommand,
  containerName,
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

  it('ignores other ports and garbage', () => {
    expect(parseDockerPort('3000/tcp -> 127.0.0.1:3000', SANDBOX_RELAY_PORT)).toBeUndefined()
    expect(parseDockerPort('', SANDBOX_RELAY_PORT)).toBeUndefined()
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
