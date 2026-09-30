/**
 * The workspace browser's viewing store: the session-list grouping mode and the
 * session-search surface, persisted across reloads. Module level exports the
 * factory only (a module-level handle would pin the store identity across plugin
 * reloads); apply constructs one handle and mounts it under the browser plus both
 * search contributions, which derive their PropsStore share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: workspace sections or one flat recency list. */
export type SessionGroupBy = 'workspace' | 'flat'
/** Session order: user-arranged only, or user-arranged plus activity promotion. */
export type SessionOrderBy = 'manual' | 'updated'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed update timestamps per order account for one-time promotion events. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
  /** Session ids pinned to the Pinned section, in pin order. */
  pinnedSessionIds: string[]
  /** Whether the sidebar's session-search box is open. */
  searchExpanded: boolean
  /** Session-search text, shared by the shell's trigger and the box below it. */
  query: string
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (draft: WorkspaceViewState, mode: SessionOrderBy) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrderAccount: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: WorkspaceViewState, accountKey: string, order: string[]) => void
  pinSession: (draft: WorkspaceViewState, sessionId: string) => void
  unpinSession: (draft: WorkspaceViewState, sessionId: string) => void
  setSearchExpanded: (draft: WorkspaceViewState, expanded: boolean) => void
  setSearchQuery: (draft: WorkspaceViewState, query: string) => void
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: {},
      pinnedSessionIds: [],
      searchExpanded: false,
      query: '',
    }),
    // v6 → v7: adds searchExpanded and query. Rehydration replaces the whole
    // state, so the new fields need the new storage key; pre-upgrade view
    // preferences (grouping, order, expansion, pins) reset once.
    persist: 'dsh.workspace.view.v7',
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy) => { d.orderBy = mode },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      pinSession: (d, sessionId: string) => {
        if (!d.pinnedSessionIds.includes(sessionId)) d.pinnedSessionIds.push(sessionId)
      },
      unpinSession: (d, sessionId: string) => {
        d.pinnedSessionIds = d.pinnedSessionIds.filter(id => id !== sessionId)
      },
      setSearchExpanded: (d, expanded: boolean) => { d.searchExpanded = expanded },
      setSearchQuery: (d, query: string) => { d.query = query },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        d.sessionUpdatedAtByAccount = Object.fromEntries(
          Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)),
        )
      },
      syncSessionOrderAccount: (d, accountKey: string, order: string[], updatedAt: Record<string, number>) => {
        d.sessionOrderByAccount[accountKey] = order
        d.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (d, accountKey: string, order: string[]) => {
        d.sessionOrderByAccount[accountKey] = order
      },
    },
  })
}
