import { beforeAll, describe, expect, it } from 'vitest'
import type { SshOptions } from '../../src/main/instances/ssh'
import type { InstanceConfig } from '../../src/shared/instance.ts'

let parseReadyUrl: (line: string) => string | undefined
let buildSshArgs: (opts: SshOptions, localPort: number) => string[]
let buildTunnelArgs: (opts: SshOptions, localPort: number, remotePort: number) => string[]
let buildSshCommandArgs: (opts: SshOptions, command: string) => string[]
let describeSshFailure: (stderr: string, opts: SshOptions, remotePort: number) => string | undefined
let sshErrorTail: (stderr: string, lines?: number) => string
let normalizeRawUrl: (url: string) => string
let describeTarget: (config: InstanceConfig) => string
let normalizeDshPath: (value: string) => string
let augmentPath: (path: string) => string

beforeAll(async () => {
  const local = await import('../../src/main/instances/local.ts')
  const ssh = await import('../../src/main/instances/ssh.ts')
  const manager = await import('../../src/main/instances/manager.ts')
  parseReadyUrl = local.parseReadyUrl
  buildSshArgs = ssh.buildSshArgs
  buildTunnelArgs = ssh.buildTunnelArgs
  buildSshCommandArgs = ssh.buildSshCommandArgs
  describeSshFailure = ssh.describeSshFailure
  sshErrorTail = ssh.sshErrorTail
  normalizeRawUrl = manager.normalizeRawUrl
  describeTarget = manager.describeTarget
  normalizeDshPath = local.normalizeDshPath
  augmentPath = local.augmentPath
})

describe('normalizeDshPath', () => {
  it('strips a trailing standalone `web` subcommand', () => {
    expect(normalizeDshPath('/Users/me/.local/bin/dsh web')).toBe('/Users/me/.local/bin/dsh')
  })

  it('leaves a plain binary path untouched', () => {
    expect(normalizeDshPath('/Users/me/.local/bin/dsh')).toBe('/Users/me/.local/bin/dsh')
  })

  it('leaves a directory containing `web` untouched', () => {
    expect(normalizeDshPath('/opt/web/dsh')).toBe('/opt/web/dsh')
  })

  it('falls back when the path is blank', () => {
    expect(normalizeDshPath('   ')).toBe('')
  })
})

describe('augmentPath', () => {
  it('appends standard node directories', () => {
    const result = augmentPath('/usr/bin', '/Users/me')
    expect(result.startsWith('/usr/bin')).toBe(true)
    expect(result).toContain('/Users/me/.local/bin')
    expect(result).toContain('/opt/homebrew/bin')
    expect(result).toContain('/usr/local/bin')
  })

  it('handles an empty PATH', () => {
    const result = augmentPath('')
    expect(result).toContain('/opt/homebrew/bin')
  })

  it('does not add relative user directories without a home', () => {
    const result = augmentPath('', '')
    expect(result).not.toContain('.local/bin')
  })
})


describe('parseReadyUrl', () => {
  it('extracts the loopback URL from a readiness line', () => {
    expect(parseReadyUrl('dsh web: http://127.0.0.1:45871 (LAN: http://10.0.0.5:45871)')).toBe('http://127.0.0.1:45871')
  })

  it('matches a bare readiness line', () => {
    expect(parseReadyUrl('dsh web: http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('returns undefined for unrelated output', () => {
    expect(parseReadyUrl('booting profile web...')).toBeUndefined()
    expect(parseReadyUrl('dsh web: http://10.0.0.5:8080')).toBeUndefined()
  })
})

describe('buildSshArgs', () => {
  it('builds a default local-forward argv', () => {
    expect(buildSshArgs({ host: 'server.example.com' }, 40000)).toEqual([
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-L', '127.0.0.1:40000:127.0.0.1:3000',
      'server.example.com',
    ])
  })

  it('adds user, ssh port, identity file, and custom remote port', () => {
    // Ordering: connection options (port, identity) come from the shared base
    // args, then the forward, then the destination ssh expects last.
    expect(buildSshArgs(
      { host: 'box', user: 'me', port: 2222, identityFile: '~/.ssh/id', remotePort: 8080, strictHostKeyChecking: 'no' },
      40001,
    )).toEqual([
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-p', '2222',
      '-i', '~/.ssh/id',
      '-L', '127.0.0.1:40001:127.0.0.1:8080',
      'me@box',
    ])
  })

  it('forwards an explicit remote port, which a provisioned instance only learns at runtime', () => {
    expect(buildTunnelArgs({ host: 'box' }, 40002, 39117)).toEqual([
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-L', '127.0.0.1:40002:127.0.0.1:39117',
      'box',
    ])
  })

  it('builds a one-shot remote command with the same connection options as a tunnel', () => {
    expect(buildSshCommandArgs({ host: 'box', user: 'me', port: 2222 }, "uname -sm")).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', '2222',
      'me@box',
      'uname -sm',
    ])
  })
})

describe('normalizeRawUrl', () => {
  it('adds http:// when missing', () => {
    expect(normalizeRawUrl('example.com:3000')).toBe('http://example.com:3000')
  })

  it('keeps https and strips a trailing slash', () => {
    expect(normalizeRawUrl('https://dsh.example.com/')).toBe('https://dsh.example.com')
  })
})

describe('describeSshFailure', () => {
  const opts: SshOptions = { host: '10.0.100.226', user: 'n0pe-sled' }

  it('names the refused-forward case and says how to fix it', () => {
    // Captured from a real host whose port 3000 was Grafana bound to the LAN
    // address, while the app forwards to 127.0.0.1. ssh stays alive, so this
    // stderr line is the only evidence anything went wrong.
    const described = describeSshFailure('channel 1: open failed: connect failed: Connection refused', opts, 3000)
    expect(described).toContain('127.0.0.1:3000')
    expect(described).toContain('Ship this app')
  })

  it('explains that BatchMode means no password prompt', () => {
    expect(describeSshFailure('n0pe-sled@box: Permission denied (publickey).', opts, 3000))
      .toContain('key-based authentication')
  })

  it('covers the transport failures a user actually hits', () => {
    expect(describeSshFailure('ssh: connect to host box port 22: No route to host', opts, 3000))
      .toContain('not reachable')
    expect(describeSshFailure('ssh: Could not resolve hostname box', opts, 3000))
      .toContain('does not resolve')
    expect(describeSshFailure('ssh: connect to host box port 22: Connection timed out', opts, 3000))
      .toContain('timed out')
    expect(describeSshFailure('Host key verification failed.', opts, 3000))
      .toContain('known_hosts')
  })

  it('returns undefined rather than inventing a cause', () => {
    expect(describeSshFailure('', opts, 3000)).toBeUndefined()
    expect(describeSshFailure('   \n  ', opts, 3000)).toBeUndefined()
    expect(describeSshFailure('something unrecognised', opts, 3000)).toBeUndefined()
  })
})

describe('sshErrorTail', () => {
  it('keeps the last lines and drops blanks, so a message stays one paragraph', () => {
    expect(sshErrorTail('a\n\nb\nc\nd\ne\n', 3)).toBe('c\nd\ne')
  })

  it('is empty for empty output', () => {
    expect(sshErrorTail('   ')).toBe('')
  })
})

describe('describeTarget', () => {
  it('says what a connect will do, so the log opens with something useful', () => {
    expect(describeTarget({
      id: 'ssh-1', kind: 'ssh', name: 'box', createdAt: 0,
      ssh: { host: 'box', user: 'me', remotePort: 4000 },
    })).toBe('ssh me@box, forwarding remote port 4000')

    expect(describeTarget({
      id: 'ssh-2', kind: 'ssh', name: 'box', createdAt: 0,
      ssh: { host: 'box', provision: {} },
    })).toBe("ssh box, shipping this app's harness")

    expect(describeTarget({ id: 'local-1', kind: 'local', name: 'here', createdAt: 0 }))
      .toBe('local dsh process')

    expect(describeTarget({ id: 'raw-1', kind: 'raw', name: 'url', createdAt: 0, rawUrl: 'http://x' }))
      .toBe('url http://x')
  })
})
