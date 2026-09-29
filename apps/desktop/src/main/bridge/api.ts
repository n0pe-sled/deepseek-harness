/**
 * API bridge: relays renderer unary/RPC calls to the active instance's HTTP
 * endpoint. Main is the only network client, so the requests carry no browser
 * markers: an SSH-tunneled (loopback) endpoint passes dsh's trust fence, and
 * no remote content ever touches Electron directly.
 */
import { ipcMain } from 'electron'
import { IPC, type DshHttpResult, type DshRpcRequest, type DshUnaryRequest } from '../../shared/ipc.ts'

export interface ApiBridgeDeps {
  /** WebContents id of the dsh content view; only it may drive the bridge. */
  contentWebContentsId(): number | undefined
  /** Active instance id (set by the window/manager wiring). */
  activeId(): string | undefined
  /** Endpoint for one instance id. */
  endpointFor(id: string): string | undefined
  /** Instance id behind one loopback content host (dsh-app origins carry hosts, not ids). */
  idForHost(host: string): string | undefined
}

export class ApiBridge {
  constructor(private readonly deps: ApiBridgeDeps) {}

  register(): void {
    ipcMain.handle(IPC.dshUnary, async (event, request: DshUnaryRequest): Promise<DshHttpResult> => {
      assertCaller(event.sender.id, this.deps.contentWebContentsId())
      const id = this.deps.activeId()
      if (id === undefined) throw new Error('dsh: no active instance')
      if (!request.path.startsWith('/api/')) throw new Error('dsh: invalid api path')
      return this.relayPost(this.deps.endpointFor(id), request.path, request.body)
    })

    ipcMain.handle(IPC.dshRpc, async (event, request: DshRpcRequest): Promise<DshHttpResult> => {
      assertCaller(event.sender.id, this.deps.contentWebContentsId())
      return this.relayRpc(request)
    })
  }

  /**
   * Relay one generic RPC fetch (the Typert gateway channel). The request URL
   * is the content page's `<origin>/api/<endpoint>`: on the dsh-app scheme the
   * origin host is the per-instance loopback host (`dsh-app://127.a.b.c`), not
   * an instance id, so the host must map through `idForHost` first — passing
   * it straight to `endpointFor` never matches and fails every gateway call.
   */
  async relayRpc(request: DshRpcRequest): Promise<DshHttpResult> {
    const url = new URL(request.url)
    const id = this.deps.idForHost(url.host)
    const endpoint = id === undefined ? undefined : this.deps.endpointFor(id)
    if (endpoint === undefined) throw new Error('dsh: rpc target not found')
    const target = `${endpoint}${url.pathname}${url.search}`
    const res = await fetch(target, {
      method: request.method,
      headers: request.headers,
      // GET/HEAD cannot carry a body (the carrier rejects it), so only relay
      // bodies on body-ful methods; an empty relay stays a bodyless request.
      body: request.method === 'GET' || request.method === 'HEAD' || request.body === ''
        ? undefined
        : request.body,
    })
    return {
      status: res.status,
      bodyText: await res.text(),
      contentType: res.headers.get('content-type') ?? undefined,
    }
  }

  private async relayPost(endpoint: string | undefined, path: string, body: string): Promise<DshHttpResult> {
    if (endpoint === undefined) throw new Error('dsh: instance not connected')
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    return {
      status: res.status,
      bodyText: await res.text(),
      contentType: res.headers.get('content-type') ?? undefined,
    }
  }
}

function assertCaller(senderId: number, contentId: number | undefined): void {
  if (contentId === undefined || senderId !== contentId) throw new Error('dsh: untrusted caller')
}
