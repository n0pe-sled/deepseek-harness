/**
 * Stream bridge: opens one WS downlink per event stream to the active
 * instance and forwards ServerRequest envelopes to the content renderer over
 * IPC. Closing on instance switch aborts the old generation; the client's
 * reconnect loop reopens on the new generation.
 */
import { ipcMain, webContents } from 'electron'
import WebSocket from 'ws'
import {
  IPC,
  type DshStreamFrameEvent,
  type DshStreamOpenEvent,
  type DshStreamOpenResult,
  type StreamKind,
} from '../../shared/ipc.ts'

export interface StreamBridgeDeps {
  contentWebContentsId(): number | undefined
  activeId(): string | undefined
  endpointFor(id: string): string | undefined
}

const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

interface Downlink {
  socket: WebSocket
  opened: boolean
}

export class StreamBridge {
  private readonly downlinks = new Map<string, Downlink>()
  private lastActive: string | undefined

  constructor(private readonly deps: StreamBridgeDeps) {}

  register(): void {
    ipcMain.on(IPC.dshStreamOpen, (event, msg: DshStreamOpenEvent) => {
      if (event.sender.id !== this.deps.contentWebContentsId()) return
      const id = this.deps.activeId()
      if (id === undefined) return
      this.open(id, msg.kind, event.sender.id)
    })

    ipcMain.on(IPC.dshStreamClose, (event, msg: DshStreamOpenEvent) => {
      if (event.sender.id !== this.deps.contentWebContentsId()) return
      const id = this.deps.activeId()
      if (id !== undefined) this.close(`${id}:${msg.kind}`)
    })
  }

  /** Called when the active instance changes: drop every socket of the old generation. */
  setActive(id: string | undefined): void {
    if (id === this.lastActive) return
    for (const key of [...this.downlinks.keys()]) {
      // Keep sockets of the new instance to avoid a reconnect burst; close the rest.
      if (!key.startsWith(`${id ?? '__none__'}:`)) this.close(key)
    }
    this.lastActive = id
  }

  closeAll(): void {
    for (const key of [...this.downlinks.keys()]) this.close(key)
    this.lastActive = undefined
  }

  private open(id: string, kind: StreamKind, wcId: number): void {
    const key = `${id}:${kind}`
    this.close(key)
    const endpoint = this.deps.endpointFor(id)
    if (endpoint === undefined) {
      this.sendResult(wcId, { kind, ok: false, error: 'instance not connected' })
      return
    }
    const url = toWsUrl(endpoint, kind === 'mux' ? MUX_PATH : HOST_PATH)
    const socket = new WebSocket(url)
    const downlink: Downlink = { socket, opened: false }
    this.downlinks.set(key, downlink)

    socket.on('open', () => {
      downlink.opened = true
      this.sendResult(wcId, { kind, ok: true })
    })
    socket.on('message', (data) => {
      const wc = wcFromId(wcId)
      if (wc === undefined || wc.isDestroyed()) return
      const frame: DshStreamFrameEvent = { kind, envelope: JSON.parse(String(data)) }
      wc.send(IPC.dshStreamFrame, frame)
    })
    const finish = (error?: string): void => {
      if (this.downlinks.get(key) === downlink) this.downlinks.delete(key)
      if (!downlink.opened && error !== undefined) this.sendResult(wcId, { kind, ok: false, error })
      const wc = wcFromId(wcId)
      if (wc !== undefined && !wc.isDestroyed()) wc.send(IPC.dshStreamEnded, { kind })
    }
    socket.on('close', () => finish())
    socket.on('error', (error: Error) => finish(error.message))
  }

  private close(key: string): void {
    const downlink = this.downlinks.get(key)
    if (downlink === undefined) return
    this.downlinks.delete(key)
    if (downlink.socket.readyState === WebSocket.OPEN || downlink.socket.readyState === WebSocket.CONNECTING) {
      downlink.socket.close()
    }
  }

  private sendResult(wcId: number, result: DshStreamOpenResult): void {
    const wc = wcFromId(wcId)
    wc?.send(IPC.dshStreamOpenResult, result)
  }
}

function toWsUrl(endpoint: string, path: string): string {
  const url = new URL(path, endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function wcFromId(id: number): Electron.WebContents | undefined {
  return webContents.fromId(id)
}
