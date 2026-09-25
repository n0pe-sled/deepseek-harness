/**
 * DSH Desktop — main process entry.
 * Wires: instance store/manager, API + stream bridges, the dsh-app protocol,
 * and the app window, with clean shutdown of children and tunnels.
 */
import { app, dialog, ipcMain, Menu } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { IPC, type AddKind, type AppTheme, type ConnectionLogSnapshot } from '../shared/ipc.ts'
import type {
  AddLocalInput,
  AddRawInput,
  AddSshInput,
  InstanceView,
} from '../shared/instance.ts'
import { InstanceStore } from './instances/store.ts'
import { InstanceManager, describeTarget } from './instances/manager.ts'
import { bundledHarnessRoot } from './instances/bundled.ts'
import { ApiBridge } from './bridge/api.ts'
import { StreamBridge } from './bridge/streams.ts'
import { registerProtocolHandler, registerSchemePrivileges, connectionViewUrl } from './protocol.ts'
import { buildShellMenu, setTopbarChecked } from './menu.ts'
import { AppWindow } from './window.ts'
import { runSmoke } from './smoke.ts'

// Dev/testing affordance: point userData elsewhere so a dev build can run
// beside an installed copy holding the default profile's single-instance lock.
const userDataOverride = process.env.DSH_USER_DATA
if (userDataOverride) app.setPath('userData', userDataOverride)

registerSchemePrivileges()

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()

  const outDir = fileURLToPath(new URL('.', import.meta.url))
  const preloadDir = join(outDir, '..', 'preload')
  const rendererDir = join(outDir, '..', 'renderer')

  const store = new InstanceStore(app.getPath('userData'))
  const manager = new InstanceManager(store, describeHost, {
    // Provisioning ships one of the staged closures this build carries, so the
    // directory is the same one the local instance boots from: `Resources` in a
    // packaged app, the checkout's `resources/` in development.
    resourcesDir: dirname(bundledHarnessRoot()),
    // Sandbox-private DSH_HOME directories live under the app's own data dir,
    // so a container never needs the user's real ~/.dsh to work.
    sandboxDshHomeRoot: join(app.getPath('userData'), 'sandboxes'),
  })
  await manager.load()

  const appWindow = new AppWindow({
    managerPreload: join(preloadDir, 'manager.cjs'),
    dshPreload: join(preloadDir, 'dsh.cjs'),
    managerHtml: join(rendererDir, 'index.html'),
  })
  // A log window that finishes loading after the connect already failed still
  // needs the result, so main pushes the current snapshot on load.
  appWindow.onLogWindowReady((id) => appWindow.sendLog(logSnapshot(manager, id)))
  // Same for the in-tab connection page, which reloads on every attempt.
  appWindow.onContentReady(() => {
    const active = manager.getActive()
    if (active !== undefined) appWindow.sendConnection(logSnapshot(manager, active))
  })

  const deps = {
    contentWebContentsId: () => appWindow.contentId,
    activeId: () => manager.getActive(),
    endpointFor: (id: string) => manager.endpointOf(id),
    // Generic RPC requests carry the dsh-app origin host, so the bridge needs
    // the host→instance-id step; the same mapping the protocol handler uses.
    idForHost: (host: string) => manager.idForHost(host),
    // The protocol handler renders these when an instance is not connected, so a
    // failed connect explains itself in the content area.
    nameFor: (id: string) => manager.views().find((v) => v.config.id === id)?.config.name,
    failureFor: (id: string) => manager.errorOf(id),
  }
  const apiBridge = new ApiBridge(deps)
  const streamBridge = new StreamBridge(deps)
  apiBridge.register()
  streamBridge.register()

  registerProtocolHandler({
    idForHost: (host) => manager.idForHost(host),
    endpointFor: (id) => manager.endpointOf(id),
    // The in-tab connection view is the renderer build's own page, served from
    // disk so it shares the app's styles and needs no second copy of the markup.
    connectionPagePath: join(rendererDir, 'index.html'),
  })

  // Sidebar updates + active-instance switching.
  manager.subscribe((views) => {
    if (appWindow.topbarWebContents.isDestroyed()) return
    appWindow.topbarWebContents.send(IPC.managerUpdate, views)
    // While the connection page is on screen it is the only thing reporting
    // progress, so every state change pushes a fresh snapshot to it. The window
    // ignores snapshots for another instance, so this needs no guard here.
    const active = manager.getActive()
    if (active !== undefined) appWindow.sendConnection(logSnapshot(manager, active))
  })
  const applyActive = (): void => {
    const id = manager.getActive()
    streamBridge.setActive(id)
    const host = id === undefined ? undefined : manager.hostOf(id)
    if (id === undefined || host === undefined) {
      appWindow.showInstance(null)
      return
    }
    const runtime = manager.views().find((v) => v.config.id === id)?.runtime
    if (runtime?.status === 'running' && runtime.endpoint !== undefined) {
      appWindow.showInstance(`dsh-app://${host}/`)
    } else {
      // Starting or failed: show the app's own connection page in the tab, with
      // the reason and the live log, instead of a blank pane. This is the whole
      // feedback story for a connect, so it goes in the space the harness would
      // occupy rather than a separate window.
      appWindow.showInstance(connectionViewUrl(id))
    }
    appWindow.topbarWebContents.send(IPC.managerActiveChanged, id)
  }
  applyActive()

  registerManagerIpc(manager, appWindow, applyActive)

  // Match the shell chrome to the active dsh theme: the content page reports
  // its resolved tokens, we paint the native window and forward to the sidebar.
  const lastTheme: { value: AppTheme | undefined } = { value: undefined }
  ipcMain.on(IPC.dshTheme, (event, theme: AppTheme) => {
    if (event.sender.id !== appWindow.contentId) return
    if (!isValidTheme(theme)) return
    lastTheme.value = theme
    appWindow.win.setBackgroundColor(theme.background)
    if (!appWindow.topbarWebContents.isDestroyed()) {
      appWindow.topbarWebContents.send(IPC.managerTheme, theme)
    }
  })
  // The sidebar pulls the current theme on boot so a theme reported before the
  // sidebar finished subscribing is not lost (startup race).
  ipcMain.handle(IPC.managerGetTheme, (event): AppTheme | undefined => {
    if (event.sender.id !== appWindow.topbarWebContents.id) return undefined
    return lastTheme.value
  })

  // Top bar chrome. Main owns layout and the menu checkmark; the shell owns the
  // stored preference, so every change is echoed back for it to persist.
  let topbarVisible = true

  function applyTopbar(visible: boolean): void {
    topbarVisible = visible
    appWindow.setTopbarVisible(visible)
    setTopbarChecked(shellMenu, visible)
    const shell = appWindow.topbarWebContents
    if (!shell.isDestroyed()) shell.send(IPC.uiTopbarChanged, visible)
  }

  const shellMenu = buildShellMenu({
    onAdd: (kind: AddKind) => appWindow.openAddModal(kind),
    onToggleTopbar: () => applyTopbar(!topbarVisible),
  })
  setTopbarChecked(shellMenu, topbarVisible)
  Menu.setApplicationMenu(shellMenu)

  // The shell restores its stored preference once it boots.
  ipcMain.on(IPC.uiTopbarSet, (_event, visible: boolean) => applyTopbar(visible !== false))

  if (process.env.DSH_SMOKE === '1') {
    const code = await runSmoke(manager, appWindow, applyActive)
    await manager.stopAll()
    app.exit(code)
    return
  }

  // Quit semantics: stop local children and SSH tunnels, then exit.
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    streamBridge.closeAll()
    void manager.stopAll().finally(() => {
      app.quit()
    })
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('activate', () => {
    appWindow.win.show()
  })
}

/** One instance's connection log, shaped for the log window. */
function logSnapshot(manager: InstanceManager, id: string): ConnectionLogSnapshot {
  const view = manager.views().find((v) => v.config.id === id)
  return {
    instanceId: id,
    name: view?.config.name ?? id,
    target: view === undefined ? '' : describeTarget(view.config),
    status: view?.runtime.status ?? 'unknown',
    lines: manager.logOf(id),
    ...(manager.errorOf(id) === undefined ? {} : { error: manager.errorOf(id) }),
  }
}

function registerManagerIpc(
  manager: InstanceManager,
  appWindow: AppWindow,
  applyActive: () => void,
): void {
  ipcMain.handle(IPC.managerList, (): InstanceView[] => manager.views())

  ipcMain.handle(IPC.managerAddLocal, (_e, input: AddLocalInput): InstanceView => {
    const view = manager.addLocal(input)
    appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
    return view
  })

  ipcMain.handle(IPC.managerAddSsh, (_e, input: AddSshInput): InstanceView => {
    const view = manager.addSsh(input)
    appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
    return view
  })

  ipcMain.handle(IPC.managerAddRaw, (_e, input: AddRawInput): InstanceView => {
    const view = manager.addRaw(input)
    appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
    return view
  })

  ipcMain.handle(IPC.managerRemove, async (_e, id: string): Promise<void> => {
    await manager.remove(id)
    applyActive()
    appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
  })

  ipcMain.handle(IPC.managerConnect, async (_e, id: string): Promise<InstanceView> => {
    // Show the connection page immediately rather than waiting for connect() to
    // finish: the point is to watch the attempt happen.
    manager.setActive(id)
    applyActive()
    try {
      return await manager.connect(id)
    } finally {
      applyActive()
      appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
      const snapshot = logSnapshot(manager, id)
      appWindow.sendLog(snapshot)
      appWindow.sendConnection(snapshot)
    }
  })

  ipcMain.handle(IPC.managerDisconnect, async (): Promise<void> => {
    await manager.disconnect(manager.getActive() ?? '')
    applyActive()
  })

  ipcMain.handle(IPC.managerActive, (): string | undefined => manager.getActive())

  ipcMain.handle(IPC.managerGetLog, (_e, id: string): ConnectionLogSnapshot | undefined => {
    return manager.views().some((v) => v.config.id === id) ? logSnapshot(manager, id) : undefined
  })

  ipcMain.on(IPC.managerOpenLog, (_e, id: string): void => {
    if (typeof id !== 'string' || !manager.views().some((v) => v.config.id === id)) return
    appWindow.openLogWindow(id)
    appWindow.sendLog(logSnapshot(manager, id))
  })

  // The in-tab connection view lives in the content view, which has the dsh
  // preload, so it reaches main through its own channels.
  ipcMain.handle(IPC.connectionGet, (event, id?: string): ConnectionLogSnapshot | undefined => {
    if (event.sender.id !== appWindow.contentId) return undefined
    const target = typeof id === 'string' && id !== '' ? id : manager.getActive()
    if (target === undefined) return undefined
    return manager.views().some((v) => v.config.id === target) ? logSnapshot(manager, target) : undefined
  })

  ipcMain.handle(IPC.connectionRetry, async (event, id?: string): Promise<void> => {
    if (event.sender.id !== appWindow.contentId) return
    const target = typeof id === 'string' && id !== '' ? id : manager.getActive()
    if (target === undefined) return
    if (!manager.views().some((v) => v.config.id === target)) return
    try {
      await manager.connect(target)
    } finally {
      applyActive()
      appWindow.topbarWebContents.send(IPC.managerUpdate, manager.views())
      const snapshot = logSnapshot(manager, target)
      appWindow.sendLog(snapshot)
      appWindow.sendConnection(snapshot)
    }
  })

  ipcMain.handle(IPC.managerPickDsh, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(appWindow.win, {
      title: 'Choose the dsh executable',
      properties: ['openFile'],
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.managerOpenAdd, (_e, kind: AddKind): void => {
    if (kind !== 'local' && kind !== 'ssh' && kind !== 'raw') return
    appWindow.openAddModal(kind)
  })
}

/** host.describe probe used for sidebar version display (same wire shape as the renderer bridge). */
async function describeHost(endpoint: string): Promise<{ version?: string } | undefined> {
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method: 'host.describe', payload: {} })
  const res = await fetch(`${endpoint}/api/host.describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`describe failed: HTTP ${res.status}`)
  const full = (await res.json()) as { rpcId?: string; result?: { ok?: boolean; value?: { version?: string } } }
  if (full.rpcId !== rpcId || full.result?.ok !== true) throw new Error('describe failed')
  return full.result.value
}

/** Accept only a well-formed theme report from the content page. */
function isValidTheme(theme: AppTheme): boolean {
  return typeof theme === 'object' && theme !== null
    && (theme.colorScheme === 'dark' || theme.colorScheme === 'light')
    && typeof theme.background === 'string'
    && typeof theme.panel === 'string'
    && typeof theme.text === 'string'
    && typeof theme.subtext === 'string'
    && typeof theme.accent === 'string'
    && typeof theme.border === 'string'
}
