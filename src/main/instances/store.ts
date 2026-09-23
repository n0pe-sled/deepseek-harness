/**
 * Persisted instance registry. Survives restarts; runtime state lives in the
 * InstanceManager, never here.
 */
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { InstanceConfig } from '../../shared/instance.ts'
import { deriveLoopbackHost } from '../loopback-host.ts'

interface PersistedState {
  schemaVersion: 1
  instances: InstanceConfig[]
  activeId?: string
}

export class InstanceStore {
  private state: PersistedState = { schemaVersion: 1, instances: [] }
  private readonly file: string
  private pending: Promise<void> = Promise.resolve()

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'instances.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.instances)) {
        this.state = { schemaVersion: 1, instances: parsed.instances, activeId: parsed.activeId }
      }
    } catch {
      // First run or corrupt file: start empty rather than crash the shell.
    }
    // Older records predate the loopback content origin: assign one so the
    // content view stays loopback-classified. Repair duplicates too — two
    // instances sharing a host would share a browser origin.
    const seen = new Set<string>()
    let repaired = false
    for (const instance of this.state.instances) {
      if (instance.loopbackHost !== undefined && !seen.has(instance.loopbackHost)) {
        seen.add(instance.loopbackHost)
        continue
      }
      instance.loopbackHost = deriveLoopbackHost(instance.id, seen)
      seen.add(instance.loopbackHost)
      repaired = true
    }
    if (repaired) this.scheduleSave()
  }

  list(): InstanceConfig[] {
    return [...this.state.instances]
  }

  get(id: string): InstanceConfig | undefined {
    return this.state.instances.find((i) => i.id === id)
  }

  add(partial: Omit<InstanceConfig, 'id' | 'createdAt'>): InstanceConfig {
    const id = `${partial.kind}-${randomUUID().slice(0, 8)}`
    const taken = new Set(
      this.state.instances
        .map((i) => i.loopbackHost)
        .filter((h): h is string => h !== undefined),
    )
    const config: InstanceConfig = {
      ...partial,
      id,
      createdAt: Date.now(),
      loopbackHost: deriveLoopbackHost(id, taken),
    }
    this.state.instances.push(config)
    this.scheduleSave()
    return config
  }

  remove(id: string): boolean {
    const before = this.state.instances.length
    this.state.instances = this.state.instances.filter((i) => i.id !== id)
    if (this.state.activeId === id) this.state.activeId = undefined
    const changed = this.state.instances.length !== before
    if (changed) this.scheduleSave()
    return changed
  }

  setActive(id: string | undefined): void {
    this.state.activeId = id
    this.scheduleSave()
  }

  getActive(): string | undefined {
    return this.state.activeId
  }

  async save(): Promise<void> {
    const tmp = `${this.file}.tmp`
    await fs.mkdir(dirname(this.file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  /** Await the queued writes (tests and quit paths). */
  async flush(): Promise<void> {
    await this.pending
  }

  private scheduleSave(): void {
    this.pending = this.pending.then(() => this.save()).catch(() => undefined)
  }
}
