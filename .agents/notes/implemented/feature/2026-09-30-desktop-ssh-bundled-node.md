# Agent Note: Bundled Node for desktop SSH provisioning

Status: implemented

## Problem

Shipping JavaScript and native dependencies to an SSH host does not provide the executable needed to start them. Requiring a compatible Node installation prevents otherwise usable hosts from connecting.

## Decision

The [desktop staging script](../../../../apps/desktop/scripts/stage-harness.mjs) includes an official, target-specific Node executable at `bin/node` and its upstream license. The [runtime staging helper](../../../../apps/desktop/scripts/stage-node.ts) pins the version and archive SHA-256 digests together, verifies downloaded bytes before extraction, and rejects unsupported targets. Downloads happen on the packaging machine, so the SSH host needs no runtime download access.

SSH provisioning launches the bundled executable by default and prepends its directory to `PATH` for child processes. An explicit `provision.nodePath` overrides the initial executable. Runtime version participates in remote cache identity; extraction and cache checks require executable `bin/node`. Old staged payloads require restaging. Release packaging includes Linux glibc x64 and ARM64 payloads alongside the local Mac payload.

## Alternatives considered

**Require system Node.** This makes connection depend on remote administrator setup and the noninteractive SSH environment's PATH.

**Download Node on first connection.** This requires outbound network access on the remote and adds a second installation path. Bundling keeps runtime selection and integrity verification in the packaging process.

**Ship the desktop host's executable to every remote.** Host and remote operating systems and architectures can differ. Each payload needs the matching official distribution.

## Consequences

Application downloads and staging take more space and time. Maintainers must update the runtime pin and checksums together for security releases. Bundling does not supply host libraries or add musl support. The local desktop launch continues to use Electron's embedded Node.

Focused tests exercise checksum rejection, target selection, runtime cache identity, incomplete extraction, and a shell launch with no system Node on PATH, including a Node child process. The staging helper has a native download-and-execute smoke check. A live Linux SSH session and a complete multi-target application package remain release validation requirements.
