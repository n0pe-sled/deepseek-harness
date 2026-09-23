/**
 * Persisted instance model + runtime status views shared across processes.
 * InstanceConfig is what we persist; InstanceView is what we hand the renderer.
 */

export type InstanceKind = 'local' | 'ssh' | 'raw'

/** Remote dsh reachable through an SSH local-port forward (the recommended remote path). */
export interface SshOptions {
  /** SSH host name or IP. */
  host: string
  /** SSH port (default 22). */
  port?: number
  /** Optional SSH user; omitted uses the local user. */
  user?: string
  /** Optional identity file (default: ssh-agent / ~/.ssh). */
  identityFile?: string
  /** dsh web port on the remote side (default 3000). */
  remotePort?: number
  /** StrictHostKeyChecking policy; default `accept-new`. */
  strictHostKeyChecking?: 'yes' | 'accept-new' | 'no'
}

/** Local instance: spawned `dsh web` child process. */
export interface LocalOptions {
  /**
   * dsh executable to spawn instead of the bundled harness. Omitted (or empty)
   * uses the harness closure this build ships, launched through the app's own
   * Electron binary as its Node runtime — no Node install, no PATH entry.
   */
  dshPath?: string
  /** Extra args appended after `web --port 0 --no-open`. */
  dshArgs?: string[]
  /** Extra environment (e.g. DSH_HOME). */
  env?: Record<string, string>
}

export interface InstanceConfig {
  id: string
  kind: InstanceKind
  name: string
  createdAt: number
  /**
   * Stable per-instance loopback host (`127.x.y.z`) used as the dsh-app
   * content origin. The harness client gates settings surfaces on the page
   * being loopback-classified, so the content view must load from a loopback
   * literal; distinct hosts per instance keep per-origin state isolated.
   * Assigned by the store on add and backfilled on load for older records.
   */
  loopbackHost?: string
  /** kind === 'local' */
  local?: LocalOptions
  /** kind === 'ssh' */
  ssh?: SshOptions
  /** kind === 'raw': direct URL (advanced; privileged methods will be denied). */
  rawUrl?: string
}

export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error'

export interface InstanceRuntime {
  status: RuntimeStatus
  /** Loopback endpoint (local/ssh) or configured URL (raw) while running. */
  endpoint?: string
  error?: string
  /** Best-effort host.describe() summary, e.g. version. */
  detail?: string
}

export interface InstanceView {
  config: InstanceConfig
  runtime: InstanceRuntime
}

/** Inputs for the add-* manager calls (all optional fields validated by main). */
export interface AddLocalInput {
  name: string
  dshPath?: string
  dshArgs?: string[]
  env?: Record<string, string>
}

export interface AddSshInput {
  name: string
  ssh: SshOptions
}

export interface AddRawInput {
  name: string
  url: string
}
