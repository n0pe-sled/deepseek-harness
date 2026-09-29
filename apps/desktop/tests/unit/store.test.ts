import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceStore } from '../../src/main/instances/store.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function tempStore(): Promise<InstanceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  dirs.push(dir)
  return new InstanceStore(dir)
}

describe('InstanceStore', () => {
  it('round-trips instances and active id through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-store-'))
    dirs.push(dir)
    const store = new InstanceStore(dir)
    await store.load()
    expect(store.list()).toEqual([])

    const config = store.add({ kind: 'local', name: 'dev' })
    store.setActive(config.id)
    await store.flush()

    const reloaded = new InstanceStore(dir)
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]?.id).toBe(config.id)
    expect(reloaded.getActive()).toBe(config.id)
  })

  it('removes instances and clears the active pointer', async () => {
    const store = await tempStore()
    await store.load()
    const config = store.add({ kind: 'ssh', name: 'box', ssh: { host: 'box' } })
    store.setActive(config.id)
    expect(store.remove(config.id)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.getActive()).toBeUndefined()
    expect(store.remove('nope')).toBe(false)
    // Every mutator queues a write; drain it so the temp-dir cleanup in
    // afterEach cannot race a save that recreates instances.json.tmp.
    await store.flush()
  })
})
