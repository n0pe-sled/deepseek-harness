/**
 * The environment the app hands its ssh children.
 *
 * The regression these carry: a host reached through a `ProxyCommand` naming an
 * installed helper failed in the app while the same command worked in a terminal.
 * The app spawns ssh from a process that Finder started, whose PATH is launchd's
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), and ssh resolves `ProxyCommand` through
 * the user's shell with the PATH it was handed, so the helper was never found.
 * Every ssh child carries the widened PATH, not only the one that was reported:
 * provisioning, the tunnel, and the transfer.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshOptions } from '../../src/shared/instance.ts'

/** launchd's PATH, the one a Dock-launched app starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

interface SpawnedChild {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  exitCode: number | null
  signalCode: string | null
  kill: () => boolean
  emit: (event: string, ...args: unknown[]) => boolean
}

/** One captured `spawn` call: what the code under test asked for. */
interface SpawnCall {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv | undefined
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const calls: SpawnCall[] = []

/**
 * A stand-in ssh child that writes `stdout` and then closes with `code`, which is
 * the shape of a command and of a transfer.
 */
function closingSsh(stdout: string, code = 0): SpawnedChild {
  const child = baseSsh()
  setImmediate(() => {
    // Close after the output is readable: the callers accumulate stdout in a
    // `data` listener, so a close racing that read would drop the text.
    child.stdout.once('end', () => {
      child.exitCode = code
      child.emit('close', code, null)
    })
    child.stdout.end(stdout)
  })
  return child
}

/**
 * A stand-in tunnel ssh: it stays connected until it is stopped, because a
 * tunnel is a long-lived forward rather than a command that finishes.
 */
function liveSsh(): SpawnedChild {
  return baseSsh()
}

/** A stand-in ssh child with the fields every caller reads. */
function baseSsh(): SpawnedChild {
  const child = new EventEmitter() as unknown as SpawnedChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  // A live child reports neither an exit code nor a signal, and the tunnel reads
  // both to decide whether its ssh is still running.
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.signalCode = 'SIGTERM'
    setImmediate(() => { child.emit('exit', null, 'SIGTERM') })
    return true
  }
  return child
}

/** Capture every spawn call and answer each one with `make()`. */
function handleSpawn(make: () => SpawnedChild): void {
  spawnMock.mockImplementation((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env })
    return make()
  })
}

/** The PATH every ssh child was handed, or undefined when one got none. */
function spawnedPath(): string | undefined {
  return calls[0]?.env?.PATH
}

const opts: SshOptions = { host: 'idot-mythic2', user: 'ubuntu' }

beforeEach(() => {
  calls.length = 0
  spawnMock.mockReset()
  vi.stubEnv('PATH', LAUNCHD_PATH)
  vi.stubEnv('HOME', '/Users/me')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runSshCommand', () => {
  it('hands ssh a PATH that can resolve a ProxyCommand helper', async () => {
    handleSpawn(() => closingSsh('ok\n'))
    const { runSshCommand } = await import('../../src/main/instances/ssh.ts')
    await runSshCommand(opts, 'echo ok')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(calls[0]?.command).toBe('ssh')
    expect(spawnedPath()).toContain('/opt/homebrew/bin')
    // The inherited PATH stays first: a directory the user already has has to win
    // over ours, or widening would change which binary a call resolves.
    expect(spawnedPath()?.startsWith(LAUNCHD_PATH)).toBe(true)
  })
})

describe('forwardSshTunnelTo', () => {
  it('hands the tunnel ssh the same PATH', async () => {
    handleSpawn(liveSsh)
    // The forward is ready as soon as its local port answers, which is the only
    // thing this test has to stand in for.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 200 })))
    const { forwardSshTunnelTo } = await import('../../src/main/instances/ssh.ts')
    const tunnel = await forwardSshTunnelTo(opts, 3080)

    expect(calls[0]?.args).toContain('-L')
    expect(spawnedPath()).toContain('/opt/homebrew/bin')
    await tunnel.stop()
  })
})

describe('shipOverSsh', () => {
  it('hands the shipping ssh the same PATH', async () => {
    handleSpawn(() => closingSsh('extracted\n'))
    const { shipOverSsh } = await import('../../src/main/instances/provision.ts')
    await shipOverSsh(opts, 'set -e; echo extracted', () => Promise.resolve(), () => undefined)

    expect(calls[0]?.command).toBe('ssh')
    expect(spawnedPath()).toContain('/opt/homebrew/bin')
  })
})
