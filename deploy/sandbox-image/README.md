# dsh-sandbox

Prebuilt container image hosting the DeepSeek Harness (dsh) and every fork
plugin, published as `ghcr.io/n0pe-sled/dsh-sandbox`.

This directory is `deploy/sandbox-image` in the `deepseek-harness` repository, so
the harness closure and the plugins it bakes come from that checkout.

The image exists so neither the desktop app nor a remote host needs a Node
install, a staged closure, or any build tooling: the runtime is pulled and run.
Containerized execution is the default for DSH Desktop instances, with a
per-instance opt-out that restores the direct host-process behavior.

## What is inside

- `node:22-bookworm-slim` (glibc; satisfies the harness engine range `^22.19.0 || >=24.0.0`)
- `/opt/harness` — the harness closure, staged from the workspace in this checkout
- `/opt/harness/plugins-src` — every fork plugin, built from source, plus their
  third-party runtime deps. They live *inside* the harness tree on purpose:
  their `@deepseek-ai/*` peers are provided by the closure, and Node only finds
  those by walking up from the plugin's real path. `/plugins-src` is a symlink
  back into that tree, because the seeded profile links plugins by a relative
  path that lands there once the home is mounted at `/data`.
- `/opt/seed-home` — a `web` profile with all plugins installed; copied to
  `/data` on first boot, so your instances and settings survive image upgrades.
  The `web` profile specifically: it is the template that carries `dsh-web-app`,
  and `dsh web` is an alias for `--profile web`, so the container boots the full
  UI with every plugin already in its layer list.
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

Run these from this directory, so both defaults resolve by walking up out of it:

```sh
node scripts/prepare-context.mjs                       # stages closures, builds plugins, seeds the profile
docker buildx build -f Containerfile --platform linux/amd64 .   # arm64 on Apple Silicon
```

The defaults are the harness root two levels up and the app at `apps/desktop`
inside it. Override with `--harness` / `--app` to build from separate checkouts.
The harness tree is only read.

## CI

The [release workflow](../../.github/workflows/sandbox-release.yml) builds both Linux architectures from the checked-out revision and pinned plugin submodule commits. Push `v0.1.6-beta.1` from the beta branch to publish `ghcr.io/n0pe-sled/dsh-sandbox:beta`, `:v0.1.6-beta.1`, `:0.1.6-beta.1-<full-commit>`, and `:sha-<full-commit>`. Beta branch pushes alone do not build the image; tagging the release avoids duplicate builds. Stable desktop versions publish `latest` and their own version tags. Beta builds never replace `latest` or a stable version tag.

`/opt/image-meta.json` records the desktop release version, harness version, full checked-out commit, and plugin commits. Manual dispatch accepts a ref or full commit SHA. Frozen installs reject dependency drift; local `link:` paths are relocated together with their lockfile entries without changing external resolutions. Release builds reject plugin build failures. The image copies locked production dependencies and performs no registry installs. Native and platform-specific plugin dependencies require per-target staging; the shared plugin payload rejects them, while native peers such as `node-pty` come from each target's harness closure.

```sh
docker run --rm -p 127.0.0.1:3080:3081 -v dsh-sandbox-beta-home:/data ghcr.io/n0pe-sled/dsh-sandbox:beta
```

## Isolation notes

- The container bounds the harness process tree: filesystem (except mounts),
  processes, and spawned helpers (bash/rg/ssh) run inside it.
- Sandboxing limits filesystem and process reach, **not API reach** — see the
  `/data` note above.
- On Apple Silicon, `linux/amd64` images run under emulation and start slowly;
  prefer the native `linux/arm64` image.
