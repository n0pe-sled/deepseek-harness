/**
 * InstanceManager: owns runtime state (start/stop lifecycle, endpoint, error,
 * version detail) for every configured instance and pushes InstanceView
 * snapshots to listeners. Configuration persistence lives in InstanceStore.
 */
import type {
  AddLocalInput,
  AddRawInput,
  AddSshInput,
  InstanceConfig,
  InstanceRuntime,
  InstanceView,
} from '../../shared/instance.ts'
import { startLocalDsh, type LocalHandle } from './local.ts'
import { forwardSshTunnel, type SshTunnelHandle } from './ssh.ts'
import { InstanceStore } from './store.ts'

type ManagedHandle = LocalHandle | SshTunnelHandle | { endpoint: string }

interface Managed {
  config: InstanceConfig
  runtime: InstanceRuntime
  handle?: ManagedHandle
  log: string[]
}

/** Probe host.describe without depending on the renderer bridge (shares its shape). */
export type ProbeDescribe = (endpoint: string) => Promise<{ version?: string } | undefined>

export class InstanceManager {
  private readonly managed = new Map<string, Managed>()
  private readonly listeners = new Set<(views: InstanceView[]) => void>()
  private activeId?: string

  constructor(
    private readonly store: InstanceStore,
    private readonly probeDescribe: ProbeDescribe,
  ) {}

  async load(): Promise<void> {
    await this.store.load()
    for (const config of this.store.list()) {
      this.managed.set(config.id, { config, runtime: { status: 'stopped' }, log: [] })
    }
    this.activeId = this.store.getActive()
    // Only keep the active hint when the instance still exists.
    if (this.activeId !== undefined && !this.managed.has(this.activeId)) this.activeId = undefined
  }

  subscribe(listener: (views: InstanceView[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.views())
    return () => this.listeners.delete(listener)
  }

  views(): InstanceView[] {
    return [...this.managed.values()].map((m) => ({ config: m.config, runtime: m.runtime }))
  }

  getActive(): string | undefined {
    return this.activeId
  }

  endpointOf(id: string): string | undefined {
    return this.managed.get(id)?.runtime.endpoint
  }

  /** The stable loopback content host for one instance (undefined if unknown). */
  hostOf(id: string): string | undefined {
    return this.managed.get(id)?.config.loopbackHost
  }

  /** The instance id behind one dsh-app content host (undefined if unknown). */
  idForHost(host: string): string | undefined {
    for (const m of this.managed.values()) {
      if (m.config.loopbackHost === host) return m.config.id
    }
    return undefined
  }

  addLocal(input: AddLocalInput): InstanceView {
    const config = this.store.add({
      kind: 'local', name: input.name,
      // Preserve only the set fields so undefined stays absent from disk.
      local: {
        ...(input.dshPath !== undefined ? { dshPath: input.dshPath } : {}),
        ...(input.dshArgs !== undefined ? { dshArgs: input.dshArgs } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      },
    })
    return this.mount(config)
  }

  addSsh(input: AddSshInput): InstanceView {
    const config = this.store.add({ kind: 'ssh', name: input.name, ssh: input.ssh })
    return this.mount(config)
  }

  addRaw(input: AddRawInput): InstanceView {
    const rawUrl = normalizeRawUrl(input.url)
    const config = this.store.add({ kind: 'raw', name: input.name, rawUrl })
    return this.mount(config)
  }

  private mount(config: InstanceConfig): InstanceView {
    const managed: Managed = { config, runtime: { status: 'stopped' }, log: [] }
    this.managed.set(config.id, managed)
    return { config, runtime: managed.runtime }
  }

  async remove(id: string): Promise<void> {
    await this.stop(id)
    this.store.remove(id)
    this.managed.delete(id)
    if (this.activeId === id) {
      this.activeId = undefined
      this.store.setActive(undefined)
    }
    this.emit()
  }

  async connect(id: string): Promise<InstanceView> {
    const managed = this.require(id)
    if (managed.runtime.status !== 'running') await this.start(id)
    this.setActive(id)
    return { config: managed.config, runtime: managed.runtime }
  }

  setActive(id: string): void {
    this.activeId = id
    this.store.setActive(id)
  }

  clearActive(): void {
    this.activeId = undefined
    this.store.setActive(undefined)
  }

  async disconnect(id: string): Promise<void> {
    // Detach the shell only; the instance keeps running.
    this.clearActive()
    this.emit()
  }

  async start(id: string): Promise<void> {
    const managed = this.require(id)
    if (managed.runtime.status === 'running' && managed.handle !== undefined) return
    const { config } = managed
    managed.runtime = { status: 'starting' }
    managed.log = []
    this.emit()
    try {
      let endpoint: string
      let handle: ManagedHandle
      let onExit: ((cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void) | undefined
      if (config.kind === 'local') {
        const h = await startLocalDsh(config.local ?? {}, (line) => this.log(id, line))
        handle = h
        endpoint = h.endpoint
        onExit = h.onExit
      } else if (config.kind === 'ssh') {
        const h = await forwardSshTunnel(config.ssh ?? { host: '' }, (line) => this.log(id, line))
        handle = h
        endpoint = h.endpoint
        onExit = h.onExit
      } else {
        endpoint = config.rawUrl ?? ''
        if (endpoint === '') throw new Error('raw instance has no URL')
        handle = { endpoint }
      }
      managed.handle = handle
      managed.runtime = { status: 'running', endpoint }
      this.emit()
      // Version detail is best-effort; a later reconnect probe refreshes it.
      void this.probe(id, endpoint)
      onExit?.(() => {
        if (managed.handle !== handle) return
        managed.handle = undefined
        managed.runtime = { status: 'error', error: 'process exited' }
        this.emit()
      })
    } catch (error) {
      managed.runtime = { status: 'error', error: error instanceof Error ? error.message : String(error) }
      this.emit()
    }
  }

  async stop(id: string): Promise<void> {
    const managed = this.managed.get(id)
    if (managed === undefined) return
    const handle = managed.handle
    managed.handle = undefined
    if (handle !== undefined && 'stop' in handle) await handle.stop()
    managed.runtime = { status: 'stopped' }
    this.emit()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.managed.keys()]) {
      await this.stop(id)
    }
  }

  private log(id: string, line: string): void {
    const managed = this.managed.get(id)
    if (managed !== undefined) {
      managed.log.push(line)
      if (managed.log.length > 200) managed.log.shift()
    }
  }

  private async probe(id: string, endpoint: string): Promise<void> {
    try {
      const info = await this.probeDescribe(endpoint)
      const managed = this.managed.get(id)
      if (managed === undefined) return
      managed.runtime.detail = info?.version !== undefined ? `v${info.version}` : 'dsh'
      this.emit()
    } catch {
      // Non-fatal: the sidebar keeps showing the endpoint.
    }
  }

  private require(id: string): Managed {
    const managed = this.managed.get(id)
    if (managed === undefined) throw new Error(`unknown instance ${id}`)
    return managed
  }

  private emit(): void {
    const views = this.views()
    for (const listener of this.listeners) {
      try {
        listener(views)
      } catch {
        // Listener isolation: one broken view must not stop emission.
      }
    }
  }
}

/** Normalize a raw instance URL (add http:// when missing, strip trailing slash). */
export function normalizeRawUrl(url: string): string {
  const trimmed = url.trim()
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/$/u, '')
}
