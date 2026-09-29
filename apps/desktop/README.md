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
- **Self-update (⌘U)**: Check for Updates… reads this repository's GitHub Releases, downloads the `.dmg` built for this architecture, and replaces the installed bundle in place before relaunching, so no `gh` and no token are needed.
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
  — `lib/bin.js` plus a flat `node_modules` — from the **harness checkout this
  app lives in**, not from the npm registry. The app sits at `apps/desktop`, so
  that is the repository root two levels up, and the revision it is on is what
  ships, including its local plugins and skills. Point it elsewhere with
  `--workspace` or `$DSH_HARNESS_WORKSPACE`, which also covers a standalone
  app checkout next to a sibling `../deepseek-harness`.
- The app boots that closure with its own Electron binary as the Node runtime
  (`ELECTRON_RUN_AS_NODE=1`), because Electron embeds Node ≥ 22 — the harness's
  engine floor. See `src/main/instances/bundled.ts`.

```bash
pnpm stage:harness              # stage from this checkout (its current build)
pnpm stage:harness -- --build   # build the harness first
pnpm dist:release               # stage + build + dmg in one step
```

Staging fails loudly rather than shipping a broken closure: it verifies the
deployed version matches the workspace version, that the CLI entry and web UI are
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

`.github/workflows/release-macos.yml` builds the `.dmg` on a macOS runner. The
app ships inside the harness repository, at `apps/desktop`, so the workflow checks
out that one repository: it installs and builds the harness at the root, then
installs, typechecks and unit-tests the app, stages the closure, **smoke-tests the
bundled harness**, and packages and uploads the `.dmg`. It also publishes a GitHub
Release on `v*` tags.

This repository is public, so a release and its `.dmg` download without an
account. Signed in with the `gh` CLI:

```bash
gh release download v0.1.4 --repo n0pe-sled/deepseek-harness --pattern '*.dmg'
```

The app is self-contained, so it needs no repository access to run once it is
installed.

The harness closure is staged from this repository's own tree at the revision
the run checked out, so a release carries a harness whose revision the build
summary reports. There is no harness repository variable and no harness ref to pin
any more: pin a release to a tag or a commit of this repository instead. Set
`MAC_CERTIFICATE`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`,
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

### Self-update

The app updates itself from this repository's GitHub Releases. **Check for Updates…** (⌘U) in the app menu runs a check on demand, and one check runs five seconds after launch. The launch check reports nothing while the running version is current, and a check that cannot reach GitHub stays quiet rather than raising a dialog about a network blip. When it finds a newer release it adds an update button to the session bar and nothing else, because it does not open the window itself; the button and the menu item are the two ways into the update window. `DSH_UPDATE_AUTOSTART=0` turns the launch check off for a run that must not reach GitHub, and `DSH_UPDATE_REPO` points the check at another repository. An unpackaged development build reports that it cannot update itself instead of offering an install it cannot perform.

The check compares the running app version against each release tag. A tag that is not three numeric parts is skipped rather than reported as older, so an unexpected tag cannot hide a real release, and a build ahead of every published release reports that it is up to date. A version the user skips is not offered again until something strictly newer appears. No release is published yet, so the report a fresh install sees is the empty-feed one.

The repository is public, so the check reads a release with no credential at all, and a machine with no `gh` and no token can still update. When a credential is present the check takes `GH_TOKEN`, else `GITHUB_TOKEN`, else the token `gh auth token` prints from whichever `gh` binary it can find, which is what a private fork mirroring this app needs. The app writes no token to disk, keeps the token out of its log and out of every message it shows, and reports a missing credential when a private feed answers 404.

Why not `electron-updater`? Its GitHub provider authenticates with a token compiled into the app, where anyone who unpacks the asar can read it, and this app ships no token of its own. It also installs macOS updates through Squirrel.Mac, which validates the replacement bundle against the running app's signing identity, and this build has no Developer ID signature to validate against. So the check and the install are this app's own code.

An install replaces the `.app` bundle the running executable sits inside, resolved from the executable's own path; the outermost bundle wins, so a helper nested inside the app resolves to the app the user installed. No admin prompt is involved, because an app its owner dragged into `/Applications` is writable by that user. The `.dmg` downloads into the app's `userData` directory, and the app compares the image's SHA-256 against the digest the release publishes for that asset. A release that publishes no digest for the asset leaves the image reported as read but not confirmed against one.

An install stops the running instances and quits the app. The swap runs in a shell script that `/bin/bash` reads from standard input in a detached process, so no script file lands on disk and the script outlives the app it replaces. The script then works through this sequence:

1. Wait up to 120 seconds for the app to exit, and install nothing when it does not.
2. Attach the `.dmg` read-only and without browsing.
3. Find the single `.app` at the image root.
4. Copy it with `ditto --rsrc --extattr` into `<bundle>.dsh-new` beside the installed bundle, so the swap stays a rename inside one directory and the installed bundle is untouched until the copy is complete.
5. Strip `com.apple.quarantine` from the copy, and treat a copy that carries none as the same result.
6. Confirm the copy holds an executable in `Contents/MacOS`.
7. Move the installed bundle to `<bundle>.dsh-backup`.
8. Move the staged copy into place.
9. Detach the image, and let a busy volume fail without failing the install.
10. Relaunch the app with `open`.
11. Delete the backup.

Every step before the swap leaves the installed bundle untouched, and the swap itself is two renames rather than one, so the bundle is briefly absent from `/Applications` between them. When the swap cannot finish, the script moves the backup back. When it cannot install from the image at all, it reveals the `.dmg` in Finder so the user can install it by hand.

The updater logs to `~/Library/Logs/DSH Desktop/update.log`, and the update window shows the tail of that file, which is the only place a failed install explains itself.

## Security model

- The dsh content view loads only `dsh-app://` (proxied, trusted UI) — never a remote origin directly.
- All HTTP/WebSocket traffic to instances originates in the main process, which carries no browser markers; loopback targets pass dsh's DNS-rebinding/cross-site fence.
- IPC handlers validate the sender (content view only) and the wire paths.
- The updater reads its GitHub token at check time from the environment or the `gh` CLI and stores it nowhere, only the update window may start a check, a download, or an install, and it opens a release URL in the browser only after checking that the URL is https.
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

