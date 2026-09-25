import type { InstanceView } from '../shared/instance.ts'
import { isLogRetarget } from '../shared/ipc.ts'
import type { AddKind, AppTheme, ConnectionLogMessage, ConnectionLogSnapshot, DshConnectionApi } from '../shared/ipc.ts'
import type { DshManagerApi } from '../shared/manager.ts'

declare global {
  interface Window {
    dshManager: DshManagerApi
    /** The content view's API for the in-tab connection page; absent in the shell. */
    dshConnection: DshConnectionApi
  }
}

interface FieldSpec {
  key: string
  label: string
  placeholder: string
  type?: 'text' | 'number' | 'checkbox'
  required?: boolean
  /** Help text under the field, for options whose effect is not obvious. */
  hint?: string
}

interface AddMode {
  title: string
  fields: FieldSpec[]
  submit(values: Record<string, string>): Promise<void>
}

const tabsEl = document.getElementById('tabs') as HTMLElement
const hintEl = document.getElementById('hint') as HTMLElement
const modal = document.getElementById('modal') as HTMLDialogElement
const modalTitle = document.getElementById('modal-title') as HTMLElement
const modalFields = document.getElementById('modal-fields') as HTMLElement
const modalForm = document.getElementById('modal-form') as HTMLFormElement
const modalOk = document.getElementById('modal-ok') as HTMLButtonElement

let views: InstanceView[] = []
let activeId: string | undefined
let mode: AddMode | undefined

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

function applyTheme(theme: AppTheme): void {
  const root = document.documentElement
  root.style.colorScheme = theme.colorScheme
  root.style.setProperty('--bg', theme.background)
  root.style.setProperty('--panel', theme.panel)
  root.style.setProperty('--border', theme.border)
  root.style.setProperty('--text', theme.text)
  root.style.setProperty('--muted', theme.subtext)
  root.style.setProperty('--accent', theme.accent)
  root.style.setProperty('--on-accent', contrastForeground(theme.accent))
}

/** Pick a readable foreground for a hex background (dark text on light, white on dark). */
function contrastForeground(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}/u.test(hex)) return '#ffffff'
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#1a1d23' : '#ffffff'
}

// ---- Top bar chrome: main owns the layout, we own the stored choice ----
const TOPBAR_KEY = 'dsh:topbar-hidden'

if (!isConnectionView) {
  shellManager!.onTopbarChanged((visible: boolean) => {
    localStorage.setItem(TOPBAR_KEY, visible ? '0' : '1')
  })
}

// Restore the last choice before the first paint, otherwise the bar shows and
// then snaps away a frame later.
if (!isConnectionView && localStorage.getItem(TOPBAR_KEY) === '1') shellManager!.setTopbarVisible(false)

function render(): void {
  tabsEl.textContent = ''
  for (const view of views) tabsEl.appendChild(renderTab(view, views.length === 1))
  // One session is not a tab strip. Show it as a plain status chip instead.
  tabsEl.style.display = views.length === 0 ? 'none' : ''
  hintEl.style.display = views.length === 0 ? '' : 'none'
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

const MODES: Record<string, AddMode> = {
  local: {
    title: 'Add local dsh instance',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'My local dsh', required: true },
      { key: 'dshPath', label: 'dsh executable (optional)', placeholder: 'dsh' },
      { key: 'dshHome', label: 'DSH_HOME (optional)', placeholder: '/Users/me/.dsh' },
    ],
    async submit(values) {
      const env = values.dshHome !== '' && values.dshHome !== undefined ? { DSH_HOME: values.dshHome } : undefined
      await shellManager.addLocal({
        name: values['name'] ?? 'local',
        ...(values.dshPath !== undefined && values.dshPath !== '' ? { dshPath: values.dshPath } : {}),
        ...(env !== undefined ? { env } : {}),
      })
    },
  },
  ssh: {
    title: 'Add SSH remote',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'Work server', required: true },
      { key: 'host', label: 'SSH host', placeholder: 'server.example.com', required: true },
      { key: 'user', label: 'SSH user (optional)', placeholder: 'me' },
      { key: 'port', label: 'SSH port (optional)', placeholder: '22', type: 'number' },
      { key: 'remotePort', label: 'Remote dsh port', placeholder: '3000', type: 'number' },
      { key: 'identityFile', label: 'Identity file (optional)', placeholder: '~/.ssh/id_ed25519' },
      {
        key: 'provision',
        label: 'Ship this app\'s harness to the host',
        placeholder: '',
        type: 'checkbox',
        hint: 'Runs our own staged harness there instead of using a dsh you installed. '
          + 'Needs key-based ssh, node on the host, and about 300MB of disk. '
          + 'With this on, the remote dsh port above is ignored.',
      },
    ],
    async submit(values) {
      const provision = values['provision'] === 'true'
      await shellManager.addSsh({
        name: values['name'] ?? 'ssh',
        ssh: {
          host: values['host'] ?? '',
          ...(values['user'] !== undefined && values['user'] !== '' ? { user: values['user'] } : {}),
          ...(numbers(values, 'port') !== undefined ? { port: numbers(values, 'port') } : {}),
          // remotePort only means anything for a plain forward; a provisioned
          // instance discovers its port, so storing the field would be a lie.
          ...(!provision && numbers(values, 'remotePort') !== undefined ? { remotePort: numbers(values, 'remotePort') } : {}),
          ...(values['identityFile'] !== undefined && values['identityFile'] !== '' ? { identityFile: values['identityFile'] } : {}),
          ...(provision ? { provision: {} } : {}),
        },
      })
    },
  },
  raw: {
    title: 'Add remote URL (advanced)',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'Home box', required: true },
      { key: 'url', label: 'URL (http/https)', placeholder: 'https://dsh.example.com', required: true },
    ],
    async submit(values) {
      await shellManager.addRaw({ name: values['name'] ?? 'raw', url: values['url'] ?? '' })
    },
  },
}

function numbers(values: Record<string, string>, key: string): number | undefined {
  const raw = values[key]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function openModal(nextMode: AddMode): void {
  mode = nextMode
  modalTitle.textContent = nextMode.title
  if (isAddWindow) document.title = nextMode.title
  modalFields.textContent = ''
  for (const field of nextMode.fields) {
    const label = document.createElement('label')
    label.className = 'field'
    const span = document.createElement('span')
    span.textContent = field.label
    const input = document.createElement('input')
    input.name = field.key
    input.placeholder = field.placeholder
    input.type = field.type ?? 'text'
    input.required = field.required ?? false
    if (field.type === 'checkbox') {
      label.classList.add('field-check')
      // The checkbox reuses the same values map as every other field, so a
      // checked box reads as the string 'true' rather than a separate shape.
      input.value = 'true'
      label.prepend(input)
      label.append(span)
    } else {
      label.append(span, input)
    }
    if (field.hint !== undefined) {
      const hint = document.createElement('small')
      hint.className = 'field-hint'
      hint.textContent = field.hint
      label.append(hint)
    }
    modalFields.append(label)
  }
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
  const values: Record<string, string> = {}
  for (const input of modalFields.querySelectorAll<HTMLInputElement>('input')) {
    // An unchecked checkbox contributes nothing, so `values[key]` is absent
    // rather than 'false', and the submit path tests for the string 'true'.
    if (input.type === 'checkbox' && !input.checked) continue
    values[input.name] = input.value.trim()
  }
  void current.submit(values)
    .then(() => closeModal())
    .catch((error: unknown) => showError(error))
}

modalOk.addEventListener('click', doSubmit)

modalForm.addEventListener('submit', (event) => {
  event.preventDefault()
  doSubmit()
})

document.getElementById('modal-cancel')?.addEventListener('click', closeModal)
// The bar never hosts the form itself: adding happens in the modal window.
if (!isConnectionView) {
  for (const [buttonId, kind] of [
    ['btn-local', 'local'],
    ['btn-ssh', 'ssh'],
    ['btn-raw', 'raw'],
  ] as Array<[string, AddKind]>) {
    document.getElementById(buttonId)?.addEventListener('click', () => shellManager!.openAdd(kind))
  }
}

if (isAddWindow && addKind !== null) {
  const startMode = MODES[addKind]
  if (startMode === undefined) {
    // A hand-written query is the only way to reach an unknown kind.
    window.close()
  } else {
    openModal(startMode)
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
