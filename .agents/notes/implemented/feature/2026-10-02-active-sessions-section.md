# Agent Note: Active Sessions Section

Status: implemented

## Problem

A running Session was only visible where its Workspace group happened to sit. Reaching a long run meant expanding its group and scrolling to its row, and a Session doing work in a collapsed or far-down group gave no sign of its activity from the sidebar's resting state. Collapsing a Workspace hid its running rows entirely, so the one fact worth acting on — a turn is executing right now — was the one the browser's stored orders could bury.

The [pinned](2026-09-25-sidebar-header-controls-and-pinned-sessions.md) section already carried running status, but a pin is a deliberate user list: it neither appears when a run starts nor clears when one ends, so it could not answer "what is running now".

## Decision

### A second list over the runtime's live facts

`deriveActive(list, archivedSessionIds)` projects every visible Session whose summary reports `running` or a `pendingInteraction`, ordered newest update first. Blocked-on-the-user sessions join running ones because an approval, a plan review, or a question is the state that most needs a user, and the row already carries the amber dot that names which.

The section is a live view rather than an order authority, so it sorts by recency instead of the Host's manual order, and its rows carry no drag wiring. A listed Session keeps its Workspace membership and its Host order position, so the same Session renders both in the section and inside its group — the [pinned](2026-09-25-sidebar-header-controls-and-pinned-sessions.md) duplicate-row rule, for the same reason: removing a row from its group would make the group's visible content stop matching the Workspace it belongs to.

Visibility is the browser's own rule: archived, subagent-origin, and non-selected blank Sessions stay out. A subagent run reaches its parent's row as `runningSubagentCount` instead of a row of its own, because the shared sidebar projection already routes subagent conversations through the selected parent's header catalog.

### Where the section renders

The section fills the shell's new `sidebar.activeSessions` region, between the search region and the browsing region, so it leads the Workspace list without sitting inside the region that owns grouping and stored order. It renders only while wide and only while at least one Session is active — the rail has no room for a second list, and an empty section would cost the browsing region a row of labels for nothing.

The region takes the height its rows need and scrolls past half the column (`max-height: 50%`), so the browsing region below always keeps a usable share of the column however many sessions run at once. Its rows offer the ordinary Session row's rename verb, and the Section shares this package's Session rename dialog with the browsing region without sharing the target state behind it, so opening a rename from one section leaves the other's state untouched.

The section mounts the same viewing store handle as the browsing region and the two search seats, so a pin from either section is one stored list.

`ActiveSessionsSection`, `deriveActive`, the rename dialog, and the shell region are covered by the section spec (rows, the hidden states, and every row verb), the tree spec, the browser field spec, and the sidebar specs. The `/client` exports add `ActiveSessionsSectionProps` and `ActiveSessionsInjected` to the contract types.

## Alternatives considered

**Running Sessions stay only in their groups.** The section could list them without any grouped row, so the section would be the one place a live Session appears. It lost because the same Session would then vanish from the Workspace it belongs to, that group's visible content would stop matching what the user sees in that Workspace, and folding the group would become the one gesture that changes whether a running Session is listed at all.

**Pinning the running Sessions in the existing Pinned section.** The pinned list is the only stored user list, so the section could have been a computed prefix of it. It lost because a pin outlives the run that motivated it: the section would keep a Session after its turn finished until the user unpinned it, and an unpin would then remove the row from the live view while the run continued.

**Rendering the section inside the browsing region.** The rows could lead the grouped tree inside `sidebar.workspaces`, needing no new slot. It lost because the region owns grouping and stored order while the section is a live projection over the runtime list, so the two facts would share one component's state and the shell would lose the one place that decides where the live list belongs in the column.

**Counting subagent runs as active rows.** A running subagent child could appear in the section directly. It lost because the shared projection hides subagent-origin rows on purpose — their conversations are reached through the parent's header catalog — and the parent's row already reports the descendant run, so a child row would duplicate one fact and offer a navigation route the projection deliberately withholds.

**Capping the row count.** The section could list the most recent N active Sessions and hide the rest behind one control, as the Workspace groups do. It lost because every row here is a run the user started: the newest N is a recency guess at which run matters, and a hidden run is precisely the one the section exists to surface. The column share keeps the browsing region usable instead.

**A rail seat for the section.** The collapsed rail could carry a control that opens the section, as the search region's rail entry does. It lost because the rail's rows already show each Session's status dot, and the shell's `rail-in` fade has one icon per upper control: a second list in a 56px column would need its own scroll and disclosure state for facts the rail rows already carry.

## Consequences

The sidebar contract grows one slot, `sidebar.activeSessions`, with its own owner share carrying `wide` alone — the section never requests expansion, because it has no rail form. The shell gains one wide-only region with a 50% height ceiling, so many concurrent runs compress the browsing region instead of pushing it off the column.

The active-session section and the browsing region share one Session rename dialog but not its state: the dialog component is shared, so the two sections agree on the modal, and each owns a target. The pinned section still owns its dialog directly.

A Session rendering twice while it runs and again in its expanded group is deliberate and is the feature's visible oddity, matching the pinned section's.

The section reads two hooks and the store's pin verbs, so a deployment that composes no browsing region still needs `useWorkspaces` for the archive and pin sets.

## Testing

Verification is keyless. The tree spec pins `deriveActive`'s projection: recency rather than list order, the archived/subagent-origin/blank exclusions, and a descendant run reaching a blocked parent's row. The section spec pins that no session renders nothing at all, that the rail renders nothing, that one live Session lists once with the row's own title, that the section shows a user-blocked Session and the one selected blank Session, and that the row forwards open, the pin verb, rename, and the dialog-free archive. The apply spec pins the registration component, its locale seat, its shared store handle, and its three injected actions. The browser field spec pins the section's absence and the section's invisibility before its first pin. The sidebar specs pin the child declaration and the seat's wide flag, and the sidebar DOM snapshots re-record the new region.
