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
import { readFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

const SCHEME = 'dsh-app'

/**
 * Reserved host for the app's own in-tab pages (the connection view).
 *
 * It has to be a loopback literal like every instance host, because the content
 * view is one shared page whose security classification is read from
 * `location.hostname`; a non-loopback internal host would look like untrusted
 * remote content. `127.0.0.0` is inside 127/8 and is never handed out to an
 * instance by `deriveLoopbackHost`, which builds 127.a.b.c with a, b, c >= 1.
 */
export const APP_VIEW_HOST = '127.0.0.0'

/** The connection view's URL. Loaded in the content view instead of an instance. */
export function connectionViewUrl(instanceId: string): string {
  return `${SCHEME}://${APP_VIEW_HOST}/?connection=${encodeURIComponent(instanceId)}`
}

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
  /** Display name for one instance id, for the connection view. */
  nameFor?(id: string): string | undefined
  /** The last connection failure for one instance id, for the connection view. */
  failureFor?(id: string): string | undefined
  /** The connection view's HTML asset, resolved by main from the renderer build. */
  connectionPagePath?: string
}

/**
 * The in-tab connection view.
 *
 * This used to be a static `404 instance not connected`, and before that a blank
 * content area: either way a failed connect told the user nothing. It is now the
 * real renderer page, loaded with `?connection=<id>`, so it can show the
 * instance, the failure reason, and the live log in the space where the harness
 * would have been. Served from the built asset rather than inlined as a string so
 * it shares the app's styles and needs no second source of truth for markup.
 *
 * The page's own asset references are relative (`./assets/index-*.js`), so those
 * requests arrive here too and have to be answered from the same directory with
 * the right content type. Returning the HTML for every path would leave the page
 * unstyled and inert, which is a failure that looks like a broken build.
 */
async function serveConnectionView(deps: ProtocolDeps, url: URL): Promise<Response> {
  const html = deps.connectionPagePath
  if (html === undefined) return new Response('connection view unavailable', { status: 500 })
  const dir = dirname(html)
  // Resolve every request against the directory that holds the page, so both
  // `./assets/x.css` and a bare `assets/x.css` land in the same place. Resolving
  // from the URL root would put them one level up and 404 every asset, which
  // looks like a broken build rather than a path bug.
  const requested = decodeURIComponent(url.pathname).replace(/^\/+/u, '')
  const file = requested === '' ? resolve(html) : resolve(dir, requested)
  // Stay inside the renderer directory: a traversal would otherwise read any file.
  if (file !== resolve(html) && !file.startsWith(`${dir}${sep}`)) {
    return new Response('not found', { status: 404 })
  }
  try {
    const body = await readFile(file)
    return new Response(body, { status: 200, headers: { 'content-type': contentTypeFor(file) } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** Content type for a renderer asset. Only the types this page needs. */
function contentTypeFor(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.json') || file.endsWith('.webmanifest')) return 'application/json; charset=utf-8'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

export function registerProtocolHandler(deps: ProtocolDeps): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host === APP_VIEW_HOST) return serveConnectionView(deps, url)
    const id = deps.idForHost(url.host)
    if (id === undefined) {
      return new Response('unknown instance', { status: 404 })
    }
    const endpoint = deps.endpointFor(id)
    if (endpoint === undefined) {
      // Not connected: main decides between the connection view and this proxy,
      // but a request that arrives here anyway must not look like a broken page.
      return new Response('instance not connected', { status: 503 })
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
