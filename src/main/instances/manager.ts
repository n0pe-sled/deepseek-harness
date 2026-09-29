/**
 * InstanceManager: owns runtime state (start/stop lifecycle, endpoint, error,
 * version detail) for every configured instance and pushes InstanceView
 * snapshots to listeners. Configuration persistence lives in InstanceStore.
 */
import type {
  AddLocalInput,
  AddRawInput,
  AddSshInput,
  HarnessOrigin,
  InstanceConfig,
  InstanceRuntime,
  InstanceView,
  SshOptions,
} from '../../shared/instance.ts'
import { formatTarget } from '../../shared/harness-target.ts'
import { join } from 'node:path'
import { startLocalDsh, type LocalHandle } from './local.ts'
import { containerName, resolveSandboxOptions, startSandboxedDsh, type ResolvedSandbox } from './sandbox.ts'
import type { SandboxOptions } from '../../shared/instance.ts'
import { resolveBundledHarness } from './bundled.ts'
import { RemoteProvisioner, type ProvisionResult } from './provision.ts'
import { remoteClosureDir } from './provision-parse.ts'
import { forwardSshTunnel, forwardSshTunnelTo, type SshTunnelHandle } from './ssh.ts'
import { InstanceStore } from './store.ts'

type ManagedHandle = LocalHandle | SshTunnelHandle | { endpoint: string }

/** Lines kept per instance. Enough to hold a full provision, capped so a chatty
 *  failure cannot grow without bound. */
const LOG_LIMIT = 500

/** Name of the seeded default instance: this machine's local dsh. */
export const DEFAULT_LOCAL_NAME = 'Local'

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
    /**
     * Provisioning hooks, supplied by main. Absent in tests and in builds with
     * no staged closures, in which case a provisioned instance reports why
     * rather than silently connecting somewhere else.
     */
    private readonly provisioning?: {
      resourcesDir: string
      provisioner?: (deps: { resourcesDir: string; log: (line: string) => void }) => RemoteProvisioner
      /** Root for sandbox-private DSH_HOME directories, local and remote. */
      sandboxDshHomeRoot?: string
    },
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

  /**
   * Seed the app's own local dsh when nothing is saved.
   *
   * The instance manager opens on the saved list, so an empty store is a dead end
   * on a first run. The default is the local dsh this app ships, and it stays a
   * saved record until the user removes it. Nothing starts here, so seeding a first
   * run costs no process.
   */
  seedDefaultLocal(): void {
    if (this.managed.size > 0) return
    this.addLocal({ name: DEFAULT_LOCAL_NAME })
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

  /**
   * The connection log for one instance.
   *
   * Kept after a failure rather than cleared, because this is the only place the
   * reason ends up: a failed start puts a one-line summary on the runtime view and
   * the detail here. A new attempt clears it, so a reader never sees two attempts
   * interleaved.
   */
  logOf(id: string): string[] {
    return [...(this.managed.get(id)?.log ?? [])]
  }

  /** The error text for one instance, when it is in the error state. */
  errorOf(id: string): string | undefined {
    const runtime = this.managed.get(id)?.runtime
    return runtime?.status === 'error' ? runtime.error : undefined
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
        ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
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
    // Say what is being attempted before doing it. A connect can take seconds
    // (provisioning takes tens), and a window that stays empty for that long
    // reads as a hang.
    this.log(id, `connecting ${config.name} (${describeTarget(config)})`)
    this.emit()
    try {
      let endpoint: string
      let handle: ManagedHandle
      let onExit: ((cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void) | undefined
      let origin: HarnessOrigin | undefined
      let revision: string | undefined
      if (config.kind === 'local') {
        const sandbox = resolveSandboxOptions(config.local?.sandbox)
        if (sandbox.enabled) {
          // Containerized by default: the image carries the closure and every
          // plugin, so neither a Node install nor a staged closure is needed.
          // The DSH_HOME default is sandbox-private per instance — sharing the
          // host's real home would hand the container the host's credentials.
          const dshHome = sandbox.dshHome
            ?? join(this.provisioning?.sandboxDshHomeRoot ?? 'sandboxes', config.id, 'dsh-home')
          const h = await startSandboxedDsh({
            name: containerName(config.id),
            sandbox: { ...sandbox, dshHome },
            log: (line) => this.log(id, line),
          })
          handle = h
          endpoint = h.endpoint
          onExit = h.onExit
          origin = { closureKey: sandbox.image }
        } else {
          const h = await startLocalDsh(config.local ?? {}, (line) => this.log(id, line))
          handle = h
          endpoint = h.endpoint
          onExit = h.onExit
          const bundled = resolveBundledHarness()
          if (bundled?.meta !== undefined) {
            revision = bundled.meta.revision
            origin = { closureKey: bundled.meta.version, target: bundled.meta.source }
          }
        }
      } else if (config.kind === 'ssh' && config.ssh?.provision !== undefined) {
        const ssh = config.ssh
        const sandbox = resolveSandboxOptions(ssh.sandbox)
        if (sandbox.enabled) {
          const sandboxed = await this.provisionRemoteSandboxed(id, ssh, sandbox, config.id)
          const h = await forwardSshTunnelTo(ssh, sandboxed.remotePort, (line) => this.log(id, line))
          handle = h
          endpoint = h.endpoint
          onExit = h.onExit
          origin = { closureKey: sandboxed.image, provisioned: true }
        } else {
          const port = await this.provisionRemote(id, ssh)
          const h = await forwardSshTunnelTo(ssh, port.remotePort, (line) => this.log(id, line))
          handle = h
          endpoint = h.endpoint
          onExit = h.onExit
          revision = port.revision
          origin = {
            closureKey: port.closureKey,
            target: formatTarget(port.target),
            provisioned: true,
          }
        }
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
      managed.runtime = {
        status: 'running',
        endpoint,
        ...(revision === undefined ? {} : { revision }),
        ...(origin === undefined ? {} : { origin }),
      }
      this.emit()
      // Version detail is best-effort; a later reconnect probe refreshes it.
      void this.probe(id, endpoint)
      this.log(id, `connected: ${endpoint}`)
      onExit?.(() => {
        if (managed.handle !== handle) return
        managed.handle = undefined
        managed.runtime = { status: 'error', error: 'the connection ended unexpectedly' }
        this.log(id, 'the connection ended unexpectedly')
        this.emit()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      managed.runtime = { status: 'error', error: message }
      // The log is where the detail lives, so record the summary here too: a user
      // reading the log window should not have to look somewhere else for it.
      this.log(id, `failed: ${message}`)
      this.emit()
    }
  }

  async stop(id: string): Promise<void> {
    const managed = this.managed.get(id)
    if (managed === undefined) return
    const handle = managed.handle
    managed.handle = undefined
    if (handle !== undefined && 'stop' in handle) await handle.stop()
    // The app owns a sandboxed remote's container: closing the tunnel is not
    // enough, the container would keep running (and holding its port) unseen.
    if (managed.config.kind === 'ssh' && managed.config.ssh?.provision !== undefined) {
      await this.stopRemoteSandbox(id)
    }
    managed.runtime = { status: 'stopped' }
    this.emit()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.managed.keys()]) {
      await this.stop(id)
    }
  }

  /**
   * Run provisioning for one SSH instance and return what the tunnel needs.
   *
   * Kept separate from the SSH branch in {@link start} so the failure mode is
   * explicit: a provisioning run that cannot proceed throws, and the instance
   * lands in `error` with the refusal text rather than falling back to
   * forwarding a port nobody is listening on.
   */
  private async provisionRemote(id: string, ssh: SshOptions): Promise<ProvisionResult> {
    const config = this.provisioning
    if (config === undefined) {
      throw new Error('this build cannot provision a remote: no staged harness closure is available')
    }
    const provisioner = config.provisioner?.({ resourcesDir: config.resourcesDir, log: (line) => this.log(id, line) })
      ?? new RemoteProvisioner({ resourcesDir: config.resourcesDir, log: (line) => this.log(id, line) })
    return provisioner.prepare(ssh, ssh.provision ?? {})
  }

  /**
   * Sandboxed remote provisioning: only docker preflight + launch, since the
   * closure ships inside the image. Separate from {@link provisionRemote} so
   * each failure mode is explicit on the instance log.
   */
  private async provisionRemoteSandboxed(
    id: string,
    ssh: SshOptions,
    sandbox: ResolvedSandbox,
    instanceId: string,
  ): Promise<{ remotePort: number; image: string }> {
    const config = this.provisioning
    const dshHomeRoot = config?.sandboxDshHomeRoot ?? 'sandboxes'
    const provisioner = config?.provisioner?.({ resourcesDir: config.resourcesDir, log: (line) => this.log(id, line) })
      ?? new RemoteProvisioner({ resourcesDir: config?.resourcesDir ?? '.', log: (line) => this.log(id, line) })
    return provisioner.prepareSandboxed(ssh, { ...sandbox }, {
      containerName: containerName(instanceId),
      dshHomeRoot,
    })
  }

  /** Stop the remote sandbox container for one provisioned instance, if any. */
  async stopRemoteSandbox(id: string): Promise<void> {
    const managed = this.managed.get(id)
    const ssh = managed?.config.ssh
    if (managed === undefined || ssh?.provision === undefined || resolveSandboxOptions(ssh.sandbox).enabled !== true) return
    const config = this.provisioning
    if (config === undefined) return
    const provisioner = config.provisioner?.({ resourcesDir: config.resourcesDir, log: () => undefined })
      ?? new RemoteProvisioner({ resourcesDir: config.resourcesDir, log: () => undefined })
    await provisioner.stopRemoteSandbox(ssh, containerName(id))
  }

  /** Stop the remote harness a provisioned instance started, if any. */
  async stopRemoteServer(id: string): Promise<void> {
    const resolved = await this.remoteClosureOf(id)
    if (resolved === undefined) return
    await resolved.provisioner.stopRemote(resolved.ssh, resolved.remoteDir)
    this.emit()
  }

  /** Remove a provisioned instance's closure from its host. */
  async uninstallRemote(id: string): Promise<void> {
    const resolved = await this.remoteClosureOf(id)
    if (resolved === undefined) return
    await resolved.provisioner.uninstall(resolved.ssh, resolved.remoteDir)
    this.emit()
  }

  /**
   * Resolve which remote directory one instance's closure occupies.
   *
   * Detection runs again rather than being remembered from the last connect:
   * the remote's own facts decide the target, and a host that changed platform
   * or lost its closure should produce a real answer instead of a stale path.
   */
  private async remoteClosureOf(id: string): Promise<{
    provisioner: RemoteProvisioner
    ssh: SshOptions
    remoteDir: string
  } | undefined> {
    const managed = this.managed.get(id)
    const ssh = managed?.config.ssh
    const config = this.provisioning
    if (managed === undefined || ssh?.provision === undefined || config === undefined) return undefined
    const provisioner = config.provisioner?.({ resourcesDir: config.resourcesDir, log: (line) => this.log(id, line) })
      ?? new RemoteProvisioner({ resourcesDir: config.resourcesDir, log: (line) => this.log(id, line) })
    const { target, root } = await provisioner.detect(ssh, ssh.provision)
    const entry = provisioner.selectClosure(target)
    return { provisioner, ssh, remoteDir: remoteClosureDir(root, entry.key) }
  }

  private log(id: string, line: string): void {
    const managed = this.managed.get(id)
    if (managed === undefined) return
    // One entry per line, timestamped: the log is read after the fact to work out
    // how long a phase took, and ssh and the harness both emit multi-line chunks.
    for (const raw of line.split('\n')) {
      const text = raw.trimEnd()
      if (text === '') continue
      managed.log.push(`${new Date().toISOString().slice(11, 19)}  ${text}`)
      if (managed.log.length > LOG_LIMIT) managed.log.shift()
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

/** One-line description of what a connect will do, for the log's first entry. */
export function describeTarget(config: InstanceConfig): string {
  if (config.kind === 'ssh') {
    const ssh = config.ssh
    const destination = ssh === undefined
      ? 'ssh'
      : `${ssh.user === undefined || ssh.user === '' ? '' : `${ssh.user}@`}${ssh.host}`
    if (ssh?.provision !== undefined) {
      return resolveSandboxOptions(ssh.sandbox).enabled
        ? `ssh ${destination}, running this app's harness in a sandbox container`
        : `ssh ${destination}, shipping this app's harness`
    }
    return `ssh ${destination}, forwarding remote port ${String(ssh?.remotePort ?? 3000)}`
  }
  if (config.kind === 'local') {
    return resolveSandboxOptions(config.local?.sandbox).enabled
      ? 'sandboxed local dsh container'
      : 'local dsh process'
  }
  return `url ${config.rawUrl ?? ''}`
}
