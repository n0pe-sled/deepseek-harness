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
  /** shell → main: open the add-instance modal window for one kind. */
  managerOpenAdd: 'manager:open-add',

  // main → manager renderer (send)
  managerUpdate: 'manager:update',
  managerActiveChanged: 'manager:active-changed',

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
