import { beforeAll, describe, expect, it } from 'vitest'
import type { SshOptions } from '../../src/main/instances/ssh'

let parseReadyUrl: (line: string) => string | undefined
let buildSshArgs: (opts: SshOptions, localPort: number) => string[]
let normalizeRawUrl: (url: string) => string
let normalizeDshPath: (value: string) => string
let augmentPath: (path: string) => string

beforeAll(async () => {
  const local = await import('../../src/main/instances/local.ts')
  const ssh = await import('../../src/main/instances/ssh.ts')
  const manager = await import('../../src/main/instances/manager.ts')
  parseReadyUrl = local.parseReadyUrl
  buildSshArgs = ssh.buildSshArgs
  normalizeRawUrl = manager.normalizeRawUrl
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
    expect(buildSshArgs(
      { host: 'box', user: 'me', port: 2222, identityFile: '~/.ssh/id', remotePort: 8080, strictHostKeyChecking: 'no' },
      40001,
    )).toEqual([
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-L', '127.0.0.1:40001:127.0.0.1:8080',
      '-p', '2222',
      '-i', '~/.ssh/id',
      'me@box',
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
