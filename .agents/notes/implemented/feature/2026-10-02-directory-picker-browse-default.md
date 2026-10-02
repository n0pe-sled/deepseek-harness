# Agent Note: Browse is the directory-picker interaction's default

Status: implemented

## Problem

The [adaptive default](2026-07-29-directory-picker-adaptive-default.md) resolved every boot to `native` unless a launch-context signal said otherwise, so an operator reaching a GUI over SSH got the in-app browser only when the host's own environment proved the operator was remote. No launch-side signal proves that. A remote dsh started outside its SSH invocation — by launchd, by a container entrypoint, or by hand in a detached session — carries no `SSH_CONNECTION`/`SSH_TTY`, and resolvable loopback still satisfies a loopback bind, so it resolves `native` and every "Add workspace…" opens a Finder/Zenity chooser on the host's own display: a screen the operator cannot see, with no path to type and no way to cancel it from the GUI they are looking at. The host's display probe cannot distinguish a browser at the host screen from a browser forwarded to it, so one boot-time answer is wrong for a deployment whose operators are all remote.

## Decision

The app ships `interaction: browse` as the default for the [`-auto` chooser](../architecture/2026-07-28-directory-picker-capability-seam.md): a config field on the chooser's row, resolved by schemastery, so the composed default needs no environment signal to be correct. The shipped `web-app` bundle states it explicitly on its `directory-picker` row, and a profile patch layer overrides that row to `interaction: native` for a deployment whose operator is the only client and sits at the host display.

The chooser keeps its detection machinery, inverted from a decision into a guard: `resolveDirectoryPickerBackend(interaction, facts)` returns `browse` for a `browse` request whatever the host could serve, and downgrades a `native` request to `browse` unless the sampled facts hold. A downgrade keeps the OS chooser reachable on the workstations where it is right and costs nothing where it is wrong, because a pinned `native` on a remote host would otherwise hand every pick to a display nobody is looking at — the failure the default used to cause.

Sampling still happens exactly once per boot, keeping the seam's capability-stability contract for the mounted backend. Detection keeps the constraints the earlier decision established: a loopback-only bind from the injected `webServer`, no remote operator through a loopback-supplying proxy (`DSH_WEB_LOOPBACK_ORIGINS` unset or blank), no SSH launch, and a servable display session on the host — assumed on darwin/win32, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a zenity or kdialog binary on `PATH` under linux, and never true on any other platform, since the native backend drives exactly darwin/win32/linux.

## Alternatives considered

- **Keep the adaptive default and declare the remote host's deployment shape** (mount `-browse` directly, or set `DSH_WEB_LOOPBACK_ORIGINS` through a loopback proxy). Rejected: it asks an operator who only wants a usable workspace to configure a transport fact, and the bare `ssh -L` shape satisfies neither — the GUI arrives from `127.0.0.1` with no declaration to make, so the chooser opens on the unattended workstation.
- **Broaden detection instead of changing the default** (treat a non-interactive parent, a container, or a missing Aqua session as remote). Rejected: those signals misclassify detached terminals and desktop launches, which the earlier decision already rejected for browser handoff, and each one still only narrows the set of hosts that get the wrong answer.
- **Per-connection resolution served by the wire advertisement** (the local browser gets the OS chooser, a remote browser the in-app dialog, one server). Rejected for the same reason the earlier decision deferred it: the client flow that `native` drives depends on the host's own capability kind, which the advertisement cannot carry without mounting both flows, and this GUI may not bind the interfaces a second browser would need.
- **A three-valued `interaction` with an explicit adaptive mode** (restoring the old behavior as `auto`). Rejected: `auto` and `native` resolve identically under every sampled fact — both answer `browse` wherever native cannot serve the pick — so the third value would claim a distinction the resolver does not make.

## Consequences

- The path field in the in-app dialog is the interaction an operator gets by default: one row now serves a headless deployment, a forwarded browser, and a browser at the host screen without any environment signal being right.
- A local operator on darwin or win32 loses the OS chooser and its native sidebar and favorites unless the deployment opts in. That is the cost of a default that cannot be resolved wrongly at boot.
- `native` is now the interaction to pin in a profile patch layer, and the resolver's downgrade is what keeps that pin safe; `-browse` stays the shipped default that the web e2e lane asserts by pinning the interaction on the `-auto` row, because its goldens drive the in-app dialog.
- Mounting the chooser **and** a backend row together still fails loud (duplicate `directoryPicker` service; duplicate flow in the `single` holes), so pinning by composing a backend row remains the alternative for a composition that replaces the chooser outright.
- Detection keeps its named coverage gaps: a detached tmux session loses the `SSH_*` markers, and a workstation-local launch reached through a bare `ssh -L` still reports `127.0.0.1`; both now only cost a `native` opt-in its OS chooser, which the resolver downgrades to `browse` rather than failing a pick.
