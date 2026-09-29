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
  /**
   * Ship this app's harness closure to the host, run it there, and tunnel its
   * discovered port back — instead of forwarding to a `dsh web` the user
   * already runs on the configured `remotePort`.
   *
   * The closure is the fork's staged build, never a registry install, so the
   * remote runs the same code this app does. When set, `remotePort` is ignored:
   * the remote binds an ephemeral loopback port and the app discovers it from
   * the readiness line.
   */
  provision?: ProvisionOptions
  /**
   * Run the provisioned remote harness inside a container on the remote host,
   * using the prebuilt sandbox image (the closure ships inside the image, so
   * this path needs no remote Node and no closure shipping). Only meaningful
   * when `provision` is set — a sandbox with nothing provisioned has nothing
   * to run, and that combination must refuse loudly rather than run bare.
   */
  sandbox?: SandboxOptions
}

/** How a provisioned remote instance ships and runs the harness closure. */
export interface ProvisionOptions {
  /**
   * Target to require instead of auto-detecting, as `platform-arch[-libc]`
   * (for example `linux-x64-glibc`). Detection already reads `uname`, so this
   * exists to override it, not to satisfy it.
   */
  target?: string
  /** Remote directory for the closure; default `$HOME/.dsh-desktop/harness`. */
  remoteRoot?: string
  /** Filesystem path of the node runtime on the remote; default `node` from PATH. */
  nodePath?: string
}

/**
 * How one harness process is isolated. Same shape for local and remote: it
 * hangs off `LocalOptions` for a local instance and off `SshOptions` (next to
 * `provision`) for a remote one, mirroring how `provision` extended the SSH
 * branch instead of inventing a fourth instance kind.
 */
export interface SandboxOptions {
  /**
   * Whether the harness runs inside a container. Default true when the field
   * is absent (containerized is the built-in default); `false` opts this
   * instance out and restores the direct host-process behavior.
   */
  enabled?: boolean
  /**
   * Container image. The default image bakes the fork's harness closure and
   * every plugin, so neither this machine nor the remote needs a Node install
   * or a staged closure.
   */
  image?: string
  /** Directories mounted into the container. `readOnly` defaults false. */
  mounts?: Array<{ hostPath: string; containerPath?: string; readOnly?: boolean }>
  /**
   * Directory backing the container's `$DSH_HOME`, mounted read-write. Left
   * absent, the supervisor picks a sandbox-private directory per instance:
   * sharing the host's real `~/.dsh` would hand the container the same model
   * credentials the host has.
   */
  dshHome?: string
  /** Extra argv spliced into `docker run` before the image (never after). */
  runArgs?: string[]
  /** Outbound network for the container. Default true; false maps to `--network none`. */
  outboundNetwork?: boolean
}

/** The default image: the fork's closure + all plugins, published by CI. */
export const DEFAULT_SANDBOX_IMAGE = 'ghcr.io/n0pe-sled/dsh-sandbox:latest'

/** The relay port inside the container; the harness stays on container loopback. */
export const SANDBOX_RELAY_PORT = 3081

/** Local instance: spawned `dsh web` child process. */
export interface LocalOptions {
  /**
   * dsh executable to spawn instead of the bundled harness. Omitted (or empty)
   * uses the harness closure this build ships, launched through the app's own
   * Electron binary as its Node runtime — no Node install, no PATH entry.
   * Meaningless while the sandbox is enabled: a container boots the image.
   */
  dshPath?: string
  /** Extra args appended after `web --port 0 --no-open`. */
  dshArgs?: string[]
  /** Extra environment (e.g. DSH_HOME). */
  env?: Record<string, string>
  /** Container sandbox; absent field means the built-in default (enabled). */
  sandbox?: SandboxOptions
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
  /**
   * Harness revision actually running, when it is knowable (a provisioned
   * remote, or the bundled closure). This is what makes "am I on the fork"
   * checkable at a glance: the fork and upstream publish under the same version
   * string, so only the revision distinguishes them.
   */
  revision?: string
  /** Where the running harness came from, when known. */
  origin?: HarnessOrigin
}

/** Provenance of a running harness, shown in the instance row. */
export interface HarnessOrigin {
  /** Cache key or revision identity of the closure. */
  closureKey?: string
  /** Target the closure was built for, as `platform-arch[-libc]`. */
  target?: string
  /** True when this app shipped the closure to the host over ssh. */
  provisioned?: boolean
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
  /** Container sandbox; absent means the built-in default (enabled). */
  sandbox?: SandboxOptions
}

export interface AddSshInput {
  name: string
  ssh: SshOptions
}

export interface AddRawInput {
  name: string
  url: string
}
