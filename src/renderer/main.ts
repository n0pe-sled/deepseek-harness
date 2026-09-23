import type { InstanceView } from '../shared/instance.ts'
import type { AddKind, AppTheme } from '../shared/ipc.ts'
import type { DshManagerApi } from '../shared/manager.ts'

declare global {
  interface Window {
    dshManager: DshManagerApi
  }
}

interface FieldSpec {
  key: string
  label: string
  placeholder: string
  type?: 'text' | 'number'
  required?: boolean
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

// One page serves two windows: the 40px-tall top bar, and the add-instance
// modal window (main loads this file with `?add=<kind>` for the modal). In
// modal duty the bar chrome hides and the form owns the window.
const addKind = new URLSearchParams(window.location.search).get('add')
const isAddWindow = addKind !== null
if (isAddWindow) document.body.classList.add('add-window')

const manager = window.dshManager

// ---- Theme: paint the shell to match the active dsh theme (sent by main) ----
manager.onTheme(applyTheme)
// Pull the current theme on boot: if the content page reported one before this
// sidebar finished subscribing, the pull recovers it.
void manager.getTheme().then((theme) => { if (theme !== undefined) applyTheme(theme) }).catch(() => undefined)

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

manager.onTopbarChanged((visible) => {
  localStorage.setItem(TOPBAR_KEY, visible ? '0' : '1')
})

// Restore the last choice before the first paint, otherwise the bar shows and
// then snaps away a frame later.
if (localStorage.getItem(TOPBAR_KEY) === '1') manager.setTopbarVisible(false)

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
    view.runtime.error ?? '',
  ].filter(Boolean).join(' · ')

  const dot = document.createElement('span')
  dot.className = `dot ${view.runtime.status}`
  dot.title = view.runtime.status

  const name = document.createElement('span')
  name.className = 'tab-name'
  name.textContent = view.config.name

  const close = document.createElement('span')
  close.className = 'tab-close'
  close.textContent = '✕'
  close.title = 'Remove instance'
  close.addEventListener('click', (event) => {
    event.stopPropagation()
    void manager.remove(view.config.id).catch((error: unknown) => showError(error))
  })

  tab.append(dot, name, close)
  tab.addEventListener('click', () => {
    // connect() starts a stopped instance and makes it the active one.
    if (isActive) return
    void manager.connect(view.config.id).catch((error: unknown) => showError(error))
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
      await manager.addLocal({
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
    ],
    async submit(values) {
      await manager.addSsh({
        name: values['name'] ?? 'ssh',
        ssh: {
          host: values['host'] ?? '',
          ...(values['user'] !== undefined && values['user'] !== '' ? { user: values['user'] } : {}),
          ...(numbers(values, 'port') !== undefined ? { port: numbers(values, 'port') } : {}),
          ...(numbers(values, 'remotePort') !== undefined ? { remotePort: numbers(values, 'remotePort') } : {}),
          ...(values['identityFile'] !== undefined && values['identityFile'] !== '' ? { identityFile: values['identityFile'] } : {}),
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
      await manager.addRaw({ name: values['name'] ?? 'raw', url: values['url'] ?? '' })
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
    label.append(span, input)
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
for (const [buttonId, kind] of [
  ['btn-local', 'local'],
  ['btn-ssh', 'ssh'],
  ['btn-raw', 'raw'],
] as Array<[string, AddKind]>) {
  document.getElementById(buttonId)?.addEventListener('click', () => manager.openAdd(kind))
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

void manager.list().then((listed) => {
  views = listed
  render()
}).catch((error: unknown) => showError(error))
void manager.active().then((id) => {
  activeId = id
  render()
}).catch(() => undefined)

manager.onUpdate((next) => {
  views = next
  render()
})
manager.onActiveChanged((id) => {
  activeId = id
  render()
})
