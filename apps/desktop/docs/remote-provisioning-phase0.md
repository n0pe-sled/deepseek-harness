# Remote dsh provisioning: phase 0 probe results

Probe host: a Debian 13 x86_64 container (Docker Desktop, `--platform linux/amd64`)
reached over real ssh with key auth. All evidence below is from command output on
2026-09-25.

## U1. Can a linux-x64 closure be produced from this macOS arm64 host? YES

Mechanism: `supportedArchitectures` in the harness `pnpm-workspace.yaml`.

It must be the union of host **and** target, not the target alone. Narrowing it to
`os: [linux], cpu: [x64]` makes install fail, because the workspace's own install
scripts run on this machine and need this machine's binaries:

```
lefthook postinstall: Error: Cannot find module 'lefthook-darwin-arm64/bin/lefthook'
esbuild postinstall: [esbuild] Failed to find package "@esbuild/darwin-arm64" on the file system
koffi install: Failed to load prebuilt binary, rebuilding from source
koffi install: Error: CMake does not seem to be available
ELIFECYCLE Command failed with exit code 1.
```

With the union (`darwin,linux` x `arm64,x64` x `current,glibc`) install succeeds in
8s from a warm store, and `pnpm deploy` carries every platform variant. Staging then
prunes the foreign ones. The prune is the safety-critical half, so it only deletes a
package name it can positively read as a different platform:

```
stage-harness: pruned 24 foreign native package(s), 133.9MB smaller
stage-harness: 165.0MB on disk; web UI present
```

Resulting closure carries exactly five native binaries, all linux-x64:

```
./node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.4.node
./node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node
./node_modules/@koromix/koffi-linux-x64/musl_x64/koffi.node
./node_modules/node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node
./node_modules/node-pty/prebuilds/linux-x64/pty.node
```

The unresolved-dependency gate passes on the pruned tree.

Implementation notes that were not obvious:

- The scratch checkout has to be a git worktree with build outputs seeded into it.
  `lib/` and `dist/` are gitignored, so a fresh worktree has no built code. Most of it
  is restored into the closure after deploy, but not `native/landlock-run`: that
  declares its own workspace and is excluded from the build globs, so nothing
  rebuilds it. Without seeding, the closure boots and dies on
  `Cannot find module .../@deepseek-ai/node-addon-landlock-run/lib/index.js`.
- The old package-source walker only searched `packages`, `apps`, `vendor`, so it
  never found `native/landlock-run/packages/entry` and never restored its `lib`.
  It now expands the workspace's own `packages:` globs.

## U2. Does `dsh web` boot without `--expose-internals`? YES, it is unnecessary

```
=== with --expose-internals ===
readiness line found, port=44851 after 1s
HTTP GET / -> 200, 14555 bytes
<title>DSH Local Build</title>
=== without --expose-internals ===
readiness line found, port=38893 after 1s
HTTP GET / -> 200, 14555 bytes
<title>DSH Local Build</title>
```

The remote launcher can use plain `node lib/bin.js web --port 0 --no-open`.

## U3. What is on the target? Answered for the probe host

```
uname:      Linux x86_64
os:         Debian GNU/Linux 13 (trixie)
glibc:      ldd (Debian GLIBC 2.41-12+deb13u4) 2.41
node:       v24.21.0
disk free:  203G
home:       /root writable=yes
```

Node 24.21.0 satisfies the harness engine range `^22.19.0 || >=24.0.0`. Note the app
does not need a remote Node at all for the bundled path: Electron-as-Node runs
locally, and the remote path needs whatever Node the remote has.

## U4. Do koffi and sharp linux builds load on the target glibc? YES

Loaded on Debian 13 / glibc 2.41:

```
OK    koffi
OK    sharp
OK    @vscode/ripgrep
```

## U5. Does the target exist? YES

Docker Desktop, `debian:13-slim` at `linux/amd64` under emulation, sshd with
public-key auth only. Reached over real ssh with `BatchMode=yes`, which is what the
app's `buildSshArgs` already sets:

```
ssh-ok
Linux x86_64
```

No ssh-agent and no private key exist for the Ludus range, so the container is the
test host. The Ludus range is up (6 VMs) but has no reachable key material from here.

## Transport and lifecycle facts found while proving U1

These were not in the handoff and change Phase 2.

- **Ship pattern works, at 6.4s for the whole closure:**

  ```
  COPYFILE_DISABLE=1 tar -czf - --exclude="._*" --exclude=".DS_Store" harness-linux-x64 \
    | ssh host 'mkdir -p <key>.tmp && tar xzf - -C <key>.tmp && mv <key>.tmp/harness-linux-x64 <key>'
  ```

  The exclusions are load-bearing. Without them macOS emits AppleDouble `._*` sidecar
  files into the stream, they land in `<key>.tmp`, and the `rmdir` that is supposed to
  prove the temp directory emptied fails. That is the half-closure trap: a populated
  directory is exactly what a later connect would mistake for a valid cache.

- **Compression is worth keeping.** 39MB gzipped moves in 6.4s; the same tree
  uncompressed (282MB) takes 10.4s. An earlier gzip attempt appeared to hang for over
  10 minutes, which did not reproduce; treat it as a transient, not a property of gzip.

- **A remote server must be fully detached or it dies with the ssh session.**
  `nohup node lib/bin.js web ... &` over ssh leaves a process that is gone as soon as
  the connection closes: the log shows a readiness line, then `pgrep` finds nothing.
  What survives is a double detach with every stream redirected:

  ```
  ssh host "cd <key> && setsid sh -c 'node lib/bin.js web --port 0 --no-open \
    >log 2>&1 </dev/null' >/dev/null 2>&1 </dev/null & echo launched"
  ```

  That process was still serving after the session closed. Note this call itself does
  not return promptly, because the remote shell waits on the background child; the
  launch has to be treated as fire-and-forget and readiness discovered by polling the
  log, which is the shape Phase 2 wants anyway.

- **Tunnel works, and one handshake covers everything.** With
  `ControlMaster=auto -o ControlPersist`, a second command over the same master cost
  0.037s.

  ```
  GET / through tunnel -> status=200 bytes=14555
  <title>DSH Local Build</title>
  ```

  Full loop proven: macOS stages a linux closure, ships it over ssh, runs it on the
  remote, tunnels the discovered port back, and serves the UI to this machine.

- **The trust fence was not verified by request.** The harness webserver answers 405 to
  any unknown POST path, so `POST /api/<made-up>` returning 405 proves nothing;
  `/api/rpc` returning 404 does not refute the handoff's claim either, because the app
  relays whatever path the frontend asks for. The `405` catches were discarded rather
  than reported as evidence. The claim in the app's own bridge comment is that a
  tunneled loopback endpoint passes, and the end-to-end check is the app driving a
  working GUI in Phase 2.

## Constraint discovered: the Landlock launcher cannot be produced here

`@deepseek-ai/node-addon-landlock-run-<platform>-<arch>` ships a static-musl C binary
at `bin/landlock-run`. It is gitignored and absent from this checkout. The harness
build script refuses to produce it on macOS:

```
build: native tools are built natively per Linux architecture (no cross toolchain)
— nothing to build on darwin. CI's per-arch runners build and rehearse every
platform package.
```

So a closure staged on this machine ships that package without its binary. That does
**not** break boot: `launcherPath()` documents that existence is deliberately not
checked and `probe()` treats a missing binary as `unusable`, exactly as it treats an
unenforcing kernel. What it means is that the landlock sandbox is unavailable on
shipped closures, and the sandbox falls back. That is a real limitation to state in
the docs, not a bug to paper over. It is also not an npm fallback: the fix would be
building the binary on a Linux host of the same architecture, which is what CI does.

## Revision drift

The fork's HEAD is `c870675c14`, two commits ahead of the `f0d424f65b` recorded in the
staged darwin closure (`cleanup!: make the repository English-only`, then
`test: drop the Chinese test fixtures`). Neither commit touches native dependencies.
The linux closure staged during this probe is at HEAD, so `harness-meta.json` records
`c870675c14` and the cache key reflects it. The app currently ships a darwin closure
two revisions behind its own checkout; restaging it is a separate decision.

## A note on the test host being emulated

`linux/amd64` under Docker Desktop on arm64 runs through emulation, so transfer and
decompression timings above are pessimistic and should not be read as what a real
x86_64 host does. Correctness results (native loads, boot, tunnel, HTTP) are
unaffected by the emulation.
