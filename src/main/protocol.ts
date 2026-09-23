/**
 * dsh-app://<loopbackHost>/... — the app's own content origin. The host is a
 * per-instance 127.x.y.z literal (see loopback-host.ts): the harness client
 * classifies the page's loopback-ness from location.hostname, and settings
 * surfaces only work when that is true. Every path is reverse-proxied to the
 * addressed instance's endpoint (index.html with the host's injected
 * __DSH_BOOT__, assets, plugin bundles). API/streams deliberately do NOT go
 * through this proxy: they travel over IPC (see bridge/*). The protocol keeps
 * the UI hosted by the app shell while remaining byte-identical to what the
 * instance serves, so there is no version drift between shell and host.
 */
import { net, protocol } from 'electron'

const SCHEME = 'dsh-app'

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

export interface ProtocolDeps {
  /** Instance id behind one loopback content host (undefined = unknown). */
  idForHost(host: string): string | undefined
  /** Endpoint for one instance id (undefined = not connected). */
  endpointFor(id: string): string | undefined
}

export function registerProtocolHandler(deps: ProtocolDeps): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = deps.idForHost(url.host)
    if (id === undefined) {
      return new Response('unknown instance', { status: 404 })
    }
    const endpoint = deps.endpointFor(id)
    if (endpoint === undefined) {
      return new Response('instance not connected', { status: 404 })
    }
    const target = `${endpoint}${url.pathname}${url.search}`
    try {
      return await net.fetch(target, {
        method: request.method,
        headers: selectiveHeaders(request.headers),
      })
    } catch (error) {
      return new Response(`proxy error: ${error instanceof Error ? error.message : String(error)}`, { status: 502 })
    }
  })
}

/** Forward only reader headers; browser markers/host stay with the endpoint request. */
function selectiveHeaders(headers: Headers): HeadersInit {
  const result: [string, string][] = []
  const keep = new Set(['accept', 'accept-language', 'cache-control', 'referer', 'range'])
  for (const [name, value] of headers.entries()) {
    if (keep.has(name.toLowerCase())) result.push([name, value])
  }
  return result
}
