import type { InstanceView } from '../shared/instance.ts'
import { isLogRetarget } from '../shared/ipc.ts'
import type { ConnectionLogMessage, ConnectionLogSnapshot, DshConnectionApi } from '../shared/ipc.ts'
import { isUpdatePending } from '../shared/update.ts'
import type { UpdateSnapshot } from '../shared/update.ts'
import type { DshManagerApi } from '../shared/manager.ts'
import type { DshUpdateApi } from '../shared/ipc.ts'
import { ADD_KINDS, MODES, collectValues, renderFields } from './add-modes.ts'
import type { AddMode } from './add-modes.ts'
import { applyTheme } from './theme.ts'

declare global {
  interface Window {
    dshManager: DshManagerApi
    /** The content view's API for the in-tab connection page; absent in the shell. */
    dshConnection: DshConnectionApi
  }
}

const tabsEl = document.getElementById('tabs') as HTMLElement
const hintEl = document.getElementById('hint') as HTMLElement
const modal = document.getElementById('modal') as HTMLDialogElement
const modalTitle = document.getElementById('modal-title') as HTMLElement
const modalFields = document.getElementById('modal-fields') as HTMLElement
const modalForm = document.getElementById('modal-form') as HTMLFormElement
const modalOk = document.getElementById('modal-ok') as HTMLButtonElement
const updateBadge = document.getElementById('btn-update') as HTMLButtonElement

let views: InstanceView[] = []
let activeId: string | undefined
let mode: AddMode | undefined
/** The last update state main pushed, for the bar's own badge. */
let updateState: UpdateSnapshot | undefined

// One page serves three duties, chosen by query parameter: the shell top bar
// (no parameter), the add-instance modal (`?add=<kind>`), the log window
// (`?log=<id>`), and the in-tab connection view (`?connection=<id>`). The last
// one runs in the CONTENT view, which carries the dsh preload rather than the
// manager preload, so `window.dshManager` is absent there. Everything below the
// connection branch must therefore tolerate that: an unguarded call at module
// scope throws before the connection branch runs, and the page renders as the
// empty shell — a blank tab with no explanation.
const connectionIdForBoot = new URLSearchParams(window.location.search).get('connection')
const isConnectionView = connectionIdForBoot !== null

// One page serves two windows: the 40px-tall top bar, and the add-instance
// modal window (main loads this file with `?add=<kind>` for the modal). In
// modal duty the bar chrome hides and the form owns the window.
const addKind = new URLSearchParams(window.location.search).get('add')
const isAddWindow = addKind !== null
if (isAddWindow) document.body.classList.add('add-window')

// The update window is a window of its own, loaded with `?update=1`. It carries
// the manager preload like the other shell pages, and it needs the section below
// plus one class so the bar chrome stays out of it.
const isUpdateView = new URLSearchParams(window.location.search).get('update') !== null
if (isUpdateView) document.body.classList.add('update-window')

const shellManager: DshManagerApi | undefined = window.dshManager

// The shell, add-modal and log windows all carry the manager preload, so from
// the connection branch onward `shellManager` is always defined; the call sites
// past it assert that with `!`. Only the connection view lacks it, and it returns
// above this point.

if (shellManager !== undefined) {
  // ---- Theme: paint the shell to match the active dsh theme (sent by main) ----
  shellManager.onTheme(applyTheme)
  // Pull the current theme on boot: if the content page reported one before this
  // sidebar finished subscribing, the pull recovers it.
  void shellManager.getTheme().then((theme) => { if (theme !== undefined) applyTheme(theme) }).catch(() => undefined)
}

// ---- Top bar chrome: main owns the layout, we own the stored choice ----
const TOPBAR_KEY = 'dsh:topbar-hidden'

if (!isConnectionView) {
  shellManager!.onTopbarChanged((visible: boolean) => {
    localStorage.setItem(TOPBAR_KEY, visible ? '0' : '1')
    // Main keeps the bar strip over the content pane while the bar is hidden,
    // as the window's drag handle. Nothing may be painted inside it, or the strip
    // covers the harness's own header.
    document.body.classList.toggle('bar-hidden', !visible)
  })
}

// Restore the last choice before the first paint, otherwise the bar shows and
// then snaps away a frame later.
if (!isConnectionView && localStorage.getItem(TOPBAR_KEY) === '1') {
  document.body.classList.add('bar-hidden')
  shellManager!.setTopbarVisible(false)
}

function render(): void {
  tabsEl.textContent = ''
  for (const view of views) tabsEl.appendChild(renderTab(view, views.length === 1))
  // One session is not a tab strip. Show it as a plain status chip instead.
  tabsEl.style.display = views.length === 0 ? 'none' : ''
  hintEl.style.display = views.length === 0 ? '' : 'none'
}

/**
 * The badge the launch check leaves behind: visible only while an update is
 * waiting on the user. A check that finds nothing paints nothing, which is what
 * makes the launch check silent.
 */
function renderUpdateBadge(): void {
  const snapshot = updateState
  if (snapshot === undefined || !isUpdatePending(snapshot)) {
    updateBadge.hidden = true
    return
  }
  updateBadge.hidden = false
  const version = snapshot.latestVersion ?? 'a newer release'
  updateBadge.textContent = snapshot.phase === 'ready' ? 'Relaunch to update' : `Update ${version}`
  updateBadge.title = `DSH Desktop ${version} is available. Open the update window.`
}

function renderTab(view: InstanceView, bare: boolean): HTMLElement {
  const isActive = view.config.id === activeId

  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = 'tab' + (isActive ? ' active' : '') + (bare ? ' bare' : '')
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', String(isActive))
  tab.title = [
    view.config.name,
    view.config.kind,
    view.runtime.detail ?? view.runtime.status,
    // The revision is what tells the fork apart from upstream: both publish
    // under the same version string, so a version alone cannot answer
    // "am I running our code".
    ...(view.runtime.revision === undefined ? [] : [`revision ${view.runtime.revision}`]),
    ...(view.runtime.origin?.target === undefined ? [] : [view.runtime.origin.target]),
    ...(view.runtime.origin?.provisioned === true ? ['shipped by this app'] : []),
    view.runtime.error ?? '',
  ].filter(Boolean).join(' · ')

  const dot = document.createElement('span')
  dot.className = `dot ${view.runtime.status}`
  // The status alone ("error") says nothing; the reason is what the user needs,
  // and the dot is the thing they are already looking at.
  dot.title = view.runtime.error ?? view.runtime.status

  const name = document.createElement('span')
  name.className = 'tab-name'
  name.textContent = view.config.name

  // Which fork revision is running, next to the name rather than only in the
  // tooltip: "am I on our code" has to be answerable at a glance, because the
  // fork and upstream publish under the same version string.
  const revision = view.runtime.revision
  if (revision !== undefined && revision !== '') {
    const badge = document.createElement('span')
    badge.className = 'tab-rev'
    badge.textContent = revision.slice(0, 10)
    badge.title = `harness revision ${revision}`
    name.append(' ', badge)
  }

  const close = document.createElement('span')
  close.className = 'tab-close'
  close.textContent = '✕'
  close.title = 'Remove instance'
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    void shellManager!.remove(view.config.id).catch((error: unknown) => showError(error))
  })

  // Reopen the connection log. Always present, not only on failure: watching a
  // slow connect is the other reason the window exists, and a control that
  // appears only after something breaks is one nobody finds in time.
  const logs = document.createElement('span')
  logs.className = 'tab-logs'
  logs.textContent = '≡'
  logs.title = 'Connection log'
  logs.addEventListener('click', (event) => {
    event.stopPropagation()
    shellManager!.openLog(view.config.id)
  })

  tab.append(dot, name, logs, close)
  tab.addEventListener('click', () => {
    // connect() starts a stopped instance and makes it the active one.
    if (isActive) return
    void shellManager!.connect(view.config.id).catch((error: unknown) => showError(error))
  })
  return tab
}

function openModal(nextMode: AddMode): void {
  mode = nextMode
  modalTitle.textContent = nextMode.title
  if (isAddWindow) document.title = nextMode.title
  // renderFields clears the container itself, so there is nothing to empty here.
  renderFields(modalFields, nextMode.fields)
  modal.showModal()
  modalFields.querySelector<HTMLInputElement>('input')?.focus()
}

// Any close path — Cancel, Escape, or the overlay click-through — collapses the
// mode; the modal window also closes itself because the form is all it hosts.
modal.addEventListener('close', () => {
  mode = undefined
  if (isAddWindow) window.close()
})

function closeModal(): void {
  modal.close()
}

function doSubmit(): void {
  const current = mode
  if (current === undefined) return
  // collectValues drops a switch that is off, so the submit path in add-modes.ts
  // reads a missing key as off rather than 'false'.
  const values = collectValues(modalFields)
  void current.submit(shellManager!, values)
    .then(() => closeModal())
    .catch((error: unknown) => showError(error))
}

modalOk.addEventListener('click', doSubmit)

modalForm.addEventListener('submit', (event) => {
  event.preventDefault()
  doSubmit()
})

document.getElementById('modal-cancel')?.addEventListener('click', closeModal)
// The bar never hosts the form itself: creating and launching instances belongs to
// the instance manager window, so the bar keeps one way in rather than one button
// per kind.
if (!isConnectionView) {
  document.getElementById('btn-launch')?.addEventListener('click', () => shellManager!.openInstances())
  // The badge is the launch check's only visible effect, and clicking it is the
  // way into the window that can actually install the release.
  updateBadge.addEventListener('click', () => shellManager!.update.openWindow())
  shellManager!.update.onState((snapshot: UpdateSnapshot) => {
    updateState = snapshot
    renderUpdateBadge()
  })
  void shellManager!.update.get().then((snapshot: UpdateSnapshot) => {
    updateState = snapshot
    renderUpdateBadge()
  }).catch(() => undefined)
}

if (isAddWindow && addKind !== null) {
  const startKind = ADD_KINDS.find((kind) => kind === addKind)
  if (startKind === undefined) {
    // A hand-written query is the only way to reach an unknown kind.
    window.close()
  } else {
    openModal(MODES[startKind])
  }
}

// ---- Connection log window -------------------------------------------------
// A third duty of this page. Main loads it with `?log=<instanceId>`; the window
// renders the live log for that instance, so connecting is something you watch
// rather than a dot that turns red with no explanation.

const logView = document.getElementById('logview') as HTMLElement
const logName = document.getElementById('log-name') as HTMLElement
const logTargetLine = document.getElementById('log-target') as HTMLElement
const logStatus = document.getElementById('log-status') as HTMLElement
const logError = document.getElementById('log-error') as HTMLElement
const logLines = document.getElementById('log-lines') as HTMLElement
const logCopy = document.getElementById('log-copy') as HTMLButtonElement
const logCopied = document.getElementById('log-copied') as HTMLElement

/** Which instance this window shows; main can re-target an already-open window. */
let logInstance = new URLSearchParams(window.location.search).get('log') ?? undefined
let lastLines: string[] = []

if (logInstance !== undefined) {
  document.body.classList.add('log-window')
  logView.hidden = false

  const paint = (snapshot: ConnectionLogSnapshot): void => {
    logName.textContent = snapshot.name
    logTargetLine.textContent = snapshot.target
    logStatus.textContent = snapshot.status
    logStatus.className = `log-status ${snapshot.status}`
    if (snapshot.error === undefined) {
      logError.hidden = true
      logError.textContent = ''
    } else {
      logError.hidden = false
      logError.textContent = snapshot.error
    }
    lastLines = snapshot.lines
    // An empty box reads as a bug, so say what is happening instead.
    logLines.textContent = snapshot.lines.length === 0
      ? (snapshot.status === 'starting' ? 'Connecting…' : 'No log output yet.')
      : snapshot.lines.join('\n')
    logLines.scrollTop = logLines.scrollHeight
  }

  const refresh = async (): Promise<void> => {
    if (logInstance === undefined) return
    const snapshot = await shellManager!.getLog(logInstance)
    if (snapshot !== undefined) paint(snapshot)
  }

  shellManager!.onLogUpdate((message: ConnectionLogMessage) => {
    // Main reuses one window across connects, so it can re-target the open one.
    if (isLogRetarget(message)) {
      logInstance = message.retarget
      void refresh()
      return
    }
    // One log at a time: ignore snapshots for any other instance.
    if (message.instanceId !== logInstance) return
    paint(message)
  })

  logCopy.addEventListener('click', () => {
    const text = lastLines.length === 0 ? (logLines.textContent ?? '') : lastLines.join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      logCopied.hidden = false
      setTimeout(() => { logCopied.hidden = true }, 1500)
    }).catch(() => undefined)
  })

  void refresh()
}

// ---- In-tab connection view ------------------------------------------------
// Loaded into the content view with ?connection=<id> while an instance starts
// and after it fails. It uses window.dshConnection (the content view's preload),
// not window.dshManager, because this page is not the shell.

const connectionId = new URLSearchParams(window.location.search).get('connection')

if (connectionId !== null) {
  document.body.classList.add('conn-window')
  const view = document.getElementById('connview') as HTMLElement
  view.hidden = false

  const connName = document.getElementById('conn-name') as HTMLElement
  const connTarget = document.getElementById('conn-target') as HTMLElement
  const connStatus = document.getElementById('conn-status') as HTMLElement
  const connError = document.getElementById('conn-error') as HTMLElement
  const connLines = document.getElementById('conn-lines') as HTMLElement
  const connRetry = document.getElementById('conn-retry') as HTMLButtonElement
  const connLogWin = document.getElementById('conn-logwin') as HTMLButtonElement
  const connCopy = document.getElementById('conn-copy') as HTMLButtonElement
  const connCopied = document.getElementById('conn-copied') as HTMLElement

  let connLastLines: string[] = []

  const paintConnection = (snapshot: ConnectionLogSnapshot): void => {
    connName.textContent = snapshot.status === 'error'
      ? `${snapshot.name} could not connect`
      : `Connecting to ${snapshot.name}`
    connTarget.textContent = snapshot.target
    connStatus.textContent = snapshot.status
    connStatus.className = `log-status ${snapshot.status}`
    connError.hidden = snapshot.error === undefined
    connError.textContent = snapshot.error ?? ''
    connLastLines = snapshot.lines
    connLines.textContent = snapshot.lines.length === 0
      ? 'Starting…'
      : snapshot.lines.join('\n')
    connLines.scrollTop = connLines.scrollHeight
    // Retrying is only sensible once the attempt is over.
    connRetry.disabled = snapshot.status === 'starting'
    connRetry.textContent = snapshot.status === 'starting' ? 'Connecting…' : 'Try again'
  }

  const refreshConnection = async (): Promise<void> => {
    const snapshot = await window.dshConnection.get(connectionId)
    if (snapshot !== undefined) paintConnection(snapshot)
  }

  window.dshConnection.onUpdate(paintConnection)
  connRetry.addEventListener('click', () => { void window.dshConnection.retry(connectionId).then(refreshConnection) })
  connLogWin.addEventListener('click', () => { window.dshManager?.openLog(connectionId) })
  connCopy.addEventListener('click', () => {
    void navigator.clipboard.writeText(connLastLines.join('\n')).then(() => {
      connCopied.hidden = false
      setTimeout(() => { connCopied.hidden = true }, 1500)
    }).catch(() => undefined)
  })

  void refreshConnection()
}

// ---- Update window ---------------------------------------------------------
// The last duty of this page, loaded by main with ?update=1. It reports what the
// check found, and the actions the user takes on it. Everything it shows comes
// from the released feed, and a release body is remote content, so the notes are
// set as text rather than as markup.

const updateManager: DshUpdateApi | undefined = isUpdateView ? shellManager?.update : undefined

if (updateManager !== undefined) {
  const updateView = document.getElementById('updateview') as HTMLElement
  const updateVersion = document.getElementById('u-version') as HTMLElement
  const updatePhase = document.getElementById('u-phase') as HTMLElement
  const updateSummary = document.getElementById('u-summary') as HTMLElement
  const updateReason = document.getElementById('u-reason') as HTMLElement
  const updateBar = document.getElementById('u-bar') as HTMLElement
  const updateBarFill = document.getElementById('u-bar-fill') as HTMLElement
  const updateNotes = document.getElementById('u-notes') as HTMLElement
  const updateLogWrap = document.getElementById('u-logwrap') as HTMLDetailsElement
  const updateLog = document.getElementById('u-log') as HTMLElement
  const updateCheck = document.getElementById('u-check') as HTMLButtonElement
  const updateDownload = document.getElementById('u-download') as HTMLButtonElement
  const updateInstall = document.getElementById('u-install') as HTMLButtonElement
  const updateSkip = document.getElementById('u-skip') as HTMLButtonElement
  const updateRelease = document.getElementById('u-release') as HTMLButtonElement

  updateView.hidden = false

  const formatBytes = (bytes: number): string => {
    const mb = bytes / (1024 * 1024)
    return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`
  }

  /** What the window says about the state, in one line. */
  const summaryFor = (snapshot: UpdateSnapshot): string => {
    const version = snapshot.latestVersion
    switch (snapshot.phase) {
      case 'idle':
        return snapshot.skipped === true
          ? `${snapshot.latestVersion ?? 'That version'} was skipped, and stays skipped until something newer appears.`
          : 'This is the newest release.'
      case 'checking':
        return 'Checking the release feed…'
      case 'available':
        return `${version ?? 'A newer release'} is available.`
      case 'downloading': {
        const received = snapshot.receivedBytes ?? 0
        const total = snapshot.totalBytes ?? 0
        return total > 0
          ? `Downloading ${formatBytes(received)} of ${formatBytes(total)}…`
          : `Downloading ${formatBytes(received)}…`
      }
      case 'ready':
        return 'The update is downloaded. Installing replaces this app and relaunches it.'
      case 'installing':
        return 'Installing. This app quits so the installer can replace it, and comes back on the new version.'
      case 'error':
        return `${version === undefined ? 'The update check' : `Version ${version}`} did not complete.`
      case 'unsupported':
        return 'This build cannot update itself.'
    }
  }

  /** The progress bar, shown only while a total is known. */
  const paintProgress = (snapshot: UpdateSnapshot): void => {
    const received = snapshot.receivedBytes ?? 0
    const total = snapshot.totalBytes ?? 0
    if (snapshot.phase !== 'downloading' || total <= 0) {
      updateBar.hidden = true
      return
    }
    updateBar.hidden = false
    updateBarFill.style.width = `${String(Math.min(100, Math.round((received / total) * 100)))}%`
  }

  const paintUpdate = (snapshot: UpdateSnapshot): void => {
    updateVersion.textContent = [
      `This build: ${snapshot.version} (${snapshot.arch})`,
      ...(snapshot.installTarget === undefined ? [] : [`installs to ${snapshot.installTarget}`]),
    ].join(' · ')
    updatePhase.textContent = snapshot.phase
    updatePhase.className = `log-status ${snapshot.phase}`
    updateSummary.textContent = summaryFor(snapshot)
    updateReason.hidden = snapshot.reason === undefined
    updateReason.textContent = snapshot.reason ?? ''
    paintProgress(snapshot)

    updateNotes.hidden = snapshot.notes === undefined
    updateNotes.textContent = snapshot.notes ?? ''

    const busy = snapshot.phase === 'checking' || snapshot.phase === 'downloading'
    updateCheck.disabled = busy || snapshot.phase === 'installing'
    updateCheck.textContent = snapshot.phase === 'checking' ? 'Checking…' : 'Check Again'
    updateDownload.hidden = snapshot.phase !== 'available'
    updateDownload.disabled = busy
    updateInstall.hidden = snapshot.phase !== 'ready'
    updateInstall.disabled = busy
    updateSkip.hidden = snapshot.phase !== 'available'
    updateSkip.disabled = snapshot.skipped === true
    // A release page is only useful when the feed named one.
    updateRelease.hidden = snapshot.releaseUrl === undefined
  }

  /** Show the installer's log, or hide the section when there is none yet. */
  const loadLog = async (): Promise<void> => {
    const tail = await updateManager.log()
    const trimmed = tail?.trimEnd() ?? ''
    updateLogWrap.hidden = trimmed === ''
    updateLog.textContent = trimmed
  }

  /** Every action answers with a fresh state, so the window never guesses. */
  const runAction = (
    action: () => Promise<UpdateSnapshot | undefined>,
    onError: (error: unknown) => void,
  ): void => {
    void action().then((snapshot) => {
      if (snapshot !== undefined) paintUpdate(snapshot)
    }).catch(onError)
  }

  const actionFailed = (error: unknown): void => {
    updateReason.hidden = false
    updateReason.textContent = error instanceof Error ? error.message : String(error)
    // The installer's log is the only place a failed install explains itself, so
    // the window pulls it in whenever an action fails.
    void loadLog()
  }

  updateCheck.addEventListener('click', () => {
    runAction(async () => updateManager.check(), actionFailed)
  })
  updateDownload.addEventListener('click', () => {
    runAction(async () => updateManager.download(), actionFailed)
  })
  updateInstall.addEventListener('click', () => {
    runAction(async () => updateManager.install(), actionFailed)
  })
  updateSkip.addEventListener('click', () => {
    runAction(async () => updateManager.skip(), actionFailed)
  })
  updateLogWrap.addEventListener('toggle', () => {
    if (updateLogWrap.open) void loadLog()
  })
  updateRelease.addEventListener('click', () => {
    // The URL comes back with the state, and only the https one that does is
    // handed to the browser, so a feed cannot aim this at another scheme.
    const url = updateState?.releaseUrl
    if (url !== undefined) updateManager.openRelease(url)
  })

  updateManager.onState((snapshot: UpdateSnapshot) => {
    updateState = snapshot
    paintUpdate(snapshot)
    // An install ends in this process quitting, so its outcome is only readable
    // in the run that came back. Pull the log once there is something to say.
    if (snapshot.phase === 'error') void loadLog()
  })
  void updateManager.get().then((snapshot: UpdateSnapshot) => {
    updateState = snapshot
    paintUpdate(snapshot)
    if (snapshot.phase === 'error') void loadLog()
  }).catch(actionFailed)
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  const banner = document.createElement('div')
  banner.className = 'error-banner'
  banner.textContent = message
  banner.style.display = 'block'
  const container = modal.open ? modalFields : document.body
  container.prepend(banner)
  setTimeout(() => banner.remove(), 6000)
}

if (!isConnectionView) {
void shellManager!.list().then((listed: InstanceView[]) => {
  views = listed
  render()
}).catch((error: unknown) => showError(error))
void shellManager!.active().then((id: string | undefined) => {
  activeId = id
  render()
}).catch(() => undefined)

shellManager!.onUpdate((next: InstanceView[]) => {
  views = next
  render()
})
shellManager!.onActiveChanged((id: string | undefined) => {
  activeId = id
  render()
})
}
