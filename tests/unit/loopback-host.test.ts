import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveLoopbackHost, isLoopbackClassified } from '../../src/main/loopback-host.ts'
import { InstanceStore } from '../../src/main/instances/store.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function tempStore(): Promise<{ store: InstanceStore; dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-loopback-'))
  dirs.push(dir)
  return { store: new InstanceStore(dir), dir, file: join(dir, 'instances.json') }
}

describe('deriveLoopbackHost', () => {
  it('derives a loopback-classified 127.x.y.z host', () => {
    const host = deriveLoopbackHost('local-a1b2c3d4', new Set())
    expect(host).toMatch(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u)
    expect(isLoopbackClassified(host)).toBe(true)
  })

  it('is deterministic for the same id', () => {
    expect(deriveLoopbackHost('local-a1b2c3d4', new Set()))
      .toBe(deriveLoopbackHost('local-a1b2c3d4', new Set()))
  })

  it('skips taken hosts and still returns a loopback host', () => {
    const first = deriveLoopbackHost('local-a1b2c3d4', new Set())
    const second = deriveLoopbackHost('local-a1b2c3d4', new Set([first]))
    expect(second).not.toBe(first)
    expect(isLoopbackClassified(second)).toBe(true)
  })

  it('keeps unrelated instances on distinct hosts', () => {
    const hosts = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      const host = deriveLoopbackHost(`local-${i.toString(16).padStart(8, '0')}`, hosts)
      expect(hosts.has(host)).toBe(false)
      hosts.add(host)
    }
    expect(hosts.size).toBe(50)
  })
})

describe('isLoopbackClassified', () => {
  it('accepts the harness-classified loopback names', () => {
    expect(isLoopbackClassified('localhost')).toBe(true)
    expect(isLoopbackClassified('[::1]')).toBe(true)
    expect(isLoopbackClassified('127.0.0.1')).toBe(true)
    expect(isLoopbackClassified('127.255.255.254')).toBe(true)
  })

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackClassified('local-a1b2c3d4')).toBe(false)
    expect(isLoopbackClassified('example.com')).toBe(false)
    expect(isLoopbackClassified('10.0.0.1')).toBe(false)
  })
})

describe('InstanceStore loopback host assignment', () => {
  it('assigns a loopback host on add and persists it', async () => {
    const { store, dir, file } = await tempStore()
    await store.load()
    const config = store.add({ kind: 'local', name: 'dev' })
    expect(config.loopbackHost).toBeDefined()
    expect(isLoopbackClassified(config.loopbackHost ?? '')).toBe(true)
    await store.flush()

    const reloaded = new InstanceStore(dir)
    await reloaded.load()
    expect(reloaded.get(config.id)?.loopbackHost).toBe(config.loopbackHost)
  })

  it('backfills missing hosts on load and repairs duplicates', async () => {
    const { store, dir, file } = await tempStore()
    await store.load()
    const a = store.add({ kind: 'local', name: 'a' })
    const b = store.add({ kind: 'local', name: 'b' })
    await store.flush()

    // Simulate older records: force a duplicate host on both instances.
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      instances: { id: string; loopbackHost?: string }[]
    }
    raw.instances[0]!.loopbackHost = '127.9.9.9'
    raw.instances[1]!.loopbackHost = '127.9.9.9'
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const repaired = new InstanceStore(dir)
    await repaired.load()
    // Flush the backfill save so the temp dir is quiescent for cleanup.
    await repaired.flush()
    const hostA = repaired.get(a.id)?.loopbackHost
    const hostB = repaired.get(b.id)?.loopbackHost
    expect(hostA).toBe('127.9.9.9')
    expect(hostB).toBeDefined()
    expect(hostB).not.toBe(hostA)
    expect(isLoopbackClassified(hostB ?? '')).toBe(true)
  })
})
