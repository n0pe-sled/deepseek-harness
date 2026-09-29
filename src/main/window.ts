/**
 * AppWindow: one macOS BrowserWindow holding two WebContentsViews. The top bar
 * carries the session tabs and the one Launch Instance button; the dsh content view
 * shows the active instance, served over the app's own protocol. The add form, the
 * connection log and the instance manager are child windows.
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { IPC } from '../shared/ipc.ts'
import type { AddKind, AppTheme, ConnectionLogMessage, ConnectionLogSnapshot } from '../shared/ipc.ts'
import type { InstanceView } from '../shared/instance.ts'
import { APP_VIEW_HOST } from './protocol.ts'
import { shellFrames } from './shell-layout.ts'

export interface AppWindowOptions {
  managerPreload: string
  dshPreload: string
  managerHtml: string
  /** The instance manager page, hosted in its own window. */
  instancesHtml: string
}

/** Add-form window size per kind: the form height follows the field count.
 *  Width/height are outer-window, so ~28px of title bar is inside each height. */
const ADD_MODAL_SIZE: Record<AddKind, { width: number; height: number }> = {
  local: { width: 400, height: 380 },
  ssh: { width: 400, height: 540 },
  raw: { width: 400, height: 350 },
}

export class AppWindow {
  readonly win: BrowserWindow
  private readonly topbar: WebContentsView
  private readonly content: WebContentsView
  private readonly managerPreload: string
  private readonly managerHtml: string
  private readonly instancesHtml: string
  private topbarVisible = true
  private addModal: BrowserWindow | null = null
  private logWindow: BrowserWindow | null = null
  private logWindowTarget: string | undefined
  private logWindowReady: ((instanceId: string) => void) | undefined
  private instancesWindow: BrowserWindow | null = null
  private instancesReady: (() => void) | undefined
  private contentReady: (() => void) | undefined

  constructor(opts: AppWindowOptions) {
    this.managerPreload = opts.managerPreload
    this.managerHtml = opts.managerHtml
    this.instancesHtml = opts.instancesHtml
    this.win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 980,
      minHeight: 620,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#1a1d23',
      webPreferences: {
        // The shell page is our own bundled content (trusted, local).
        preload: opts.managerPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.topbar = new WebContentsView({
      webPreferences: {
        preload: opts.managerPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.content = new WebContentsView({
      webPreferences: {
        preload: opts.dshPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.win.contentView.addChildView(this.topbar)
    this.win.contentView.addChildView(this.content)
    this.content.setVisible(false)

    // A snapshot pushed while the connection page was still loading is lost, and
    // that is exactly when a fast failure happens. Push one once the page is up.
    this.content.webContents.on('did-finish-load', () => this.contentReady?.())

    void this.topbar.webContents.loadFile(opts.managerHtml).catch(() => undefined)
    this.layout()
    this.win.on('resize', () => this.layout())

    this.win.on('closed', () => {
      this.content.webContents.close()
    })
  }

  /** Show one instance's UI (or hide the content pane when no instance is active). */
  showInstance(protocolUrl: string | null): void {
    if (protocolUrl === null) {
      this.content.setVisible(false)
      return
    }
    this.content.setVisible(true)
    void this.content.webContents.loadURL(protocolUrl).catch(() => undefined)
  }

  get contentId(): number | undefined {
    return this.content.webContents.id
  }

  get contentWebContents(): WebContentsView['webContents'] {
    return this.content.webContents
  }

  get topbarWebContents(): WebContentsView['webContents'] {
    return this.topbar.webContents
  }

  get isTopbarVisible(): boolean {
    return this.topbarVisible
  }

  /** Show the session bar (true) or give the content pane the full window (false). */
  setTopbarVisible(visible: boolean): void {
    this.topbarVisible = visible
    this.layout()
  }

  /**
   * Open the add-instance form as a modal child window. The top bar is only
   * 40px tall, so the form cannot live there; hosting it in its own modal
   * window keeps it above the content view and out of the bar.
   */
  openAddModal(kind: AddKind): void {
    // Unknown kinds fall back to local rather than dropping the click silently.
    const kindKey: AddKind = kind === 'ssh' || kind === 'raw' ? kind : 'local'
    this.addModal?.close()

    const size = ADD_MODAL_SIZE[kindKey]
    const modal = new BrowserWindow({
      width: size.width,
      height: size.height,
      parent: this.win,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: '#1a1d23',
      webPreferences: {
        preload: this.managerPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.addModal = modal
    modal.once('ready-to-show', () => modal.show())
    modal.webContents.on('did-fail-load', () => modal.close())
    modal.on('closed', () => {
      if (this.addModal === modal) this.addModal = null
    })
    void modal.loadFile(this.managerHtml, { query: { add: kindKey } }).catch(() => undefined)
  }

  /**
   * Open the instance manager window, or focus the one already open.
   *
   * Not `modal: true`, for the same reason as the log window: launching an
   * instance takes tens of seconds while provisioning, and a modal would block
   * the window the user is watching it from. One window rather than one per
   * launch, because it exists to browse the saved instances and it carries its
   * own selection.
   */
  openInstanceManager(): void {
    if (this.instancesWindow !== null && !this.instancesWindow.isDestroyed()) {
      this.instancesWindow.focus()
      return
    }

    const win = new BrowserWindow({
      width: 760,
      height: 560,
      parent: this.win,
      show: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: 'Instances',
      backgroundColor: '#1a1d23',
      webPreferences: {
        preload: this.managerPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.instancesWindow = win
    // The list can change while this window is still loading, and those pushes
    // are lost; a manager that loads after a launch would show stale rows.
    win.webContents.on('did-finish-load', () => this.instancesReady?.())
    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })
    win.on('closed', () => {
      if (this.instancesWindow === win) this.instancesWindow = null
    })
    void win.loadFile(this.instancesHtml).catch(() => undefined)
  }

  /** Callback that yields the current instance list when the manager window loads. */
  onInstanceManagerReady(handler: () => void): void {
    this.instancesReady = handler
  }

  /** The instance manager window's webContents id, or undefined while it is closed. */
  get instancesId(): number | undefined {
    return this.instancesWindow === null || this.instancesWindow.isDestroyed()
      ? undefined
      : this.instancesWindow.webContents.id
  }

  /** Close the instance manager window, when it is open. */
  closeInstanceManager(): void {
    if (this.instancesWindow === null || this.instancesWindow.isDestroyed()) return
    this.instancesWindow.close()
  }

  /**
   * Every live shell page: the bar, the manager, the add form, and the log.
   *
   * Each of them carries the manager preload, and each paints from the active
   * dsh theme, so they all take the same pushes.
   */
  private shellPages(): Electron.WebContents[] {
    const windows = [this.instancesWindow, this.addModal, this.logWindow]
    const pages = [this.topbar.webContents]
    for (const win of windows) {
      if (win !== null && !win.isDestroyed()) pages.push(win.webContents)
    }
    return pages.filter((page) => !page.isDestroyed())
  }

  /** Whether a renderer is one of this window's own shell pages. */
  isShellPage(webContentsId: number | undefined): boolean {
    if (webContentsId === undefined) return false
    return this.shellPages().some((page) => page.id === webContentsId)
  }

  /** Push the instance list to every shell page displaying it. */
  sendManagerUpdate(views: InstanceView[]): void {
    for (const page of this.shellPages()) page.send(IPC.managerUpdate, views)
  }

  /** Tell every shell page which instance is active. */
  sendActiveChanged(id: string | undefined): void {
    for (const page of this.shellPages()) page.send(IPC.managerActiveChanged, id)
  }

  /** Push the active theme to every shell page painting from it. */
  sendTheme(theme: AppTheme): void {
    for (const page of this.shellPages()) page.send(IPC.managerTheme, theme)
  }

  /**
   * Open the connection-log window for one instance, or focus the one already
   * showing it.
   *
   * Not `modal: true`, unlike the add form: a connect can take tens of seconds
   * while provisioning, and a modal would block the window the user is watching.
   * It is a child window so it stays above the shell, and resizable because an
   * error message and a stack of ssh output need the room.
   *
   * One window with a mutable target, rather than one per instance: the log is
   * read while connecting, and a user comparing two failures does not need two
   * windows to do it.
   */
  openLogWindow(instanceId: string): void {
    if (this.logWindow !== null && !this.logWindow.isDestroyed()) {
      this.logWindowTarget = instanceId
      this.logWindow.focus()
      // The renderer cannot see a query change on an already-loaded page, so tell
      // it to re-target instead of reloading and losing its scroll position.
      this.logWindow.webContents.send(IPC.managerLogUpdate, { retarget: instanceId } satisfies ConnectionLogMessage)
      return
    }

    const win = new BrowserWindow({
      width: 720,
      height: 460,
      parent: this.win,
      show: false,
      resizable: true,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: 'Connection Log',
      backgroundColor: '#1a1d23',
      webPreferences: {
        preload: this.managerPreload,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    this.logWindow = win
    this.logWindowTarget = instanceId
    // A connect can finish before this window has finished loading, so the
    // snapshots sent while it was loading are lost and the window would sit on
    // "STARTING" forever. Push one more when the page is actually ready: that is
    // what makes a failure that already happened visible.
    win.webContents.on('did-finish-load', () => {
      const target = this.logWindowTarget
      if (target !== undefined) this.logWindowReady?.(target)
    })
    win.once('ready-to-show', () => {
      win.show()
      // Bring it forward: this window exists to be watched, and it is opened by
      // an action that can take a long time. Opening it behind the main window
      // would defeat the point.
      win.focus()
      app.focus({ steal: true })
    })
    win.on('closed', () => {
      if (this.logWindow === win) {
        this.logWindow = null
        this.logWindowTarget = undefined
      }
    })
    void win.loadFile(this.managerHtml, { query: { log: instanceId } }).catch(() => undefined)
  }

  /** The instance the log window is showing, or undefined when it is closed. */
  get logInstanceId(): string | undefined {
    return this.logWindowTarget
  }

  /** Callback that yields the current log, so a late-loading window can catch up. */
  onLogWindowReady(handler: (instanceId: string) => void): void {
    this.logWindowReady = handler
  }

  /** Callback that yields the active instance's snapshot when the content view loads. */
  onContentReady(handler: () => void): void {
    this.contentReady = handler
  }

  /** Whether the log window is open (and therefore wants log updates). */
  hasLogWindow(): boolean {
    return this.logWindow !== null && !this.logWindow.isDestroyed()
  }

  /** Forward a log snapshot to the log window, if it is open. */
  sendLog(snapshot: ConnectionLogSnapshot): void {
    if (this.logWindow === null || this.logWindow.isDestroyed()) return
    this.logWindow.webContents.send(IPC.managerLogUpdate, snapshot satisfies ConnectionLogMessage)
  }

  /** Forward a snapshot to the in-tab connection view, when it is the page shown. */
  sendConnection(snapshot: ConnectionLogSnapshot): void {
    if (this.content.webContents.isDestroyed()) return
    if (!this.content.webContents.getURL().startsWith(`dsh-app://${APP_VIEW_HOST}/`)) return
    this.content.webContents.send(IPC.connectionUpdate, snapshot)
  }

  private layout(): void {
    const size = this.win.getContentSize()
    // The bar stays mounted while hidden and paints nothing there: its strip is
    // the only drag handle above the content pane, and insetting the content by
    // the same strip keeps the traffic lights off the harness's own header.
    const frames = shellFrames(size[0] ?? 0, size[1] ?? 0, this.topbarVisible)
    this.topbar.setBounds(frames.topbar)
    this.content.setBounds(frames.content)
  }
}
