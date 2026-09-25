# Remote provisioning: phases 1 to 3

Cross-staging, the happy path, and lifecycle. Phase 0 findings live in
`remote-provisioning-phase0.md`; this file records what was built and what was
actually verified against a real host.

Test host: Debian 13 x86_64 in Docker Desktop at `linux/amd64`, reached over real
ssh with key auth. A second host, Alpine 3.20 on musl, is used only to prove the
refusal path.

## What landed

| File | Role |
| --- | --- |
| `src/shared/harness-target.ts` | Target triple parse/format, cache key, and the platform rules that decide which native package belongs to a target |
| `src/shared/readiness.ts` | The `dsh web: http://127.0.0.1:<port>` line, parsed once for local and remote |
| `src/main/instances/provision-parse.ts` | Remote facts parsing and the shell commands that run there |
| `src/main/instances/provision.ts` | detect, preflight, select, ship, launch, stop, uninstall |
| `src/main/instances/closure-catalog.ts` | Which staged closures this build carries, and which one a target gets |
| `src/main/instances/ssh.ts` | Shared connection options; tunnel to a discovered port; one-shot remote commands |
| `scripts/stage-harness.mjs` | `--target`, `--out`, `--keep-worktree`; recursive foreign-artifact pruning |
| `src/shared/instance.ts` | `SshOptions.provision`, and `revision`/`origin` on the runtime view |
| `src/renderer/main.ts`, `styles.css` | Provisioning checkbox with its caveats, and the revision shown on the instance row |

Tests: `tests/unit/harness-target.test.ts` (25), `provision-parse.test.ts` (41),
`closure-catalog.test.ts` (12), plus `remote-provision.integration.test.ts` (5,
skipped unless `DSH_REMOTE_PROBE=1`). Existing suites kept and extended, not
replaced: `pure.test.ts` gained two argv cases and one expectation updated
because `buildSshArgs` now emits `-L` before the destination.

## Phase 1 gate

A linux-x64 closure staged from macOS arm64, booted on a real remote, answering
HTTP on its loopback port.

```
stage-harness: pruned 24 foreign native package(s), 133.9MB smaller
stage-harness: @deepseek-ai/dsh@0.1.1-rc.2 (c870675c14) staged at resources/harness-linux-x64 for linux-x64-glibc
stage-harness: 165.0MB on disk; web UI present, spawn-helper absent (not needed on this target)
```

Measured with `du`, the closure occupies 241MB on disk (28,424 files, so blocks
dominate apparent size) and 39MB gzipped. Its `harness-meta.json` records the
target it was built for, not the host it was built on:

```json
{"version":"0.1.1-rc.2","revision":"c870675c14","platform":"linux","arch":"x64","libc":"glibc", ...}
```

The closure carries exactly the five native binaries a linux-x64 host needs:

```
@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.4.node
@koromix/koffi-linux-x64/linux_x64/koffi.node
node-addon-require-builtin-linux-x64-gnu/prebuilt/linux-x64-gnu-napi-v9.node
node-pty/prebuilds/linux-x64/pty.node
```

And the unresolved-dependency gate passes on the pruned tree, which is the check
that turns a bad prune into a staging failure rather than a remote boot crash.

Three bugs found only by running it:

1. Foreign native packages also live inside other packages' own `node_modules`,
   so a top-level-only walk left darwin and win32 payload behind. The walk is
   recursive now.
2. `node-pty`'s platform prebuilds sit in a subdirectory of the package, which
   the walk never reached because it only descends into `node_modules`. Roughly
   23MB of win32 ConPTY binaries shipped to linux before this was fixed.
3. `sourceDirFor` only searched `packages`, `apps`, and `vendor`, so it never
   found `native/landlock-run/packages/entry` and never restored its `lib/`. The
   closure booted on the remote and died on
   `Cannot find module .../node-addon-landlock-run/lib/index.js`. It now expands
   the workspace's own `packages:` globs.

## Phase 2 gate

From the app's own manager, a provisioned SSH instance produces a working GUI, and
the instance row carries the fork revision.

```
remote: linux-x64-glibc, Debian GNU/Linux 13 (trixie), node v24.21.0, glibc 2.41
closure 0.1.1-rc.2-c870675c14-linux-x64-glibc (revision c870675c14)
shipping 0.1.1-rc.2-c870675c14-linux-x64-glibc (241MB on disk) to /root/.dsh-desktop/harness/...
extracted
closure shipped and verified
starting the remote harness
remote harness listening on 127.0.0.1:40549
```

Runtime view the sidebar renders, from the integration test:

```
status: 'running', revision: 'c870675c14',
origin: { closureKey: '...-linux-x64-glibc', target: 'linux-x64-glibc', provisioned: true }
```

Through the tunnel, from this Mac:

```
GET / -> 200, 14555 bytes, <title>DSH Local Build</title>
POST /api/host.describe -> HTTP 200
{"result":{"ok":true,"value":{"version":"0.0.1","cwd":"/root/.dsh-desktop/harness/...",
 "provider":"deepseek-official","model":"deepseek-v4-flash","home":"/root","canOpenPath":false}}}
```

That tokenless `host.describe` is the trust fence working as the handoff
predicted: a loopback tunnel terminus passes it, so settings and privileged
methods work with no token machinery.

Timing, cold: 24 to 26s total, of which 8.8s is the transfer of a 39MB tarball
into a 241MB tree, on an emulated x86_64 host. Warm reconnect is about 1.1s.

## Phase 3 gate

| Gate | Result |
| --- | --- |
| Reconnect reuses the live server | Yes. Second run logs `reusing the harness already running on port 40549` and returns the same port in 1.1s. |
| A stopped server is not reused | Yes. After `stopRemoteServer`, the next connect starts a fresh server on a new port rather than reporting success against a dead port. |
| Revision mismatch starts fresh without killing the old | Yes, verified with two closures on one host: distinct PIDs, distinct ports, the old server still answering `GET / -> 200` through its own tunnel. Each directory owns its PID file and log. |
| Uninstall removes the directory | Yes. `test -e <dir>` reports gone, and no `<dir>.tmp` remains. |
| Each preflight refusal names the real cause | Verified for musl, unwritable target, and target mismatch; the rest are unit-tested. |

The refusal texts, as produced on a real host:

```
127.0.0.1 runs musl (Alpine Linux v3.20). The native addons in this harness closure
are built against glibc and no musl closure is staged, so the harness cannot run
there. Use a glibc distribution such as Debian, Ubuntu, or RHEL.

/proc is not writable on 127.0.0.1. Set a different remote root in the instance
configuration, or fix permissions there.

the configured target linux-arm64-glibc does not match 127.0.0.1, which reports
linux-x64-glibc.
```

## Bugs that only a real host exposed

**`&;` in the launch command.** The first launch always timed out, with an empty
PID file and an empty log. `&` already separates commands, so the trailing `;`
made the remote shell reject the line before anything ran. The symptom pointed at
the server; the cause was shell syntax.

**`nohup ... &` does not survive the ssh session.** The log showed a readiness
line and the process was gone seconds later. `setsid` in a subshell with all three
streams redirected is what survives.

**Writability cannot be probed with `test -w`.** It answers about permissions, not
about whether the directory accepts entries, so it says yes for `/proc` and for
anything a root user can see. A doomed target passed preflight and failed later as
`mkdir: cannot create directory '/proc/nope'` from the transfer path. The probe now
creates and removes a real directory under the nearest existing parent, and the
refusal names that directory.

**`pkill -f 'bin.js web'` kills the ssh session running it**, because the pattern
matches the sshd-spawned shell's own command line. Killing by the recorded PID is
the only safe way, which is another reason the PID file exists.

**macOS `._*` sidecar files defeat the temp-directory check.** Without
`COPYFILE_DISABLE=1` and explicit excludes, AppleDouble entries land in `<key>.tmp`
and the rename check that proves the temp directory emptied fails. A populated
directory that is not a valid closure must never be cached, so this was worth
getting right rather than tolerating.

**Shell-timeout tolerance.** The remote shell waits on its background child, so a
launch call may not return at all. The provisioner tolerates that and discovers
readiness by polling the log, which is the only shape that works.

## The no-registry property

Nothing in the provisioning path can reach a package registry, and that is
asserted rather than trusted:

```
tests/unit/remote-provision.integration.test.ts > the no-registry property
  ✓ never names a package registry in the provisioning sources
```

The property test strips comments from every source under `src/main/instances` and
fails on an `npm install`-shaped call or a pinned `@deepseek-ai/dsh@<version>`
specifier. Selection failures point at `scripts/stage-harness.mjs` and list the
closures that do exist.

## Known limits, stated plainly

- **The Landlock launcher is absent from any closure staged here.**
  `native/landlock-run` builds a static-musl C binary per Linux architecture with
  no cross-toolchain, and the build script exits on macOS. The harness treats a
  missing launcher as `unusable` and boots anyway, so this costs the sandbox tier,
  not the session. Closing it means building the binary on a same-architecture
  Linux host, which is what CI does.
- **glibc only.** No musl closure is staged.
- **The remote needs its own `node`** (`^22.19.0 || >=24.0.0`).
- **Timings come from an emulated x86_64 host** and are pessimistic; correctness
  results are unaffected.

## Reproducing the live checks

```bash
# start the probe hosts
cd /opt/deepseek/tmp/dsh-remote-probe
docker start dsh-remote dsh-alpine        # Debian 13 :2222, Alpine :2223

# clear any previous run
docker exec dsh-remote sh -c 'for d in /root/.dsh-desktop*/harness/*/; do [ -f "$d/dsh.pid" ] && kill "$(cat $d/dsh.pid)"; done; rm -rf /root/.dsh-desktop*'

# run the live suite
DSH_REMOTE_PROBE=1 DSH_PROBE_HOST=127.0.0.1 DSH_PROBE_PORT=2222 DSH_PROBE_USER=root \
DSH_PROBE_KEY=/opt/deepseek/tmp/dsh-remote-probe/probe_key \
  pnpm vitest run tests/unit/remote-provision.integration.test.ts
```

Container recipes are `Dockerfile` (Debian 13, Node 24) and `Dockerfile.alpine`
(Alpine 3.20, musl) in that directory; both authorize `probe_key.pub` for root and
disable password auth, which is what forces the same key-only path the app uses.
