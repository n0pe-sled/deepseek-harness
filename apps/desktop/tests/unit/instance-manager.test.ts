/**
 * The default instance the instance manager opens on.
 *
 * The window lists saved instances, so a first run with an empty store would
 * show an empty list and nothing to launch. These cases pin the seed: it adds
 * this machine's local dsh, it adds nothing else, and it never starts a process.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LOCAL_NAME, InstanceManager } from '../../src/main/instances/manager.ts'
import { InstanceStore } from '../../src/main/instances/store.ts'

let dirs: string[] = []
let stores: InstanceStore[] = []

afterEach(async () => {
  // The store writes on a queued promise, so a test that mutates and returns
  // would leave that write racing the cleanup below.
  await Promise.all(stores.map(async (store) => store.flush()))
  await Promise.all(dirs.map(async (d) => rm(d, { recursive: true, force: true })))
  dirs = []
  stores = []
})

/** A manager over a fresh store, with the probe never reaching a host. */
async function freshManager(): Promise<InstanceManager> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-manager-'))
  dirs.push(dir)
  const store = new InstanceStore(dir)
  stores.push(store)
  const manager = new InstanceManager(store, async () => undefined)
  await manager.load()
  return manager
}

describe('InstanceManager default instance', () => {
  it('seeds one local dsh when nothing is saved', async () => {
    const manager = await freshManager()
    expect(manager.views()).toEqual([])

    manager.seedDefaultLocal()

    const views = manager.views()
    expect(views).toHaveLength(1)
    expect(views[0]?.config.kind).toBe('local')
    expect(views[0]?.config.name).toBe(DEFAULT_LOCAL_NAME)
    // Seeding is not a launch: the row must come up stopped, or opening the
    // manager on a first run would start a container nobody asked for.
    expect(views[0]?.runtime.status).toBe('stopped')
    expect(manager.endpointOf(views[0]!.config.id)).toBeUndefined()
  })

  it('leaves a store that already has an instance alone', async () => {
    const manager = await freshManager()
    const added = manager.addSsh({ name: 'work', ssh: { host: 'example.com' } })

    manager.seedDefaultLocal()

    const views = manager.views()
    expect(views).toHaveLength(1)
    expect(views[0]?.config.id).toBe(added.config.id)
  })

  it('re-seeds only while the list is empty', async () => {
    const manager = await freshManager()
    manager.seedDefaultLocal()
    const seeded = manager.views()[0]!.config.id

    await manager.remove(seeded)
    expect(manager.views()).toEqual([])

    // An emptied list is the dead end the seed exists to prevent, so the
    // default comes back rather than leaving the manager with nothing to launch.
    manager.seedDefaultLocal()
    expect(manager.views()).toHaveLength(1)
    expect(manager.views()[0]?.config.name).toBe(DEFAULT_LOCAL_NAME)
  })
})
