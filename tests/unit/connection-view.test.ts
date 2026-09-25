/**
 * The in-tab connection view's protocol branch.
 *
 * This page is served from the renderer build, and its own `<script>` and
 * `<link>` references are relative, so those requests arrive on the same
 * internal host. A handler that answers every path with the page HTML leaves the
 * view unstyled and inert, and the failure looks like a broken build rather than
 * a path bug, so both cases are pinned here along with the traversal guard.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Captured protocol.handle callback, so the handler can be called directly. */
let handler: ((request: Request) => Promise<Response>) | undefined

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: {
    handle: (_scheme: string, fn: (request: Request) => Promise<Response>) => { handler = fn },
    registerSchemesAsPrivileged: vi.fn(),
  },
}))

import { APP_VIEW_HOST, connectionViewUrl, registerProtocolHandler } from '../../src/main/protocol.ts'

const dirs: string[] = []

/** A renderer dist with a page and one asset beside it, like the real build. */
function makeRendererDir(): { html: string; css: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-renderer-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  const html = join(dir, 'index.html')
  const css = join(dir, 'assets', 'index-abc.css')
  writeFileSync(html, '<!doctype html><link rel="stylesheet" href="./assets/index-abc.css">')
  writeFileSync(css, 'body { background: #1a1d23; }')
  return { html, css }
}

beforeEach(() => {
  handler = undefined
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function register(connectionPagePath: string | undefined): void {
  registerProtocolHandler({
    idForHost: () => undefined,
    endpointFor: () => undefined,
    ...(connectionPagePath === undefined ? {} : { connectionPagePath }),
  })
}

const get = async (url: string): Promise<Response> => {
  if (handler === undefined) throw new Error('handler not registered')
  return await handler(new Request(url))
}

describe('the connection view host', () => {
  it('is a loopback literal, so the content view stays loopback-classified', () => {
    expect(APP_VIEW_HOST.startsWith('127.')).toBe(true)
  })

  it('builds a URL that carries the instance id', () => {
    expect(connectionViewUrl('ssh-ab12')).toContain('connection=ssh-ab12')
    expect(new URL(connectionViewUrl('ssh-ab12')).host).toBe(APP_VIEW_HOST)
  })
})

describe('serving the connection view', () => {
  it('serves the page itself at the host root', async () => {
    const { html } = makeRendererDir()
    register(html)
    const res = await get('dsh-app://127.0.0.0/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<link rel="stylesheet"')
  })

  it('serves the page when the URL carries the connection query', async () => {
    const { html } = makeRendererDir()
    register(html)
    const res = await get(connectionViewUrl('ssh-1'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!doctype html>')
  })

  it('serves a relative asset with its own content type', async () => {
    // Without this the page loads with no styles and no script, which reads as a
    // broken build rather than a path bug.
    const { html } = makeRendererDir()
    register(html)
    const res = await get('dsh-app://127.0.0.0/assets/index-abc.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(await res.text()).toContain('#1a1d23')
  })

  it('refuses to read outside the renderer directory', async () => {
    const { html } = makeRendererDir()
    register(html)
    const res = await get('dsh-app://127.0.0.0/../../../../etc/passwd')
    expect(res.status).toBe(404)
  })

  it('answers 404 for a missing asset instead of the page', async () => {
    const { html } = makeRendererDir()
    register(html)
    const res = await get('dsh-app://127.0.0.0/assets/nope.css')
    expect(res.status).toBe(404)
  })

  it('reports a build without the page rather than serving something else', async () => {
    register(undefined)
    const res = await get('dsh-app://127.0.0.0/')
    expect(res.status).toBe(500)
  })
})
