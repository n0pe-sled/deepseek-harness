# DSH Desktop

A macOS Electron shell that loads instances of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) and lets you interact with local or remote instances.

## Features

- **Top bar + one active view**: session tabs sit in a bar across the window top; the active instance's full dsh web UI fills the pane below it.
- **Instance manager (⌘⇧L)**: one `+ Launch Instance` button in the top bar opens a window with the saved instances listed on the left. Select one and launch it, or start a new one as a local dsh, an SSH remote, or a remote URL. A first run seeds this machine's local dsh, so the list is never empty.
- **Switch-first SSH form**: the SSH form leads with the two questions that decide how the connection is made, as switches that are on by default. Ship this app's harness to the host, and run it in a sandbox container there.
- **Local instances**: the app spawns and supervises `dsh web --port 0 --no-open` itself — the harness it ships, or any executable path you configure — parses the readiness URL, and cleans up on quit.
- **SSH remotes (recommended)**: `ssh -N -L` tunnels make a remote dsh appear as `127.0.0.1`, so dsh's loopback-pinned privileged methods (settings, credentials, native dialogs) work.
- **Raw URL remotes (advanced)**: connect to any http(s) dsh origin; note dsh pins privileged methods to loopback, so those calls will be refused.
- **No harness changes**: the app consumes the harness's public `__DSH_TRANSPORT__` carrier seam; the UI it renders is byte-identical to what each instance serves.
- **Theme-matched shell**: the top bar, window background, and hover states repaint from the active dsh theme's resolved `--dsw-alias-*` tokens (including themes from the `herdr-themes` plugin), so the shell blends with the content pane.
- **Native menu**: File → Launch Instance… (⌘⇧L) opens the instance manager, and the per-kind entries (⌘L local, ⌘⇧S SSH, ⌘⇧U raw URL) open one add form directly. View → Show Session Bar (⌘B) drops the bar and hands the content pane the whole window.
- **Draggable top edge**: the bar is a drag handle, and a thin transparent strip is injected over the top of the content pane, so the window can be grabbed anywhere along its top edge. Hidden (⌘B), the bar keeps the 28pt traffic-light strip as that handle and paints nothing inside it, and the content pane starts below the strip, so the lights never land on a running instance's own header.

## Architecture

```
Electron main (Node)
 ├─ InstanceManager: spawn dsh web / ssh -N -L / raw endpoint
 ├─ ApiBridge: IPC relay for unary + generic RPC (main does the HTTP)
 ├─ StreamBridge: ws:// downlinks for events.mux / events.host → IPC frames
 └─ dsh-app://<instanceId>/ protocol → reverse-proxy to instance endpoint

Renderer
 ├─ top bar (one page, `?add=` / `?log=` / `?connection=` duties)
 └─ instance manager window: saved instances, launch, new instance

Content view (dsh page)
 └─ preload installs __DSH_TRANSPORT__ = { createApiClient, fetch }
     IpcApiClient: same four-quadrant wire invariants as AbstractApiClient
     (rpcId mint/echo), version-agnostic method generation
```

Why a custom scheme instead of `file://`? dsh's boot manifest references absolute `/assets/*` and `/plugins/*/client.js` URLs that only the host can serve. A custom protocol proxies those; the API/streams stay on IPC, so the trust fence is never spoofed.

Why a loopback host? The harness client gates every settings surface (Models, Plugins, General) on the page origin being loopback-classified (`connection.isLoopback`). A non-loopback origin puts the describe mirror in process-local mode and the UI reports "settings are unavailable in this browser". The content view therefore loads from a per-instance `127.a.b.c` host (`dsh-app://<loopbackHost>/`), which keeps the proxy architecture while satisfying the client's loopback check; distinct hosts per instance keep per-origin state isolated.

Why is the instance manager a window and not an overlay? The top bar is a 40px `WebContentsView`, so a dropdown would be clipped by the view it is drawn in. It is a child window the way the add form and the connection log are, and it is not `modal: true` for the same reason the log window is not: launching a provisioned remote takes tens of seconds, and the user watches it from the window behind.

## Development

```bash
pnpm install
pnpm dev        # electron-vite dev (hot reload)
pnpm build      # electron-vite build → out/
pnpm start      # run the built app
pnpm dist       # electron-builder dmg → release/ (uses the already-staged closure)
```

### The bundled harness

A packaged build carries its own harness, so a user can copy the `.dmg` into
`/Applications` and run a local instance with **no Node install and no `dsh` on
PATH**. Two pieces make that work:

- `scripts/stage-harness.mjs` materializes the closure into `resources/harness`
  — `lib/bin.js` plus a flat `node_modules` — from the **pinned local
  `deepseek-harness` checkout**, not from the npm registry. Whatever version and
  revision that checkout is on is what ships, including its local plugins and
  skills. Point it elsewhere with `--workspace` or `$DSH_HARNESS_WORKSPACE`
  (default: a sibling `../deepseek-harness`).
- The app boots that closure with its own Electron binary as the Node runtime
  (`ELECTRON_RUN_AS_NODE=1`), because Electron embeds Node ≥ 22 — the harness's
  engine floor. See `src/main/instances/bundled.ts`.

```bash
pnpm stage:harness              # stage from the pinned checkout (its current build)
pnpm stage:harness -- --build   # build the harness first
pnpm dist:release               # stage + build + dmg in one step
```

Staging fails loudly rather than shipping a broken closure: it verifies the
deployed version matches the pinned version, that the CLI entry and web UI are
present, that node-pty's macOS `spawn-helper` is executable, and that every
runtime dependency resolves the way Node's own loader would
(`scripts/lib/resolve-closure.ts`).

An instance with an explicit executable path still spawns that binary instead,
so a custom or system `dsh` keeps working. Only the default (no path set) uses
the bundled closure, and with no bundled closure present — a from-source dev run
before staging — adding a local instance reports that clearly instead of
silently falling back to PATH.

### Remote hosts: shipping the harness over SSH

Adding an **SSH remote** with *Ship this app's harness to the host* checked turns
the remote into a place this app runs its own harness, the way VS Code Remote-SSH
does. The app detects the host, ships the matching closure, starts it there, and
tunnels its loopback port back:

```bash
pnpm stage:harness:linux   # closure for linux-x64 glibc remotes
pnpm dist                  # packages resources/harness* into the .dmg
```

What the sequence does, in order:

1. **Detect** one ssh command reporting `uname`, `$HOME`, `ldd`, the loader,
   the distribution, `node --version`, free space, and whether the closure's
   parent directory is writable.
2. **Preflight**, refusing before anything is transferred: musl hosts (the native
   addons are glibc builds and no musl closure is staged), a missing or
   unsupported Node, a read-only or too-small target directory. The refusal names
   the cause.
3. **Select** the closure whose `version-revision-platform-arch-libc` matches the
   host. A directory under that key exists on the remote only because a completed
   extraction renamed it there, so its presence is the cache and a reconnect
   costs one ssh round trip.
4. **Ship** with `tar cz | ssh host '<extract>'`. Extraction goes to `<key>.tmp`
   and is renamed into place only after `lib/bin.js` and `harness-meta.json` both
   exist, so an interrupted transfer can never be mistaken for a valid cache. The
   stream excludes macOS `._*` sidecars, which would otherwise land in the temp
   directory and defeat that check.
5. **Launch** detached (`setsid`, all three streams redirected) with the remote's
   own Node, and read the port off the readiness line. The launcher records a PID
   file, so a second connect adopts the running server instead of starting
   another.
6. **Tunnel** that discovered port to a local loopback port for the GUI.

Reconnect reuses a live server. *Stop remote server* stops it; removing the
instance offers to delete the closure from the host, so nothing accumulates
unseen. The instance row shows the running harness **revision**, which is the
only thing that distinguishes our fork from upstream: both publish as
`@deepseek-ai/dsh` and upstream has published the fork's exact version string.

**Nothing in this path ever installs from npm.** There is no specifier that
identifies the fork — `latest`, a caret range, and an exact pin all resolve to
upstream code — so a registry fallback would silently run someone else's build
under a version number that looks right. `tests/unit/remote-provision.integration.test.ts`
asserts that no provisioning source names a registry at all.

Requirements and limits, stated plainly:

- **Key-based ssh is required.** Every ssh call runs with `BatchMode=yes`, so a
  missing key fails immediately rather than prompting into a GUI with no terminal.
- **`node` must be on the remote's PATH** (`^22.19.0 || >=24.0.0`). The app ships
  no remote Node runtime. The closure itself is ~300MB on disk, ~40MB compressed.
- **glibc only.** Alpine and other musl hosts are refused with that reason.
- **The Landlock sandbox is unavailable on shipped closures.** That launcher is a
  static-musl C binary built per Linux architecture; it lives in
  `native/landlock-run`, no cross-toolchain exists, and it is not in this
  checkout, so a closure staged here ships that package without its binary. The
  harness treats a missing launcher as `unusable` and boots anyway, so this costs
  the sandbox, not the session.
- The remote binds `127.0.0.1` only. The tunnel is the supported posture; the
  harness rejects `--host 0.0.0.0` by design.

To exercise the live path against a real host:

```bash
DSH_REMOTE_PROBE=1 DSH_PROBE_HOST=127.0.0.1 DSH_PROBE_PORT=2222 \
DSH_PROBE_USER=root DSH_PROBE_KEY=/path/to/key \
  pnpm vitest run tests/unit/remote-provision.integration.test.ts
```

### Releases

`.github/workflows/release-macos.yml` builds the `.dmg` on a macOS runner: it
checks out the harness, builds it, stages the closure, typechecks, unit-tests,
**smoke-tests the bundled harness**, then packages and uploads the `.dmg`. It
also publishes a GitHub Release on `v*` tags.

This repository is **private**, so its Releases and Actions artifacts need an
authenticated account with access — there is no anonymous download link. Signed
in with the `gh` CLI:

```bash
gh release download v0.1.0 --repo n0pe-sled/DeepSeek-App --pattern '*.dmg'
```

To hand the app to someone without a GitHub account, download the `.dmg` and
send the file itself; the app is self-contained and needs no repository access
to run.

The harness checkout defaults to the `DSH_HARNESS_REPOSITORY` / `DSH_HARNESS_REF`
repository variables and can be overridden per run. `DSH_HARNESS_REF` is pinned
to a full commit SHA, so a release keeps staging the same harness revision even
after the harness branch moves; bump the variable to pick up new harness work.
Set `MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to sign with a Developer ID
and notarize. `MAC_CERTIFICATE` is the base64 of a `.p12` carrying the Developer
ID Application certificate **and its private key**, exported from the login keychain
with both items selected. A certificate-only export imports fine and then cannot sign,
and electron-builder reports that as an unhelpful keychain error.

Without those secrets the build carries no signature at all, not even an ad-hoc one,
because electron-builder skips signing when it finds no identity. macOS reports such a
downloaded app as "DSH Desktop is damaged and can't be opened. You should move it to
the trash", which is the harsher wording of the refusal an unnotarized app gets. Copy
the app out of the mounted disk image first, because opening it from the read-only
volume fails the same way, then clear the download flag:

```bash
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

## Security model

- The dsh content view loads only `dsh-app://` (proxied, trusted UI) — never a remote origin directly.
- All HTTP/WebSocket traffic to instances originates in the main process, which carries no browser markers; loopback targets pass dsh's DNS-rebinding/cross-site fence.
- IPC handlers validate the sender (content view only) and the wire paths.
- `contextIsolation: false` is used for the preload because the carrier hooks must inject a rich class object into the page world; page content is trusted local code. Revisit with document-start injection if hardening is needed.

## Notes for maintainers

- The bundled closure is ~264 MB on disk, which puts the shipped `.dmg` at
  175 MB (166 MiB). Almost all of it is the harness and its 180-odd
  dependencies, not the Electron shell. Each additional staged closure for a
  remote target adds a similar amount to the `.dmg`: the linux-x64 closure is
  241 MB on disk and ~40 MB compressed, so shipping it costs roughly another
  40 MB of `.dmg`. That is the deliberate trade for provisioning working offline
  against infrastructure the user controls, rather than fetching a closure from a
  registry.
- electron-builder refuses any copy whose *relative* root is named
  `node_modules` (`app-builder-lib/out/util/filter.js`), which silently dropped
  the whole closure when `extraFiles.from` pointed straight at
  `resources/harness`. It points at `resources` with `harness/**/*` and
  `harness-*/**/*` filters so the relative paths are `harness/node_modules` and
  `harness-linux-x64/node_modules`. The second filter is what makes a provisioned
  remote work in a packaged build; without it the closure is absent from the
  `.dmg` and adding a provisioned instance reports that no closure is staged.
- `.gitignore` keeps `node_modules` **root-anchored** (`/node_modules`) for the
  same class of reason: a bare `node_modules/` pattern matches at every depth
  and made electron-builder pack a harness with no dependencies.
- Staging for a foreign target uses a throwaway git worktree rather than editing
  the caller's checkout, and seeds it with build outputs, because `lib/` and
  `dist/` are gitignored and `pnpm deploy` copies packages through their publish
  `files` field. `native/landlock-run` is the sharp edge here: it declares a
  nested workspace, is excluded from the build globs, and is not rebuilt by
  `--build`, so its `lib/` exists only in a checkout someone has built by hand.

