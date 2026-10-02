// @vitest-environment jsdom
/**
 * The Active Sessions section in isolation: which rows it lists, what it
 * renders while no session is active, and the row verbs it forwards. The
 * section reads the runtime list through the global `useSessions` hook and the
 * archive/pin sets through `useWorkspaces`, and writes pins through the store
 * actions it mounts, so every fact here arrives the way production supplies it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ActiveSessionsSectionProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { ActiveSessionsSection } from '../src/client/ActiveSessionsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: ActiveSessionsSectionProps['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})
const sessionState = (items: readonly SessionSummary[], current?: SessionId): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current,
  phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
  currentAddress: undefined,
})
const workspace = (id: string, sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
): WorkspaceListState => ({
  items, archivedSessionIds, state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function mount(overrides: Partial<ActiveSessionsSectionProps> = {}) {
  const store = createWorkspaceViewStore().create()
  const props: ActiveSessionsSectionProps = {
    wide: true,
    useSessions: hook(sessionState([])),
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    open: vi.fn(),
    forkSession: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    t,
    ...overrides,
  }
  const view = render(<ActiveSessionsSection {...props} />)
  return { view, props, store }
}

/** One live row through the two hooks the section reads, in its one Workspace. */
const liveState = (overrides: Partial<ActiveSessionsSectionProps> = {}) => ({
  useSessions: hook(sessionState([{ ...summary('running', 1), running: true }])),
  useWorkspaces: hook(workspaceState([workspace('project', ['running'])])),
  ...overrides,
})

describe('ActiveSessionsSection', () => {
  it('renders nothing at all while no Session is active', () => {
    // An archived run and a row outside every status both stay out: every
    // visible Session here is idle.
    mount({
      useSessions: hook(sessionState([
        summary('idle', 2),
        { ...summary('archived', 1), running: true },
      ])),
      useWorkspaces: hook(workspaceState([
        workspace('project', ['idle', 'archived']),
      ], [sid('archived')])),
    })
    expect(screen.queryByRole('region', { name: 'Active Sessions' })).toBeNull()
    expect(screen.queryAllByRole('treeitem')).toEqual([])
  })

  it('renders nothing on the rail, which has no room for a second list', () => {
    mount(liveState({ wide: false }))
    expect(screen.queryByRole('region', { name: 'Active Sessions' })).toBeNull()
  })

  it('lists a live Session once with the title its grouped row also shows', () => {
    mount(liveState({
      useSessions: hook(sessionState([
        { ...summary('running', 1), displayTitle: 'Long build', running: true },
      ])),
    }))
    const section = screen.getByRole('region', { name: 'Active Sessions' })
    expect(section.textContent).toContain('Long build')
    // The one row is the section's own; the grouped row of the same session
    // renders in the browsing region, which is not mounted here.
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
  })

  it('shows a Session blocked on the user, and the one selected blank Session', () => {
    const current = { ...summary('current-blank', 3), blank: true }
    mount({
      useSessions: hook(sessionState([
        { ...summary('blocked', 2), pendingInteraction: 'approval' },
        current,
      ], current.id)),
      useWorkspaces: hook(workspaceState([workspace('project', ['blocked', 'current-blank'])])),
    })
    const section = screen.getByRole('region', { name: 'Active Sessions' })
    expect(section.textContent).toContain('blocked')
    expect(section.textContent).toContain('Waiting for approval')
    // The blank row stays provisional: it renders no trailing menu, because
    // every verb there would act on content that does not exist yet.
    expect(screen.queryByRole('button', { name: 'Session actions for current-blank' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Session actions for blocked' })).toBeTruthy()
  })

  it('opens the Session a row click selects', () => {
    const open = vi.fn()
    mount(liveState({ open }))
    fireEvent.click(screen.getByRole('treeitem'))
    expect(open).toHaveBeenCalledWith(sid('running'))
  })

  it('pins a live row through the store the section mounts', () => {
    const b = mount(liveState())
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for running' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin session' }))
    expect(b.store.getSnapshot().pinnedSessionIds).toEqual(['running'])
  })

  it('renames through the injected per-session verb and closes on acceptance', async () => {
    const renameSession = vi.fn(async () => {})
    mount(liveState({ renameSession }))
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for running' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText<HTMLInputElement>('Session name')
    expect(input.value).toBe('running')
    // An unchanged title is a valid commit here: confirming the automatic
    // title is the gesture that pins it.
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameSession).toHaveBeenCalledWith(sid('running'), 'Renamed')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('archives a row with no dialog, leaving the list to the state echo', () => {
    const archiveSession = vi.fn(async () => {})
    mount(liveState({ archiveSession }))
    fireEvent.click(screen.getByRole('button', { name: 'Session actions for running' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
    expect(archiveSession).toHaveBeenCalledWith(sid('running'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
