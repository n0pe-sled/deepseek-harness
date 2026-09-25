/**
 * AppWindow: one macOS BrowserWindow holding two WebContentsViews — a top bar
 * (session tabs + add buttons) and the dsh content view (custom protocol).
 */
import { app, BrowserWindow, WebContentsView } from 'electron'
import { IPC } from '../shared/ipc.ts'
import type { AddKind, ConnectionLogMessage, ConnectionLogSnapshot } from '../shared/ipc.ts'
import { APP_VIEW_HOST } from './protocol.ts'

export interface AppWindowOptions {
  managerPreload: string
  dshPreload: string
  managerHtml: string
}

/**
 * Height of the top bar. It has to clear the macOS traffic lights, which sit
 * inset over the window's top-left corner under `hiddenInset`.
 */
export const TOPBAR_HEIGHT = 40

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
  private topbarVisible = true
  private addModal: BrowserWindow | null = null
  private logWindow: BrowserWindow | null = null
  private logWindowTarget: string | undefined
  private logWindowReady: ((instanceId: string) => void) | undefined
  private contentReady: (() => void) | undefined

  constructor(opts: AppWindowOptions) {
    this.managerPreload = opts.managerPreload
    this.managerHtml = opts.managerHtml
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
    const width = size[0] ?? 0
    const height = size[1] ?? 0
    const bar = this.topbarVisible ? TOPBAR_HEIGHT : 0
    this.topbar.setBounds({ x: 0, y: 0, width, height: bar })
    this.content.setBounds({ x: 0, y: bar, width, height: Math.max(height - bar, 0) })
  }
}
