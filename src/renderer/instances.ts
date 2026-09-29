/**
 * The instance manager window. The rail on the left lists every saved instance,
 * the pane on the right launches the one selected there or builds a new one.
 *
 * Main pushes a full view list on every change, including while a connect is in
 * flight, so this page keeps no state beyond the last push and the value each
 * manager call resolved with. A reload mid-connect therefore repaints the live
 * state like any other update.
 */
import { DEFAULT_SANDBOX_IMAGE } from '../shared/instance.ts'
import type { InstanceView, SandboxOptions } from '../shared/instance.ts'
import type { AddKind } from '../shared/ipc.ts'
import type { DshManagerApi } from '../shared/manager.ts'
import { ADD_KINDS, MODES, collectValues, renderFields } from './add-modes.ts'
import { applyTheme } from './theme.ts'

/**
 * The manager preload defines window.dshManager in this window. It is read as
 * optional so a page that somehow loaded without that preload can say what is
 * wrong, and the guard in boot() is the only place that has to test it.
 */
const maybeApi = (globalThis as { dshManager?: DshManagerApi }).dshManager
const api = maybeApi as DshManagerApi

/** This page's own elements. A missing one is broken markup, not a state. */
function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`instances page is missing #${id}`)
  return found as T
}

const managerEl = byId('manager')
const fatalEl = byId('fatal')
const newButton = byId<HTMLButtonElement>('new')
const railNote = byId('rail-note')
const listEl = byId('list')

const loadingNote = byId('loading')
const detailEl = byId('detail')
const detailName = byId('d-name')
const detailKind = byId('d-kind')
const detailStatus = byId('d-status')
const detailTarget = byId('d-target')
const detailErrorBox = byId('d-error')
const detailFailedBox = byId('d-failed')
const detailMeta = byId('d-meta')
const detailProgress = byId('d-progress')
const detailLaunch = byId<HTMLButtonElement>('d-launch')
const detailLog = byId<HTMLButtonElement>('d-log')
const detailRemove = byId<HTMLButtonElement>('d-remove')

const createEl = byId('create')
const createTabs = byId('c-tabs')
const createMode = byId('c-mode')
const createForm = byId<HTMLFormElement>('c-form')
const createFields = byId('c-fields')
const createErrorBox = byId('c-error')
const createProgress = byId('c-progress')
const createGo = byId<HTMLButtonElement>('c-go')

/** Saved instances, as of the last pushed or returned list. */
let views: InstanceView[] = []
/** Which instance main reports as active. */
let activeId: string | undefined
/** Which row the pane shows. Held across updates, so a removal cannot strand it. */
let selectedId: string | undefined
/** Whether the selection is the user's own pick rather than the default one. */
let pickedByUser = false
/** Whether the pane is building a new instance instead of showing a saved one. */
let creating = false
/** Whether the first list has arrived. Until then the pane shows a loading note. */
let loaded = false
/** Whether a connect started here is still running. Guards against a double fire. */
let launching = false
/** Message from a manager call that rejected, which arrives without a status. */
let actionError: string | undefined
/** Message from a failed add or connect in the new-instance pane. */
let createError: string | undefined
/** The kind the new-instance pane is building. */
let kind: AddKind = ADD_KINDS[0] ?? 'local'
/** Which kind's fields are currently rendered, so typed values survive pushes. */
let fieldsKind: AddKind | undefined

/**
 * Describe where an instance points, in one line.
 *
 * Main has the same text, but its formatter reads sandbox defaults and lives in
 * the main process, so this page keeps its own small version.
 * @param view - the instance to describe.
 * @returns the description.
 */
function describeInstance(view: InstanceView): string {
  const config = view.config

  if (config.kind === 'ssh') {
    const ssh = config.ssh
    const user = ssh?.user
    const destination = ssh === undefined
      ? 'the ssh remote'
      : `${user === undefined || user === '' ? '' : `${user}@`}${ssh.host}`
        + `${ssh.port === undefined ? '' : `:${String(ssh.port)}`}`
    if (ssh?.provision !== undefined) {
      return sandboxEnabled(ssh.sandbox)
        ? `Runs this app's harness in a container on ${destination}`
        : `Ships this app's harness to ${destination} and runs it there`
    }
    return `Forwards the remote dsh port ${String(ssh?.remotePort ?? 3000)} from ${destination}`
  }

  if (config.kind === 'local') {
    if (!sandboxEnabled(config.local?.sandbox)) {
      const dshPath = config.local?.dshPath
      return dshPath === undefined || dshPath === ''
        ? 'Runs this app\'s bundled dsh directly on this machine'
        : `Runs ${dshPath} directly on this machine`
    }
    const image = config.local?.sandbox?.image
    return `Runs ${image === undefined || image === '' ? DEFAULT_SANDBOX_IMAGE : image} in a container on this machine`
  }

  const url = config.rawUrl
  return url === undefined || url === '' ? 'Points at a remote URL' : `Points at ${url}`
}

/**
 * Whether an instance runs inside a container.
 *
 * Only an explicit false opts out: the model leaves the field absent for the
 * built-in default, and main resolves it the same way, so an instance saved
 * before the field existed is not described as a bare host process.
 * @param sandbox - the instance's sandbox options, if it has any.
 * @returns true when the harness runs in a container.
 */
function sandboxEnabled(sandbox: SandboxOptions | undefined): boolean {
  return sandbox?.enabled !== false
}

/** The kind as the rail lists it: a raw instance is a plain URL. */
function kindName(view: InstanceView): string {
  return view.config.kind === 'raw' ? 'url' : view.config.kind
}

/** The selected instance, when it is still in the list. */
function currentView(): InstanceView | undefined {
  if (selectedId === undefined) return undefined
  return views.find((view) => view.config.id === selectedId)
}

/** The active instance when it is saved, otherwise the first one. */
function defaultSelection(): string | undefined {
  if (activeId !== undefined && views.some((view) => view.config.id === activeId)) return activeId
  return views[0]?.config.id
}

/**
 * Keep the selection pointing at a saved instance.
 *
 * The active instance is the default because it is the one the user is already
 * looking at, and the top bar shows it. A pick the user made stands, including
 * across list pushes, until that row is removed.
 */
function reconcile(): void {
  if (!creating) {
    const kept = pickedByUser && selectedId !== undefined
      && views.some((view) => view.config.id === selectedId)
    if (!kept) {
      selectedId = defaultSelection()
      pickedByUser = false
    }
  }
  // With nothing saved, the new-instance form is the only useful thing to show.
  if (views.length === 0) creating = true
}

/** Take a list as the truth and repaint. */
function applyViews(next: InstanceView[]): void {
  views = next
  reconcile()
  // A list that says the selected instance is up makes an earlier failure stale,
  // so the error block cannot outlive the problem it reported.
  if (currentView()?.runtime.status === 'running') actionError = undefined
  render()
}

/** Fold one instance into the list and repaint, for the values calls return. */
function mergeView(view: InstanceView): void {
  const known = views.some((candidate) => candidate.config.id === view.config.id)
  applyViews(known
    ? views.map((candidate) => (candidate.config.id === view.config.id ? view : candidate))
    : [...views, view])
}

function render(): void {
  renderRail()
  const selected = creating ? undefined : currentView()
  if (!loaded) {
    loadingNote.hidden = false
    detailEl.hidden = true
    createEl.hidden = true
    return
  }
  loadingNote.hidden = true
  detailEl.hidden = selected === undefined
  createEl.hidden = selected !== undefined
  if (selected === undefined) renderCreate()
  else renderDetail(selected)
}

function renderRail(): void {
  listEl.textContent = ''
  for (const view of views) listEl.append(renderRow(view))
  railNote.hidden = loaded && views.length > 0
  railNote.textContent = loaded
    ? 'No saved instances yet. Add one on the right.'
    : 'Loading instances…'
  newButton.setAttribute('aria-pressed', String(creating))
  newButton.classList.toggle('on', creating)
}

function renderRow(view: InstanceView): HTMLElement {
  const selected = !creating && view.config.id === selectedId

  const row = document.createElement('button')
  row.type = 'button'
  row.className = selected ? 'inst-row selected' : 'inst-row'
  row.setAttribute('role', 'option')
  row.setAttribute('aria-selected', String(selected))
  // Hovering a row answers where it points without selecting it first.
  row.title = describeInstance(view)

  const dot = document.createElement('span')
  dot.className = `dot ${view.runtime.status}`
  // The status alone ("error") says nothing; the reason is what the user needs,
  // and the dot is the thing they are already looking at.
  dot.title = view.runtime.error ?? view.runtime.status

  const name = document.createElement('span')
  name.className = 'inst-name'
  name.textContent = view.config.name

  const kindLabel = document.createElement('span')
  kindLabel.className = 'inst-kind'
  kindLabel.textContent = kindName(view)

  row.append(dot, name, kindLabel)
  row.addEventListener('click', () => { select(view.config.id) })
  return row
}

/** Show one saved instance in the pane. */
function select(id: string): void {
  selectedId = id
  pickedByUser = true
  creating = false
  actionError = undefined
  createError = undefined
  render()
}

/** Switch the pane to building a new instance. */
function startCreating(): void {
  creating = true
  actionError = undefined
  createError = undefined
  render()
}

function renderDetail(view: InstanceView): void {
  const { config, runtime } = view
  detailName.textContent = config.name
  detailKind.textContent = kindName(view)
  detailTarget.textContent = describeInstance(view)

  detailStatus.textContent = runtime.status
  detailStatus.className = `pane-status ${runtime.status}`
  detailStatus.title = runtime.error ?? runtime.status

  // The runtime error is the reason a connect failed. A rejected call gets its own
  // block, because it arrives with no status change and would otherwise vanish.
  detailErrorBox.hidden = runtime.status !== 'error'
  detailErrorBox.textContent = runtime.status === 'error'
    ? (runtime.error ?? 'The connect failed. The connection log has the details.')
    : ''
  detailFailedBox.hidden = actionError === undefined
  detailFailedBox.textContent = actionError ?? ''

  const meta: string[] = []
  if (runtime.detail !== undefined && runtime.detail !== '') meta.push(runtime.detail)
  // The revision is what tells the fork apart from upstream: both publish under
  // the same version string, so a version alone cannot answer "am I on our code".
  if (runtime.revision !== undefined && runtime.revision !== '') {
    meta.push(`revision ${runtime.revision.slice(0, 10)}`)
  }
  if (runtime.origin?.target !== undefined) meta.push(runtime.origin.target)
  if (runtime.origin?.provisioned === true) meta.push('shipped by this app')
  if (runtime.endpoint !== undefined) meta.push(runtime.endpoint)
  detailMeta.hidden = meta.length === 0
  detailMeta.textContent = meta.join(' · ')

  const busy = launching || runtime.status === 'starting' || runtime.status === 'reconnecting'
  detailProgress.hidden = !busy
  detailProgress.textContent = busy
    ? `Connecting to ${config.name}. This can take tens of seconds, and the log shows what it is doing.`
    : ''

  detailLaunch.textContent = launchLabel(view)
  detailLaunch.disabled = busy
  detailLog.title = `Connection log for ${config.name}`
  detailRemove.title = `Remove ${config.name}`
}

/** What the primary button does next, which is only about the runtime. */
function launchLabel(view: InstanceView): string {
  const status = view.runtime.status
  if (status === 'starting' || status === 'reconnecting') return 'Connecting…'
  if (status === 'error') return 'Retry'
  if (status === 'running' && view.config.id === activeId) return 'Open'
  return 'Launch'
}

function renderCreate(): void {
  createTabs.textContent = ''
  for (const candidate of ADD_KINDS) createTabs.append(renderKindTab(candidate))

  // Rebuilding the fields on every push would throw away what the user typed, and
  // pushes arrive during a connect, so they change only with the kind.
  if (fieldsKind !== kind) {
    renderFields(createFields, MODES[kind].fields)
    fieldsKind = kind
  }

  createMode.textContent = MODES[kind].title
  for (const input of createFields.querySelectorAll<HTMLInputElement>('input')) {
    input.disabled = launching
  }

  createErrorBox.hidden = createError === undefined
  createErrorBox.textContent = createError ?? ''
  createProgress.hidden = !launching
  createProgress.textContent = launching
    ? 'Adding the instance and connecting to it. The first connect can take a while.'
    : ''

  createGo.textContent = launching ? 'Launching…' : 'Add and launch'
  createGo.disabled = launching
}

function renderKindTab(candidate: AddKind): HTMLElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.className = candidate === kind ? 'kind-tab selected' : 'kind-tab'
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', String(candidate === kind))
  tab.textContent = MODES[candidate].tab
  tab.disabled = launching
  tab.addEventListener('click', () => {
    if (kind === candidate) return
    kind = candidate
    createError = undefined
    render()
  })
  return tab
}

/**
 * Launch the selected instance, or re-attach to it when it already runs.
 *
 * Main answers connect() only when the attempt is over, and it can take tens of
 * seconds, so the progress line holds the window open until then. The window
 * closes on a running result only: a failure has to stay readable, with Retry one
 * click away.
 */
async function launchInstance(view: InstanceView): Promise<void> {
  if (launching) return
  launching = true
  actionError = undefined
  render()
  try {
    const result = await api.connect(view.config.id)
    mergeView(result)
    if (result.runtime.status === 'running') api.closeInstances()
  } catch (error) {
    actionError = messageOf(error)
  } finally {
    launching = false
    render()
  }
}

/**
 * Create the instance the form describes, then connect to it.
 *
 * The new instance is folded into the list before the connect starts, so the rail
 * shows it while the connect is still running.
 */
async function addAndLaunch(): Promise<void> {
  if (launching) return
  launching = true
  createError = undefined
  render()
  try {
    const created = await MODES[kind].submit(api, collectValues(createFields))
    mergeView(created)
    const result = await api.connect(created.config.id)
    mergeView(result)
    if (result.runtime.status === 'running') {
      // Select the instance that just came up, which is the pane closing the
      // window leaves the user on anyway.
      select(created.config.id)
      api.closeInstances()
      return
    }
    createError = result.runtime.error ?? `The instance did not start (${result.runtime.status}).`
  } catch (error) {
    createError = messageOf(error)
  } finally {
    launching = false
    render()
  }
}

/** Remove one saved instance. The store is the truth, so the push repaints. */
function removeInstance(view: InstanceView): void {
  actionError = undefined
  void api.remove(view.config.id).catch((error: unknown) => {
    actionError = messageOf(error)
    render()
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boot(): void {
  document.body.classList.add('manager-window')
  if (maybeApi === undefined) {
    managerEl.hidden = true
    fatalEl.hidden = false
    return
  }

  // Match the active dsh theme, the same way the top bar does. The pull covers a
  // theme main resolved before this page finished subscribing.
  api.onTheme(applyTheme)
  void api.getTheme().then((theme) => {
    if (theme !== undefined) applyTheme(theme)
  }).catch(() => undefined)

  api.onUpdate(applyViews)
  api.onActiveChanged((id) => {
    activeId = id
    reconcile()
    render()
  })

  newButton.addEventListener('click', startCreating)
  detailLaunch.addEventListener('click', () => {
    const view = currentView()
    if (view !== undefined) void launchInstance(view)
  })
  detailLog.addEventListener('click', () => {
    const view = currentView()
    if (view !== undefined) api.openLog(view.config.id)
  })
  detailRemove.addEventListener('click', () => {
    const view = currentView()
    if (view !== undefined) removeInstance(view)
  })
  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void addAndLaunch()
  })

  void api.list().then((listed) => {
    loaded = true
    applyViews(listed)
  }).catch((error: unknown) => {
    loaded = true
    // With no list there is nothing to select, so the new-instance pane is what
    // stays on screen and the reason for the empty rail belongs there.
    if (views.length === 0) createError = messageOf(error)
    else actionError = messageOf(error)
    reconcile()
    render()
  })
  void api.active().then((id) => {
    activeId = id
    reconcile()
    render()
  }).catch(() => undefined)

  render()
}

boot()
