/**
 * API bridge relay unit tests: the generic RPC channel must address one
 * instance through the dsh-app origin host — a regression here breaks every
 * Typert gateway call (plugin remotes) with "dsh: rpc target not found".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

import { ipcMain as mockedIpcMain } from 'electron'
import { ApiBridge } from '../../src/main/bridge/api.ts'
import type { DshRpcRequest } from '../../src/shared/ipc.ts'

function makeDeps(overrides: Partial<Parameters<typeof makeBridge>[0]> = {}): Parameters<typeof makeBridge>[0] {
  return {
    contentWebContentsId: () => 42,
    activeId: () => 'local-1',
    endpointFor: (id: string) => (id === 'local-1' ? 'http://127.0.0.1:57280' : undefined),
    idForHost: (host: string) => (host === '127.114.79.254' ? 'local-1' : undefined),
    ...overrides,
  }
}

function makeBridge(deps: ReturnType<typeof makeDeps>): ApiBridge {
  return new ApiBridge(deps)
}

function rpcRequest(url: string, method = 'POST', body = '{}'): DshRpcRequest {
  return { url, method, headers: { 'content-type': 'application/json' }, body }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('relayRpc', () => {
  it('maps the dsh-app loopback host to the instance endpoint and relays', async () => {
    const fetchMock = vi.fn(async () => new Response('{"type":"server-response"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge(makeDeps())
    const result = await bridge.relayRpc(rpcRequest('dsh-app://127.114.79.254/api/subscriptionOAuth/status', 'POST', '{"type":"client-request"}'))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(input).toBe('http://127.0.0.1:57280/api/subscriptionOAuth/status')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"type":"client-request"}')
    expect(result.status).toBe(200)
    expect(result.bodyText).toBe('{"type":"server-response"}')
    expect(result.contentType).toBe('application/json')
  })

  it('drops an empty body on non-GET requests', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge(makeDeps())
    await bridge.relayRpc(rpcRequest('dsh-app://127.114.79.254/api/x/bar', 'POST', ''))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeUndefined()
  })

  it('forwards GET without a body', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge(makeDeps())
    await bridge.relayRpc(rpcRequest('dsh-app://127.114.79.254/api/x/bar', 'GET', ''))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeUndefined()
  })

  it('throws rpc target not found when the host maps to no instance', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const bridge = makeBridge(makeDeps())
    await expect(bridge.relayRpc(rpcRequest('dsh-app://203.0.113.9/api/plugin/test'))).rejects.toThrow('dsh: rpc target not found')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws rpc target not found when the mapped instance is not connected', async () => {
    const bridge = makeBridge(makeDeps({ endpointFor: () => undefined }))
    await expect(bridge.relayRpc(rpcRequest('dsh-app://127.114.79.254/api/plugin/test'))).rejects.toThrow('dsh: rpc target not found')
  })
})

describe('register wiring', () => {
  it('guards the dsh:rpc handler against foreign senders', async () => {
    const bridge = makeBridge(makeDeps())
    bridge.register()
    expect(mockedIpcMain.handle).toHaveBeenCalledTimes(2)
    const [, handler] = mockedIpcMain.handle.mock.calls.find(([channel]) => channel === 'dsh:rpc') as unknown as [string, (event: unknown, request: unknown) => Promise<unknown>]
    await expect(handler({ sender: { id: 43 } }, rpcRequest('dsh-app://127.114.79.254/api/x'))).rejects.toThrow('dsh: untrusted caller')
  })
})
