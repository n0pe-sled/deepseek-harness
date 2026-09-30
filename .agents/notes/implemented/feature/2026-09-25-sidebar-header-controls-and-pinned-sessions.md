# Agent Note: Sidebar Header Controls and Pinned Sessions

Status: implemented

## Problem

The expanded sidebar spent its first two rows on chrome. The brand row carried a `DSH Local Build` label plus the build's commit-hash badge, the New Session action was a second full-width labelled button, and the opt-in clear-session-history plugin added a third beside it. Neither label carried information a user acts on, and the hash badge changed on every build.

Sessions a user returns to repeatedly had no shortcut: reaching one meant expanding its Workspace, or switching to the flat list and scrolling by recency. The list is ordered by Workspace account or by activity, so no existing order expresses "this one matters to me right now".

The session-search affordance lived inside the browsing region's section header, where its trigger shared the row with the section label, the view options, and the add-workspace button, and an open query hid the label and the trailing controls while the field stretched across the header. The query and the open flag were local to the browser component, so a remount dropped an in-progress query, and the rail carried a second search control that had to focus the box after the column slide.

The clear-session-history plugin also had no extension point for a control in the sidebar chrome. It found the shell's New Session button by DOM query, cloned it, and kept the clone in step with a `MutationObserver` plus a polling interval, so any change to the shell's markup or button classes could break the plugin silently at runtime.

## Decision

### Pinned Sessions

The workspace view store carries `pinnedSessionIds: string[]` in pin order, with `pinSession` and `unpinSession` as the only verbs that write it. Pinning is a shortcut, not a move: a pinned Session keeps its Workspace membership and its position in the Host's manual order, so it renders both in the Pinned section and inside its group.

The Session row menu carries one pin verb whose label follows the row's own state (Pin session / Unpin session). Both the pinned row and its grouped row expose it; either toggles the same stored id.

`derivePinned(list, archivedSessionIds, pinnedIds)` projects the stored ids through the list's existing visibility rule and returns rows in pin order. That rule excludes archived, subagent-origin, and non-selected blank Sessions, and keeps the selected blank Session. An id that resolves to no visible Session drops from the projection while staying stored, so the row returns when that Session becomes visible again, and unarchiving restores the pin instead of discarding it.

The section renders above the Workspace groups and above the flat list, and renders nothing at all while no pinned Session is visible. Its rows use the ordinary Session row (status dots, hover card, menu) but carry no drag wiring, because pin order is the pin action's own order. Grouping, folding, and ordering keep the semantics of [Session List Browsing and Manual Order](2026-07-25-session-list-browsing-and-manual-order.md) and [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md); pinning adds a second, pin-ordered projection of the same rows rather than a new order authority.

The pin list stays a flat array of ids rather than a per-Workspace map: a pinned Session outlives the group it was pinned from, including that group's deletion.

### Sidebar header

The expanded column is one vertical stack: the brand row, the icon control row, the `sidebar.header.search` region, the `sidebar.workspaces` browsing region, and a foot that holds only `sidebar.footer.action`.

The expanded brand row renders the mark and the product name, with the name centered in the space between the mark and the collapse control and no build badge. The `sidebar.brand.mark` and `sidebar.brand.name` slots keep their roles, and the name slot's fallback is `n0pe-sled AI`. The row holds the collapse toggle and no other control, so neither brand seat carries an action of its own.

Below it, one icon control row holds the icon-only New Session control first, a 36px capsule whose label is its accessible name and tooltip, then the `sidebar.settings` seat, then the `sidebar.header.action` list. Both slotted seats render only while expanded, so a contributor writes no rail layout of its own. `sidebar.header.action` is a root-scope list declaring one owner prop, `wide`, and it sits after the settings seat so a package adds a control without owning the row's geometry.

The settings gear moved into that row from the sidebar foot, beside the New Session control. `sidebar.settings` stays one single seat with the same `ui-settings-general` occupant, so the move changed the shell's render site only and left the slot contract and the settings package untouched. The rail keeps the seat in the foot, because two 36px control boxes do not fit in one 56px rail row. In the rail the control row is New Session alone, on the same entry path to the rail's left inset as the other upper controls, and the wide foot holds only `sidebar.footer.action`.

The app title follows the brand: `n0pe-sled AI` in `apps/web/index.html`, in the Vite build's `DEFAULT_CLIENT_TITLE`, and in the renderer's `DocumentTitle` fallback, which overwrites the served title at runtime whenever the build selects no `DSH_CLIENT_TITLE`.

### Workspace search seats

`sidebar.header.search` is a single root-scope region directly under the icon control row, and the shell renders it only while expanded. The workspace search control fills two of these seats: the trigger is one occupant of the `sidebar.header.action` list in the row, and the text box fills the region under it. Neither seat exists in the rail, so the browser keeps its own 36px search control there and requests expansion through the owner share.

The browser's section header keeps its label, its view options, and its `+` add-workspace button. Search behavior stays in ui-workspace: the same debounced `session.search` request, the same local title matches merged with the Host content matches, and the same results list, which replaces either browsing mode while the query is non-empty.

What moved is the viewing state. The open flag and the query left the browser component's local state for the declared workspace view store, because two slot components read and write them, the trigger in the control row and the box under it, and the query must outlive the browser's own mount. `apply` creates one store handle and mounts it under the browser, the trigger, and the box, so the trigger's expanded state and the box's value are one fact.

The pin field forced one key move and the two search fields forced another, so the persisted key is `dsh.workspace.view.v7`. Rehydration replaces the whole stored value, so a record written before either field existed cannot carry it, and the cost is one reset of the grouping, order, expansion, and pin preferences.

The box renders only while the store has search open, takes focus on open, and its clear control resets the query and closes the box.

### Clear-session-history plugin

The plugin registers a trash control into `sidebar.header.action` through `ctx.slots.inject()`, so the contribution waits on the declaration, leaves with the plugin fiber, and disappears with the seat. It styles that control through a style rule keyed to its own `data-dsh-clear-all-button` attribute and paints it with the theme's error-primary token. The Workspace and Session menus are not slots, so the observer that adds the per-scope clear rows remains the plugin's own concern. The plugin reads no shell markup and syncs no clone: its one sidebar contribution is the registered control.

## Alternatives considered

**Host-durable pins.** Pins could be a Host field on the Workspace or Session record, shared across browsers and devices. They lost because pinning has no model-visible effect and no durable-order meaning: the Host account already owns the manual Session order, and a second authority over "what the list shows first" would have to define which one wins when both change. Grouping, order, and expansion are already browser-local viewing preferences, and pins are the same kind of fact.

**Pinning only running Sessions.** Running Sessions are the case that motivated the request, and a running-only rule would keep the section small and self-clearing. It lost because the rows already carry live activity status, so a running-only pin would need a separate explanation for why an idle Session cannot be kept in reach, and it would drop the pin exactly when a long-running task finished. Pinning any visible Session subsumes the original need.

**Move semantics for a pinned row.** Pinning could remove the Session from its group, leaving it only in the section. It lost because the pinned Session would then vanish from the Workspace it belongs to, and the group's count would stop matching what the user sees in that Workspace.

**Pins rendered in the sidebar shell.** The shell could render the section itself above the browsing region. It lost because pinned rows are Session rows: they need the runtime's status classification, the row menu, the hover card, and the drag-exclusion rule, all of which live in ui-workspace. The shell would have to either re-implement them or accept a narrower row.

**A second `sidebar.settings` seat in the control row.** Two declarations would render the settings trigger twice, so every later settings change would have to keep both seats in step and the occupant would answer to two render sites. The shell picks one render site for the single seat instead.

**Keeping the search box in the browser's section header.** Only the trigger would move, so the two halves of one control would live in different render sites and the section header would keep collapsing its label and its trailing controls whenever a query was open. The shell's search region is where the box belongs once the trigger sits in the shell's own control row.

**Keeping the plugin's cloned New Session button and restyling it.** Patching the existing clone to read as a trash control would have left the plugin working. It lost because the clone's existence, classes, and position come from the shell's markup: the failure mode is a silently missing control, and the plugin's own interval and observer exist only to paper over that coupling.

**Passing the New Session element through an owner prop.** The seat could hand the plugin a ReactNode to render beside, mirroring how the composer still exposes `accessory`/`leftItems`. It lost because UI domains share only JSON-compatible data and callbacks; ReactNode content crosses boundaries through a slot, which is what `sidebar.header.action` is.

## Consequences

The sidebar contract grows two slots, `sidebar.header.action` and `sidebar.header.search`, and the view store grows three fields. The whole-value store forces a one-time reset of persisted view preferences. A pinned Session renders twice while its group is expanded, which is deliberate but is the feature's visible oddity.

The header loses the build revision readout: the product has no UI that identifies a running build, and the hash was an artifact of local builds that changed per commit.

The opt-in plugin composes through the same route as every in-tree client package, and its control disappears with the slot rather than persisting as a stale clone.

`sidebar.settings` is the only seat the shell renders at two sites, the control row when wide and the rail foot otherwise, so its occupant renders against `wide` alone.

Search keeps one open flag and one query across the trigger, the box, and the results list. The cost is dismissal: an outside click and Escape leave both in place, so the box's clear control is the only way to close it.

## Testing

Verification is keyless. The tree spec pins `derivePinned`'s projection and the store verbs. The browser spec pins menu pin/unpin, the section in both presentations, a pinned row outliving a folded group, the remount round-trip through `dsh.workspace.view.v7`, and an archived pin leaving the section while staying stored. The search-seat specs pin that the trigger and the box share one open flag and query, that the box takes focus when it opens, that both render nothing on the rail, and that all three entries mount one store handle. The sidebar specs pin one New Session starter, the centered fallback name, and the header-action seat unmounting on the rail and remounting on expand, while the sidebar DOM snapshots pin the expanded column and the rail. The plugin's client dialog-flow test renders the registered control and drives its confirm dialog.
