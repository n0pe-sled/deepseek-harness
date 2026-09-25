# dsh-sandbox

Prebuilt container image hosting the DeepSeek Harness (dsh) and every fork
plugin, published as `ghcr.io/n0pe-sled/dsh-sandbox`.

The image exists so neither the desktop app nor a remote host needs a Node
install, a staged closure, or any build tooling: the runtime is pulled and run.
Containerized execution is the default for DSH Desktop instances, with a
per-instance opt-out that restores the direct host-process behavior.

## What is inside

- `node:22-bookworm-slim` (glibc; satisfies the harness engine range `^22.19.0 || >=24.0.0`)
- `/opt/harness` — the fork's harness closure, staged from a pinned harness ref
- `/opt/plugins` — every fork plugin, built from source
- `/opt/seed-home` — a `sandbox` profile with all plugins installed; copied to
  `/data` on first boot, so your instances and settings survive image upgrades
- `/opt/relay.cjs` — a loopback relay: the harness only ever binds `127.0.0.1`
  (by design, and the CLI refuses `0.0.0.0`), so the relay listens on
  `0.0.0.0:3081` inside the container and shovels bytes to the harness. Docker
  publishes the relay port; the harness keeps its loopback bind and trust fence.

Ports: **3081** is what you publish (the relay). **3000** is the harness, container-internal.

## Run it

```sh
docker run --rm -p 127.0.0.1:3080:3081 -v dsh-sandbox-home:/data ghcr.io/n0pe-sled/dsh-sandbox
# readiness appears in the log:  dsh web: http://127.0.0.1:3000
open http://127.0.0.1:3080
```

- `-v <dir>:/data` backs `$DSH_HOME`. Without it every restart is a fresh
  identity: credentials and sessions are ephemeral.
- Mount workspaces you want the harness to reach as additional volumes; the
  sandbox limits filesystem reach to what is mounted, not API reach — the
  model credentials live in `/data`, so mounting your real `~/.dsh` hands the
  container the same API access the host has. Prefer a private `/data`.

The image ships an **instance manager** plugin: open the web UI's Settings →
Instances to save named instances (workspace, port, env) inside the container
and reconnect to them later. Each saved instance gets its own `$DSH_HOME`
under `/data/instances/<name>`.

## Build it locally

```sh
node scripts/prepare-context.mjs                 # stages closures, builds plugins, seeds the profile
docker buildx build --platform linux/amd64 .     # add --platform linux/arm64 on Apple Silicon
```

Defaults expect sibling checkouts (`../deepseek-harness`, `../DeepSeek-App`);
override with `--harness` / `--app`. The harness tree is only read.

## CI

`.github/workflows/release.yml` pins both source repos (`HARNESS_REF`,
`APP_REF` at the top of the file), builds the context, and pushes
multi-arch images tagged `latest`, `v<version>`, `<version>-<revision>`, and
`sha-<short>`. Bump the pins to ship a new harness or plugin set; the two
plugins currently in flight are built from the pinned ref, never a dirty tree.

## Isolation notes

- The container bounds the harness process tree: filesystem (except mounts),
  processes, and spawned helpers (bash/rg/ssh) run inside it.
- Sandboxing limits filesystem and process reach, **not API reach** — see the
  `/data` note above.
- On Apple Silicon, `linux/amd64` images run under emulation and start slowly;
  prefer the native `linux/arm64` image.
