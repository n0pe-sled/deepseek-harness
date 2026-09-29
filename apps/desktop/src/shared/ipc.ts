/**
 * IPC channel names shared between main, preload, and renderer.
 * Channel names are the single source of truth; never hand-write literals elsewhere.
 */

export const IPC = {
  // manager ⇄ main (invoke: renderer → main)
  managerList: 'manager:list',
  managerAddLocal: 'manager:add-local',
  managerAddSsh: 'manager:add-ssh',
  managerAddRaw: 'manager:add-raw',
  managerRemove: 'manager:remove',
  managerConnect: 'manager:connect',
  managerDisconnect: 'manager:disconnect',
  managerActive: 'manager:get-active',
  managerPickDsh: 'manager:pick-dsh',
  /** shell → main: open (or focus) the instance manager window. */
  managerOpenInstances: 'manager:open-instances',
  /** instance manager → main: close its own window once a launch is under way. */
  managerCloseInstances: 'manager:close-instances',
  /** shell → main: the connection log for one instance. */
  managerGetLog: 'manager:get-log',
  /** shell → main: open (or focus) the connection-log window for one instance. */
  managerOpenLog: 'manager:open-log',

  // main → manager renderer (send)
  managerUpdate: 'manager:update',
  managerActiveChanged: 'manager:active-changed',
  /** main → log window: the log for the instance that window is showing. */
  managerLogUpdate: 'manager:log-update',

  // connection view (the in-tab page shown while connecting, or after a failure).
  // It loads in the content view, which carries the dsh preload rather than the
  // manager preload, so it needs its own channels.
  /** connection view → main: the snapshot for the instance in its URL. */
  connectionGet: 'connection:get',
  /** connection view → main: try the connection again. */
  connectionRetry: 'connection:retry',
  /** main → connection view: a fresh snapshot. */
  connectionUpdate: 'connection:update',

  // top bar (session tabs) chrome
  /** shell → main: apply a top-bar visibility preference (restored from storage). */
  uiTopbarSet: 'ui:topbar-set',
  /** main → shell: mirror the applied visibility so the shell can persist it. */
  uiTopbarChanged: 'ui:topbar-changed',

  // dsh content view transport (invoke / send)
  dshUnary: 'dsh:unary',
  dshRpc: 'dsh:rpc',
  dshStreamOpen: 'dsh:stream:open',
  dshStreamClose: 'dsh:stream:close',
  dshStreamOpenResult: 'dsh:stream:open-result',
  dshStreamFrame: 'dsh:stream:frame',
  dshStreamEnded: 'dsh:stream:ended',

  // content view → main: the dsh page's resolved theme, so the shell can match it.
  dshTheme: 'dsh:theme',
  // main → manager renderer: forward the resolved theme to the sidebar.
  managerTheme: 'manager:theme',
  // manager renderer → main: pull the current theme on boot (side-steps a startup race).
  managerGetTheme: 'manager:get-theme',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Which add-instance modal the File menu asks the shell to open. */
export type AddKind = 'local' | 'ssh' | 'raw'

/**
 * What the connection-log window renders. One snapshot per update: the log is
 * short and replaced wholesale, so a diffing protocol would buy nothing.
 */
export interface ConnectionLogSnapshot {
  instanceId: string
  name: string
  /** What the connect is doing, one line, e.g. "ssh box, forwarding remote port 3000". */
  target: string
  status: string
  lines: string[]
  /** Present only while the instance is in the error state. */
  error?: string
}

/**
 * A message on the log channel. Snapshots carry the log; `retarget` tells an
 * already-open window to switch instance without a reload, which is what keeps a
 * reader's scroll position when main reuses one window for a second connect.
 */
export type ConnectionLogMessage = ConnectionLogSnapshot | { retarget: string }

/** Narrowing helper, so neither side has to guess which shape arrived. */
export function isLogRetarget(message: ConnectionLogMessage): message is { retarget: string } {
  return 'retarget' in message
}

/** The API the in-tab connection view gets from the dsh preload. */
export interface DshConnectionApi {
  /** The snapshot for one instance, or the active one when no id is given. */
  get(instanceId?: string): Promise<ConnectionLogSnapshot | undefined>
  /** Ask main to try again; resolves when the attempt finishes. */
  retry(instanceId?: string): Promise<void>
  /** Subscribe to snapshots pushed while this page is displayed. */
  onUpdate(cb: (snapshot: ConnectionLogSnapshot) => void): () => void
}

export type StreamKind = 'mux' | 'host'

/** Renderer → main: one unary POST. `path` is the wire path (e.g. /api/session.list). */
export interface DshUnaryRequest {
  path: string
  /** JSON string of the full ClientRequest envelope. */
  body: string
}

/** Renderer → main: a generic connection RPC fetch (Typert gateway). */
export interface DshRpcRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** Main → renderer: relay result, kept as text so the renderer can rebuild a Response. */
export interface DshHttpResult {
  status: number
  bodyText: string
  contentType?: string
}

export interface DshStreamOpenEvent {
  kind: StreamKind
}

export interface DshStreamOpenResult {
  kind: StreamKind
  ok: boolean
  error?: string
}

/** Main → renderer: one ServerRequest envelope (already JSON-parsed) on a stream. */
export interface DshStreamFrameEvent {
  kind: StreamKind
  envelope: unknown
}

export interface DshStreamEndedEvent {
  kind: StreamKind
}

/**
 * One resolved dsh theme snapshot, read from the content page's `--dsw-alias-*`
 * tokens. Values are normalized to `#rrggbb` (or `#rrggbbaa`) so the shell can
 * paint its chrome to match the active dsh theme.
 */
export interface AppTheme {
  colorScheme: 'dark' | 'light'
  /** Main background (`--dsw-alias-bg-base`). */
  background: string
  /** Raised surface (`--dsw-alias-bg-layer-1`). */
  panel: string
  /** Primary text (`--dsw-alias-label-primary`). */
  text: string
  /** Secondary text (`--dsw-alias-label-secondary`). */
  subtext: string
  /** Brand accent (`--dsw-alias-brand-primary`). */
  accent: string
  /** Border (`--dsw-alias-border-l1`). */
  border: string
}
