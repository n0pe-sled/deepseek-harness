# @deepseek-ai/dsh-client-ui-sidebar

Sidebar shell plugin: the brand row, the icon control row (New Session, the Settings seat, and the `sidebar.header.action` seat), the `sidebar.header.search` region under it, layout-owned collapse control, scroll-aware region seat, and the `sidebar.footer.action` seat. [ui-workspace](../ui-workspace/README.md) owns the Workspace and Session browser rendered into `sidebar.workspaces`; this package neither derives its rows nor owns its view preferences. Collapse into the layout-owned 56px rail remains presentation-local. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

The expanded brand row renders `sidebar.brand.mark` and `sidebar.brand.name` as independent single slots, while the collapsed rail renders the same mark slot. Without occupants, the shell uses the fish mark and the product name `n0pe-sled AI`, centered between the mark and the collapse control. A deployment package can replace either value without replacing the New Session control or rail geometry; declaration-aware `slots.inject()` lets such a package activate before or after the sidebar.

New Session is an icon-only 36px control carrying its label as an accessible name and tooltip. To its right the wide control row places the Settings seat and then any `sidebar.header.action` occupant, so a package that needs a control beside New Session registers into that slot, whose `wide` owner prop is the collapse state (the rail renders neither seat). That slot is how the opt-in clear-session-history plugin contributes its trash control without touching this package.

Directly under the control row, `sidebar.header.search` is the wide-only region for the browser's search box. It is a single slot with the same `wide` owner prop, so the rail renders no search region and the collapse keeps that affordance in the browser's own icon column.

New Session starts the runtime's page-local frontend Session Intent. The runtime targets the explicit Workspace used by a scoped action, otherwise the current Session's Workspace, otherwise the most recently active Workspace; when none exists it clears into the blank New Session page. Workspace-specific controls and the shared picker belong to ui-workspace.

`SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared brand, `sidebar.header.action`, `sidebar.header.search`, `sidebar.workspaces`, `sidebar.settings`, and `sidebar.footer.action` child slots, and injected `startSession` plus sidebar-toggle callbacks. There is no plugin store.

During a live collapse, the shell holds the expanded content at its current width while it fades out for 150ms. The four upper controls—the shell toggle, New Session, the search region, and the browser's rail icon column—then share one 150ms fade and 49px leftward translation into the 56px rail, ending with the layout's 300ms column slide; every 36px control box follows the same path to the rail's 10px left inset. The rail's `sidebar.settings` seat shares the fade timing but holds the foot position the wide column gives it, so it does not translate. A page that starts collapsed renders the rail statically, and reduced-motion mode disables both transitions.

Scrollbars in the column are a pointer affordance: the shell rebinds ui-theme's [scrollbar indirection](../ui-theme/README.md) to `transparent` whenever the pointer is outside it, and keeps the thumb drawn for 2s after the pointer leaves, so a list nobody is pointing at carries no bar. The reservation that keeps rows from moving belongs to the scrolling region ([ui-workspace](../ui-workspace/README.md)), so revealing a thumb never reflows.

The foot holds `sidebar.footer.action`; expanding moves the `sidebar.settings` seat out of it and into the control row, so the wide column ends at the footer actions while the rail keeps the settings seat bottom-pinned. The sidebar renders only those layout slots and shares its column state (`wide`); ui-settings registers the trigger row and settings panel through the one seat.

The `/client` exports are the plugin body (`apply`/`inject`) plus the contract types only; SidebarRoot, the row components, and the tree derivation remain package-internal behind the slot registration.

## Model Experience

None, as the sidebar renders the browser session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Session state-dot rendering is owned by [ui-workspace](../ui-workspace/README.md)** — no done/error notification sources are available.
- **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to [ui-workspace](../ui-workspace/README.md), not this shell.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
