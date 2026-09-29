/**
 * Smoke test (DSH_SMOKE=1): spawn a real local dsh, connect, load the content
 * view, and verify the harness UI boots over the dsh-app protocol with our
 * IPC transport installed. Prints one SMOKE line and returns the exit code.
 *
 * DSH_SMOKE_DSH selects the dsh executable; unset means the bundled harness,
 * which is the packaged default and therefore the thing CI must prove.
 *
 * The smoke instance runs unsandboxed. The gate is about the bundled closure
 * booting, and a CI runner has no container runtime to sandbox in, so the default
 * sandbox would fail this step for a reason that has nothing to do with the
 * closure. The container path has its own gated live test:
 * tests/unit/sandbox-launch.integration.test.ts (DSH_SANDBOX_PROBE=1).
 */
import type { InstanceManager } from './instances/manager.ts'
import type { AppWindow } from './window.ts'

const LOAD_TIMEOUT_MS = 120_000
/**
 * Accepted document titles. The harness sets its own title and has renamed it
 * across revisions: the pinned ref this app stages serves "DSH Local Build", and
 * the fork's newer revisions serve "n0pe-sled AI". A rebrand must not fail this
 * gate, so every title a staged closure can serve is accepted, and a title this
 * app does not know fails loudly. DSH_SMOKE_TITLE overrides the list.
 */
const DEFAULT_TITLES = ['DeepSeek Harness', 'DSH Local Build', 'n0pe-sled AI']

export async function runSmoke(manager: InstanceManager, appWindow: AppWindow, applyActive: () => void): Promise<number> {
  const dshPath = process.env.DSH_SMOKE_DSH ?? undefined
  const expectedTitles = process.env.DSH_SMOKE_TITLE === undefined
    ? DEFAULT_TITLES
    : [process.env.DSH_SMOKE_TITLE]
  const harnessLabel = dshPath === undefined ? 'bundled' : `path:${dshPath}`
  try {
    const view = manager.addLocal({ name: 'smoke', dshPath, sandbox: { enabled: false } })
    const id = view.config.id
    const connected = await manager.connect(id)
    if (connected.runtime.status !== 'running') {
      // Report the status too: 'starting' means the readiness line never
      // arrived, which is a different failure from a launch error.
      console.error(`SMOKE FAIL: instance not running (status=${connected.runtime.status}, harness=${harnessLabel}): ${connected.runtime.error ?? 'no error reported'}`)
      return 1
    }
    // The content view shows an instance only once the shell activates it, and
    // that normally happens in an IPC handler. Do it explicitly here, or the
    // pane stays on the empty state and every page assertion below fails.
    applyActive()

    const content = appWindow.contentWebContents
    await waitForLoad(content, LOAD_TIMEOUT_MS)
    const loadedUrl = content.getURL()

    const title = (await content.executeJavaScript('document.title')) as unknown
    const bootType = (await content.executeJavaScript('typeof window.__DSH_BOOT__')) as unknown
    const transportType = (await content.executeJavaScript('typeof window.__DSH_TRANSPORT__')) as unknown

    // The harness client gates every settings surface on the page origin being
    // loopback-classified (connection.isLoopback). The content view must load
    // from a 127.x.y.z host or Models/Plugins/General report "settings are
    // unavailable in this browser".
    const loopbackPage = (await content.executeJavaScript(`(function (h) {
      if (h === 'localhost' || h === '[::1]') return true
      const p = h.split('.')
      return p.length === 4 && p[0] === '127' && p.every((x) => /^\\d{1,3}$/.test(x) && Number(x) <= 255)
    })(location.hostname)`)) as unknown

    // The settings wire itself must answer through the transport (this is the
    // call the Models page and the Plugins tab read through the describe mirror).
    const settingsOk = await poll(async () => {
      const ok = (await content.executeJavaScript(
        'window.__DSH_TRANSPORT__.createApiClient().settings.describe({}).then((r) => r.result.ok === true).catch(() => false)',
      )) as unknown
      return ok === true
    }, LOAD_TIMEOUT_MS, 1000)

    const rootChildren = await poll(async () => {
      const count = (await content.executeJavaScript(
        '(function () { const r = document.getElementById("root"); return r == null ? -1 : r.childElementCount })()',
      )) as unknown
      return typeof count === 'number' && count > 0
    }, LOAD_TIMEOUT_MS, 1000)

    // The shell chrome: a thin draggable strip is injected over the content pane,
    // and the dsh theme is forwarded to the sidebar (its --bg becomes the theme bg).
    const dragStrip = await poll(async () => {
      const has = (await content.executeJavaScript(
        'document.getElementById("dsh-desktop-titlebar") !== null',
      )) as unknown
      return has === true
    }, LOAD_TIMEOUT_MS, 1000)
    const detectedBg = (await content.executeJavaScript(
      'getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim()',
    )) as unknown
    const sidebarThemed = await poll(async () => {
      const bg = (await appWindow.topbarWebContents.executeJavaScript(
        'document.documentElement.style.getPropertyValue("--bg")',
      )) as unknown
      return typeof bg === 'string' && /^#[0-9a-fA-F]{6}/u.test(bg)
    }, LOAD_TIMEOUT_MS, 1000)
    const sidebarAccent = (await appWindow.topbarWebContents.executeJavaScript(
      'document.documentElement.style.getPropertyValue("--accent").trim()',
    )) as unknown

    const titleOk = typeof title === 'string' && expectedTitles.includes(title)
    const ok = titleOk && bootType === 'object' && transportType === 'object'
      && loopbackPage === true && settingsOk && rootChildren && dragStrip === true && sidebarThemed
    console.log(`SMOKE: harness=${harnessLabel} url=${String(loadedUrl)} title=${String(title)} boot=${String(bootType)} transport=${String(transportType)} loopback=${String(loopbackPage)} settings=${String(settingsOk)} rootChildren=${String(rootChildren)} dragStrip=${String(dragStrip)} detectedBg=${String(detectedBg)} sidebarThemed=${String(sidebarThemed)} accent=${String(sidebarAccent)} => ${ok ? 'OK' : 'FAIL'}`)
    return ok ? 0 : 1
  } catch (error) {
    console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function waitForLoad(wc: Electron.WebContents, timeoutMs: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('content view load timed out')), timeoutMs)
    wc.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    wc.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer)
      reject(new Error(`content load failed: ${code} ${desc}`))
    })
  })
}

async function poll(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
