# Agent Note: Widened PATH for desktop ssh children

Status: implemented

## Problem

An instance reached its host through a `ProxyCommand` in `~/.ssh/config`, and the app could not connect while the same command worked in a terminal:

```
ProxyCommand ncat --proxy-type socks5 --proxy 127.0.0.1:9050 %h %p
```

```
zsh:1: command not found: ncat
Connection closed by UNKNOWN port 65535
```

ssh runs a `ProxyCommand` through the user's shell, and that shell searches the PATH of the ssh child. An app started from Finder inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds no directory a package manager installs into, so `ncat` (Homebrew, shipped with the nmap formula) resolved in a terminal and not in the app. The app's local and container spawns already widened PATH for this reason; the ssh spawns did not, so the helper lookup happened inside ssh with nothing widening it.

Two secondary faults hid the cause. Every failed provision command reported "Provisioning needs key-based authentication", whatever ssh's stderr said, and `Connection closed by UNKNOWN port 65535` — what ssh reports for any failed proxy — reads as a remote failure.

## Decision

`augmentedEnv` in [exec-path.ts](../../../../apps/desktop/src/main/instances/exec-path.ts) widens PATH on a copy of an environment, and `sshSpawnEnv` in [ssh.ts](../../../../apps/desktop/src/main/instances/ssh.ts) is the environment every ssh child runs with. `runSshCommand`, `forwardSshTunnelTo`, and the provisioner's `shipOverSsh` all pass it, so one ssh invocation in this app resolves helpers where another does. `local.ts` uses the same helper for its own spawn instead of widening PATH in place.

`describeSshFailure` classifies the proxy path ahead of the remote cases, on `Ncat:`, `ProxyCommand`, `ProxyJump`, or `Connection closed by UNKNOWN`, and its `remotePort` became optional: with no forwarded port, which is what a provision command passes, a bare "Connection refused" is no longer described as an empty remote loopback port, while a tunnel still reads it that way. `RemoteProvisioner.detect` calls that classifier and keeps its key-based-authentication sentence as the fallback for stderr that names no cause.

## Alternatives considered

**Document only: put the helper's absolute path in `~/.ssh/config`.** Rejected as the fix. `ssh` accepts an absolute `ProxyCommand`, but the app cannot reach a helper a config names in any other form, and one host working while the next fails on the same cause is a worse failure mode than widening PATH once.

**Ask the login shell for its PATH.** Rejected because resolving it costs a subprocess on every spawn and inherits whatever the user's rc files print, while `augmentPath` already solved this on `local.ts` with a fixed directory list.

**Spawn ssh with no explicit environment.** Rejected because that is the failing behavior: ssh resolves `ProxyCommand` helpers and an `IdentityAgent` socket through the PATH it inherits.

**Report the proxy failure as its own error code.** Rejected because the refusal carries ssh's own text for the user to read, so one sentence of guidance beside it needs no wire field for the sidebar to render.

## Verification

`tests/unit/ssh-spawn-env.test.ts` spawns no ssh: it stands in for the binary and asserts that the command path, the tunnel, and the provisioner's transfer each hand ssh a PATH carrying `/opt/homebrew/bin`, with the inherited PATH first. `tests/unit/exec-path.test.ts` covers the widened copy and that the environment it was handed is untouched. `tests/unit/pure.test.ts` covers the proxy-first classifier against both captured stderr pairs: the helper that could not be found and the proxy that refused.

## Consequences

A host reached through an installed helper connects from the app, and the helper lookup no longer depends on how the app was started. The added directories are searched only for names the inherited PATH lacks, so a binary the user already reaches keeps winning. The widening is a fixed directory list — `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `~/.local/bin`, `~/bin` — so a helper installed anywhere else still fails, and it now says why. The proxy classification reads `Connection closed by UNKNOWN` as a local failure, which is what a failed `ssh -W` reports as well.

## Related

[Desktop app self-update](../feature/2026-09-29-desktop-self-update.md) solves the same launchd-PATH problem for its own `gh` lookup, with the directory list `GH_INSTALL_DIRS` in `apps/desktop/src/main/update/catalog.ts` and its own `findGh`. That consumer keeps its list, so folding the two into one widening is a separate change.
