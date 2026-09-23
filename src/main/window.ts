/**
 * AppWindow: one macOS BrowserWindow holding two WebContentsViews — a top bar
 * (session tabs + add buttons) and the dsh content view (custom protocol).
 */
import { BrowserWindow, WebContentsView } from 'electron'
import type { AddKind } from '../shared/ipc.ts'

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

  private layout(): void {
    const size = this.win.getContentSize()
    const width = size[0] ?? 0
    const height = size[1] ?? 0
    const bar = this.topbarVisible ? TOPBAR_HEIGHT : 0
    this.topbar.setBounds({ x: 0, y: 0, width, height: bar })
    this.content.setBounds({ x: 0, y: bar, width, height: Math.max(height - bar, 0) })
  }
}
