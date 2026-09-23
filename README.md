# DSH Desktop

A macOS Electron shell that loads instances of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) and lets you interact with local or remote instances.

## Features

- **Top bar + one active view**: session tabs sit in a bar across the window top; the active instance's full dsh web UI fills the pane below it.
- **Local instances**: the app spawns and supervises `dsh web --port 0 --no-open` itself — the harness it ships, or any executable path you configure — parses the readiness URL, and cleans up on quit.
- **SSH remotes (recommended)**: `ssh -N -L` tunnels make a remote dsh appear as `127.0.0.1`, so dsh's loopback-pinned privileged methods (settings, credentials, native dialogs) work.
- **Raw URL remotes (advanced)**: connect to any http(s) dsh origin; note dsh pins privileged methods to loopback, so those calls will be refused.
- **No harness changes**: the app consumes the harness's public `__DSH_TRANSPORT__` carrier seam; the UI it renders is byte-identical to what each instance serves.
- **Theme-matched shell**: the top bar, window background, and hover states repaint from the active dsh theme's resolved `--dsw-alias-*` tokens (including themes from the `herdr-themes` plugin), so the shell blends with the content pane.
- **Native menu**: File adds instances (⌘L local, ⌘⇧S SSH, ⌘⇧U raw URL). View → Show Session Bar (⌘B) drops the bar and hands the content pane the whole window.
- **Draggable top edge**: the bar is a drag handle, and a thin transparent strip is injected over the top of the content pane, so the window can be grabbed anywhere along its top edge.

## Architecture

```
Electron main (Node)
 ├─ InstanceManager: spawn dsh web / ssh -N -L / raw endpoint
 ├─ ApiBridge: IPC relay for unary + generic RPC (main does the HTTP)
 ├─ StreamBridge: ws:// downlinks for events.mux / events.host → IPC frames
 └─ dsh-app://<instanceId>/ protocol → reverse-proxy to instance endpoint

Renderer (dsh content view)
 └─ preload installs __DSH_TRANSPORT__ = { createApiClient, fetch }
     IpcApiClient: same four-quadrant wire invariants as AbstractApiClient
     (rpcId mint/echo), version-agnostic method generation
```

Why a custom scheme instead of `file://`? dsh's boot manifest references absolute `/assets/*` and `/plugins/*/client.js` URLs that only the host can serve. A custom protocol proxies those; the API/streams stay on IPC, so the trust fence is never spoofed.

Why a loopback host? The harness client gates every settings surface (Models, Plugins, General) on the page origin being loopback-classified (`connection.isLoopback`). A non-loopback origin puts the describe mirror in process-local mode and the UI reports "settings are unavailable in this browser". The content view therefore loads from a per-instance `127.a.b.c` host (`dsh-app://<loopbackHost>/`), which keeps the proxy architecture while satisfying the client's loopback check; distinct hosts per instance keep per-origin state isolated.

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
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to sign and notarize; without
them the build is ad-hoc signed, and macOS quarantines the downloaded app on
first launch:

```bash
xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
```

## Security model

- The dsh content view loads only `dsh-app://` (proxied, trusted UI) — never a remote origin directly.
- All HTTP/WebSocket traffic to instances originates in the main process, which carries no browser markers; loopback targets pass dsh's DNS-rebinding/cross-site fence.
- IPC handlers validate the sender (content view only) and the wire paths.
- `contextIsolation: false` is used for the preload because the carrier hooks must inject a rich class object into the page world; page content is trusted local code. Revisit with document-start injection if hardening is needed.

## Notes for maintainers

- The bundled closure is ~260 MB on disk (~45 MB of the compressed `.dmg`).
- electron-builder refuses any copy whose *relative* root is named
  `node_modules` (`app-builder-lib/out/util/filter.js`), which silently dropped
  the whole closure when `extraFiles.from` pointed straight at
  `resources/harness`. It points at `resources` with a `harness/**/*` filter so
  the relative path is `harness/node_modules`.
- `.gitignore` keeps `node_modules` **root-anchored** (`/node_modules`) for the
  same class of reason: a bare `node_modules/` pattern matches at every depth
  and made electron-builder pack a harness with no dependencies.

