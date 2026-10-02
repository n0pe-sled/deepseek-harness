/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry (fold state machine, brand row), the control row (New
 * Session, the settings seat, `sidebar.header.action`) and the wide-only
 * `sidebar.header.search` region directly under it. Two wide-only regions fill
 * the stack below that search region: `sidebar.activeSessions` (ui-workspace's
 * live-session section) and, under it, `sidebar.workspaces` (ui-workspace's
 * browsing region), which reaches down to the foot. The foot carries
 * `sidebar.footer.action` and, in the rail, the settings seat.
 * `sidebar.settings` is the settings seat (ui-settings), which the shell renders
 * in the control row when wide.
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Brand mark rendered in the expanded brand row and collapsed rail.
     * Declared by this package's `sidebar` entry; deployments may replace
     * the shell's fish fallback without replacing the surrounding controls.
     */
    'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: SidebarBrandMarkOwnerProps }
    /**
     * Brand name rendered beside the expanded mark. Declared by this
     * package's `sidebar` entry; the shell supplies a generic text fallback.
     */
    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }
    /**
     * The active-session region between the search region and the workspace
     * browsing region, wide only. Declared by this package's 'sidebar' entry
     * and registered by ui-workspace (declaring is claiming) with the live
     * session rows; the shell renders no rail form of it, because a rail
     * column has no room for a second list.
     */
    'sidebar.activeSessions': { kind: 'single'; scope: 'root'; owner: SidebarActiveSessionsOwnerProps }
    /**
     * The workspace/session browsing region: section header, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * Optional actions rendered in the icon control row, after the New Session
     * control and the settings seat. Declared by this package's 'sidebar' entry;
     * each action receives only the column state and renders wide content only —
     * the rail hides the whole row.
     */
    'sidebar.header.action': { kind: 'list'; scope: 'root'; owner: SidebarHeaderActionOwnerProps }
    /**
     * The search region between the control row and the browsing region, wide
     * only. Declared by this package's 'sidebar' entry; the registrant owns the
     * search box it renders there.
     */
    'sidebar.header.search': { kind: 'single'; scope: 'root'; owner: SidebarHeaderSearchOwnerProps }
    /**
     * The settings seat. Declared by this package's 'sidebar' entry; ui-settings
     * registers its trigger row + modal panel there. The shell renders the seat
     * in the control row when wide and at the foot in the rail. The sidebar
     * passes only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions in the sidebar foot, above the rail's settings seat.
     * Declared by this package's 'sidebar' entry; each action receives only
     * the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/** Geometry supplied to the sidebar brand-mark occupant. */
export interface SidebarBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
}

/** Empty owner share for the sidebar brand-name occupant. */
export interface SidebarBrandNameOwnerProps {
  /** Marker field: the occupant owns its own content and width. */
  children?: never
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * boundary. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/**
 * Owner share of the active-session region. The occupant reads `wide` to
 * render the full section and nothing on the rail, which the shell guarantees
 * by unmounting the region; unlike the browser region there is no rail icon
 * and therefore no expansion request.
 */
export interface SidebarActiveSessionsOwnerProps {
  /** Shell fold-state output: wide renders the section, rail nothing. */
  wide: boolean
}

/**
 * Owner share of the sidebar settings seat: the column display state the
 * occupant's trigger row must render against (wide row vs rail icon).
 */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of an action rendered in the icon control row. */
export interface SidebarHeaderActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of the search region under the icon control row. */
export interface SidebarHeaderSearchOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of an action rendered above the rail's settings seat. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The shell keeps only its own controls: starting a Session from
 * the New Session button and toggling the column.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.mark'
    | 'sidebar.brand.name'
    | 'sidebar.header.action'
    | 'sidebar.header.search'
    | 'sidebar.activeSessions'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & SidebarRootInjected & PropsLocale<'sidebar'>
