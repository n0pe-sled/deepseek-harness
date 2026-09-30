// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type {
  SidebarFooterActionOwnerProps, SidebarHeaderActionOwnerProps, SidebarHeaderSearchOwnerProps,
  SidebarRootComponentProps, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

// English-dictionary translate stub: the shell renders the same copy the
// assertions below query by accessible name.
const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never

function mountShell({ collapsed = false, width = 300 }: { collapsed?: boolean; width?: number } = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let headerActionOwner: SidebarHeaderActionOwnerProps | undefined
  let headerSearchOwner: SidebarHeaderSearchOwnerProps | undefined
  const brandMark = <span data-testid="custom-brand-mark">M</span>
  const brandName = <span data-testid="custom-brand-name">Custom Brand</span>
  let current = { collapsed, width }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={startSession} toggleSidebar={toggleSidebar} t={t}
      renderSlot={((key: string, owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps
        | SidebarSettingsOwnerProps | SidebarHeaderActionOwnerProps
        | SidebarHeaderSearchOwnerProps) => {
        if (key === 'sidebar.brand.mark') return brandMark
        if (key === 'sidebar.brand.name') return brandName
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.header.action') {
          headerActionOwner = owner
          return <div data-testid="header-action-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.header.search') {
          headerSearchOwner = owner
          return <div data-testid="header-search-seat" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    headerActionOwner: () => {
      if (headerActionOwner === undefined) throw new Error('header action owner not rendered')
      return headerActionOwner
    },
    headerSearchOwner: () => {
      if (headerSearchOwner === undefined) throw new Error('header search owner not rendered')
      return headerSearchOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('routes New Session (the + icon control) and the column toggle', () => {
    const b = mountShell()
    expect(screen.getByTestId('custom-brand-mark')).toBeTruthy()
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    // The brand is a plain identity row (no hidden New Session shortcut); the
    // + icon control is the one session starter.
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(b.startSession).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders generic brand fallbacks when no package fills the slots', () => {
    const { container } = render(<SidebarRoot
      collapsed={false} width={300}
      useSessions={neverHook} useWorkspaces={neverHook}
      startSession={vi.fn()} toggleSidebar={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    expect(screen.getByText('n0pe-sled AI')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // The settings seat rides the same wide flag (ui-settings renders the row).
    expect(b.settingsOwner().wide).toBe(true)
    expect(b.footerActionOwner().wide).toBe(true)
    expect(b.headerActionOwner().wide).toBe(true)
    expect(b.headerSearchOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window, then settles into the rail.
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    expect(b.footerActionOwner().wide).toBe(false)
    expect(screen.getByTestId('region')).toBeTruthy()
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('unmounts the wide-only header seats on the rail and remounts them on expand', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    vi.advanceTimersByTime(200)
    b.rerender({})
    // The rail hides the search region and the whole header-action row; New
    // Session stays as the rail's icon control.
    expect(screen.queryByTestId('header-search-seat')).toBeNull()
    expect(screen.queryByTestId('header-action-seat')).toBeNull()
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
    b.rerender({ collapsed: false })
    expect(screen.getByTestId('header-search-seat')).toBeTruthy()
    expect(screen.getByTestId('header-action-seat')).toBeTruthy()
  })

  it('keeps exactly one settings seat through the collapse flip', () => {
    vi.useFakeTimers()
    const b = mountShell()
    // Wide the seat lands in the icon control row, collapsed it lands in the
    // foot: one trigger occupies the column in either state.
    expect(screen.getAllByTestId('settings-seat')).toHaveLength(1)
    b.rerender({ collapsed: true })
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(screen.getAllByTestId('settings-seat')).toHaveLength(1)
    expect(b.settingsOwner().wide).toBe(false)
  })
})
