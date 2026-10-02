# Agent Note: macOS release signing raises both descriptor ceilings

Status: implemented

## Problem

`pnpm exec electron-builder --mac dmg` signs the packaged app with `@electron/osx-sign`. That signer walks every path under the app's `Contents` with `Promise.all` and calls `isBinaryFile` on each candidate, holding one open descriptor per in-flight file. The bundled `harness-linux-*` closures add tens of thousands of files to that walk, and the beta release build failed with `EMFILE: too many open files` mid-scan.

The build step already sized a soft `ulimit` from the staged file count, but that is not the effective ceiling on macOS: `kern.maxfilesperproc` starts at 61440 and limits open descriptors independently of the shell's soft limit. The failed run printed a soft limit of 111854 and still hit `EMFILE`, which shows the kernel ceiling was binding.

## Decision

`.github/workflows/release-macos.yml` raises `kern.maxfiles` and `kern.maxfilesperproc` with `sudo sysctl` to 1048576 and 524288, then sets the soft descriptor limit to two per staged file plus 16384 headroom, clamped to the hard limit when that is a number. The signer can then open every candidate file concurrently and the scan completes.

The build runs on an ephemeral GitHub runner, so the kernel change is scoped to one job and leaves no state behind.

## Alternatives considered

**Size the soft limit larger without touching the kernel.** This is the smallest change, but `kern.maxfilesperproc` caps actual opens independently of the soft limit, so no soft value above it takes effect.

**Count files in the packaged `.app` instead of `resources`.** That count matches what the signer walks, but the app directory does not exist until electron-builder packages it, inside the same command that signs it.

**Patch `@electron/osx-sign` to bound its `Promise.all`.** A bounded walk addresses the root cause, but it means patching a nested dependency of electron-builder for behavior the pinned install otherwise supplies.

## Consequences

The signing step tolerates arbitrary file counts in the bundled closures while the kernel ceilings permit them. The job mutates host kernel state, which is acceptable on a disposable runner; a future signer that bounds its own concurrency would remove the need.
