/**
 * DSH content-view preload: installs the harness's `__DSH_TRANSPORT__` carrier
 * hooks before the page boot scripts run. The client implements the same wire
 * invariants as AbstractApiClient (rpcId mint/echo, four-quadrant envelopes)
 * but is deliberately version-agnostic: domain methods are generated, so a
 * host UI with newer methods keeps working without shipping harness packages.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AppTheme, type DshStreamOpenResult, type StreamKind } from '../shared/ipc.ts'

interface RpcResponseLike {
  rpcId: string
  result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

const DOMAINS: Record<string, string> = {
  sessions: 'session',
  subagents: 'subagent',
  host: 'host',
  workspace: 'workspace',
  skills: 'skill',
  agentPresets: 'agentPreset',
  goals: 'goal',
  settings: 'settings',
  credentials: 'credentials',
  llm: 'llm',
}

/** IpcApiClient: IApiClient-shaped object; unary via IPC, streams via IPC frames. */
function createApiClient(): object {
  const api: Record<string, unknown> = {
    events: {
      mux: (payload: unknown, signal: AbortSignal | undefined, onOpen?: () => void) => openStream('mux', signal, onOpen),
      host: (payload: unknown, signal: AbortSignal | undefined, onOpen?: () => void) => openStream('host', signal, onOpen),
    },
    respond: (message: unknown, signal?: AbortSignal) => respondCall(message, signal),
  }
  for (const [domainKey, wireDomain] of Object.entries(DOMAINS)) {
    api[domainKey] = domainProxy(wireDomain)
  }
  return api
}

function domainProxy(wireDomain: string): unknown {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      // Guard thenable confusion: IApiClient is never itself awaitable.
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      return (payload: unknown, signal?: AbortSignal) => unaryCall(`${wireDomain}.${prop}`, payload, signal)
    },
  })
}

/** Unary protocol path: mint → send full ClientRequest → parse ServerResponse → verify echo. */
async function unaryCall(method: string, payload: unknown, signal?: AbortSignal): Promise<RpcResponseLike> {
  const rpcId = crypto.randomUUID()
  const envelope = { type: 'client-request', rpcId, method, payload }
  const result = await invokeWithAbort<{ status: number; bodyText: string }>(
    IPC.dshUnary,
    { path: `/api/${method}`, body: JSON.stringify(envelope) },
    signal,
  )
  if (result.status !== 200) {
    throw new Error(`transport failure for ${method}: HTTP ${result.status}`)
  }
  const full = JSON.parse(result.bodyText) as { type?: string; rpcId?: string; result?: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
  if (full.type !== 'server-response' || full.rpcId === undefined || full.result === undefined) {
    throw new Error(`malformed server response for ${method}`)
  }
  if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}: sent ${rpcId}, got ${full.rpcId}`)
  return { rpcId: full.rpcId, result: full.result }
}

/** respond: client-response passthrough; rpcId is an echo, never minted here. */
async function respondCall(message: unknown, signal?: AbortSignal): Promise<unknown> {
  const result = await invokeWithAbort<{ status: number; bodyText: string }>(
    IPC.dshUnary,
    { path: '/api/respond', body: JSON.stringify(message) },
    signal,
  )
  if (result.status !== 200) throw new Error(`transport failure for respond: HTTP ${result.status}`)
  return JSON.parse(result.bodyText) as unknown
}

/** One downlink stream: open with main, then pump IPC frames as narrow RpcRequest. */
async function* openStream(
  kind: StreamKind,
  signal: AbortSignal | undefined,
  onOpen?: () => void,
): AsyncGenerator<{ rpcId: string; payload: unknown }> {
  const frameHandler = (_e: IpcRendererEvent, ev: { kind: StreamKind; envelope: unknown }): void => {
    if (ev.kind !== kind) return
    const envelope = ev.envelope as { type?: string; rpcId?: string; payload?: unknown } | null
    if (envelope === null || envelope === undefined || envelope.type !== 'server-request') return
    queue.push({ rpcId: envelope.rpcId ?? '', payload: envelope.payload })
    wake?.()
  }
  const endHandler = (_e: IpcRendererEvent, ev: { kind: StreamKind }): void => {
    if (ev.kind !== kind) return
    ended = true
    wake?.()
  }
  const queue: { rpcId: string; payload: unknown }[] = []
  let wake: (() => void) | undefined
  let ended = false
  ipcRenderer.on(IPC.dshStreamFrame, frameHandler)
  ipcRenderer.on(IPC.dshStreamEnded, endHandler)
  try {
    const opened = await new Promise<DshStreamOpenResult>((resolve) => {
      const timer = setTimeout(() => resolve({ kind, ok: false, error: 'stream open timed out' }), 30_000)
      const handler = (_e: IpcRendererEvent, ev: DshStreamOpenResult): void => {
        if (ev.kind !== kind) return
        clearTimeout(timer)
        ipcRenderer.removeListener(IPC.dshStreamOpenResult, handler)
        resolve(ev)
      }
      ipcRenderer.on(IPC.dshStreamOpenResult, handler)
      ipcRenderer.send(IPC.dshStreamOpen, { kind })
    })
    if (!opened.ok) throw new Error(opened.error ?? 'stream open failed')
    onOpen?.()
    while (!ended) {
      if (queue.length > 0) {
        const item = queue.shift()
        if (item !== undefined) yield item
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    ipcRenderer.removeListener(IPC.dshStreamFrame, frameHandler)
    ipcRenderer.removeListener(IPC.dshStreamEnded, endHandler)
    ipcRenderer.send(IPC.dshStreamClose, { kind })
  }
}

/** Generic RPC fetch used by the Typert gateway channel (same signature as fetch). */
function rpcFetch(input: URL, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {}
  if (init.headers !== undefined) {
    if (init.headers instanceof Headers) {
      for (const [name, value] of init.headers.entries()) headers[name] = value
    } else if (Array.isArray(init.headers)) {
      for (const [name, value] of init.headers) headers[name] = value
    } else {
      Object.assign(headers, init.headers)
    }
  }
  const body = typeof init.body === 'string' ? init.body : init.body == null ? '' : String(init.body)
  return invokeWithAbort<{ status: number; bodyText: string; contentType?: string }>(
    IPC.dshRpc,
    { url: input.href, method: init.method ?? 'GET', headers, body },
    init.signal ?? undefined,
  ).then((result) => {
    return new Response(result.bodyText, {
      status: result.status,
      headers: result.contentType !== undefined ? { 'content-type': result.contentType } : undefined,
    })
  })
}

/** invoke with abort propagation (the base class relies on signal rejection). */
function invokeWithAbort<T>(channel: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('This operation was aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const pending = ipcRenderer.invoke(channel, payload) as Promise<T>
    if (signal === undefined) {
      pending.then(resolve, reject)
      return
    }
    const onAbort = (): void => {
      reject(new DOMException('This operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// Install before page scripts execute: preloads run first, and the connection
// plugin reads the global during client boot.
Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
  value: { createApiClient, fetch: rpcFetch },
  writable: false,
  configurable: false,
})

// ---- Shell chrome: match the dsh theme + provide a draggable top edge ----

/** Height (px) of the transparent draggable strip over the content pane. */
const TITLEBAR_HEIGHT = 14

/**
 * Start the shell-chrome hooks for a dsh-app page: a thin draggable strip at
 * the very top so the window can be grabbed anywhere along its top edge, and a
 * theme sync that reports the dsh page's resolved `--dsw-alias-*` tokens to the
 * main process. Non-dsh-app documents (the initial about:blank) are skipped.
 */
function installShellChrome(): void {
  if (window.location.protocol !== 'dsh-app:') return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installShellChromeNow, { once: true })
  } else {
    installShellChromeNow()
  }
}

function installShellChromeNow(): void {
  injectDragStrip()
  watchTheme()
}

/** Add a thin, transparent, full-width drag region over the content pane. */
function injectDragStrip(): void {
  if (document.getElementById('dsh-desktop-titlebar') !== null) return
  const bar = document.createElement('div')
  bar.id = 'dsh-desktop-titlebar'
  bar.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'right: 0',
    `height: ${String(TITLEBAR_HEIGHT)}px`,
    '-webkit-app-region: drag',
    'z-index: 2147483646',
  ].join(';')
  document.body.appendChild(bar)
}

/** Watch the dsh document for theme changes and report resolved colors to main. */
function watchTheme(): void {
  let last = ''
  const publish = (): void => {
    const theme = readAppTheme()
    if (theme === undefined) return
    const key = JSON.stringify(theme)
    if (key === last) return
    last = key
    ipcRenderer.send(IPC.dshTheme, theme)
  }
  publish()
  const observer = new MutationObserver(() => {
    // Debounce: a theme apply touches many nodes in one tick.
    window.setTimeout(publish, 50)
  })
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    childList: true,
    attributeFilter: ['style', 'data-ds-dark-theme', 'class', 'content'],
  })
}

/** Read the resolved theme snapshot from the page's token variables. */
function readAppTheme(): AppTheme | undefined {
  const body = document.body
  const rootStyleScheme = document.documentElement.style.colorScheme
  let colorScheme: 'dark' | 'light'
  if (rootStyleScheme === 'light') colorScheme = 'light'
  else if (rootStyleScheme === 'dark') colorScheme = 'dark'
  else colorScheme = body.hasAttribute('data-ds-dark-theme')
    || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light'

  // The presenter sets meta[theme-color] to the computed body background, the
  // most authoritative color for a seamless shell; fall back to the bg token.
  const meta = document.querySelector('meta[name="theme-color"]')
  const metaRaw = meta?.getAttribute('content')?.trim() ?? ''
  const metaBg = metaRaw === '' ? undefined : toHex(metaRaw)
  const background = metaBg ?? resolveToken('--dsw-alias-bg-base')
  const panel = resolveToken('--dsw-alias-bg-layer-1')
  const text = resolveToken('--dsw-alias-label-primary')
  const subtext = resolveToken('--dsw-alias-label-secondary')
  // The saturated brand colour: the built-in dark theme makes `brand-primary` a
  // near-white surface (a light-fill role), so use the explicit brand-primary
  // "new" colour (DeepSeek blue built-in, palette accent for herdr themes) and
  // fall back to `brand-primary`, then text.
  const accent = resolveToken('--dsw-alias-brand-primary-new-colorprimary-new-color')
    ?? resolveToken('--dsw-alias-brand-primary')
  const border = resolveToken('--dsw-alias-border-l1')

  if (background === undefined || text === undefined) return undefined
  return {
    colorScheme,
    background,
    panel: panel ?? background,
    text,
    subtext: subtext ?? text,
    accent: accent ?? text,
    border: border ?? background,
  }
}

/** Resolve one custom property to a concrete color through a probe element. */
function resolveToken(token: string): string | undefined {
  const raw = getComputedStyle(document.body).getPropertyValue(token).trim()
  if (raw === '') return undefined
  const probe = document.createElement('div')
  probe.style.color = raw
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return toHex(resolved)
}

/** Normalize `rgb(r,g,b)` / `rgba(r,g,b,a)` to `#rrggbb` / `#rrggbbaa`. */
function toHex(color: string): string {
  const match = /^rgba?\(([^)]+)\)$/u.exec(color)
  if (match === null) return color
  const parts = match[1]!.split(',').map((part) => part.trim())
  const r = Number(parts[0])
  const g = Number(parts[1])
  const b = Number(parts[2])
  const a = parts.length > 3 ? Number(parts[3]) : 1
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return color
  const hex8 = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  if (a >= 1) return hex8
  return `${hex8}${Math.round(a * 255).toString(16).padStart(2, '0')}`
}

// Preloads run before page scripts; the document may not be ready yet.
installShellChrome()
