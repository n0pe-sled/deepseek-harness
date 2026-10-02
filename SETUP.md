# Local checkout setup

This checkout is the whole project. It carries the harness, the fork plugins, the
skills, the desktop app, and the container deployment, so one clone reproduces the
working setup.

## What is in the checkout

| Path | Contents |
|---|---|
| `packages/`, `apps/`, `vendor/` | the harness, unchanged in layout |
| `apps/desktop/` | the Electron desktop shell, folded in from the `DeepSeek-App` repository |
| `plugins/<name>/` | one git submodule per plugin, each its own repository under [`n0pe-sled`](https://github.com/n0pe-sled?tab=repositories) |
| `skills/` | plain skill files folded in from the [`deepseek-harness-skills`](https://github.com/n0pe-sled/deepseek-harness-skills) repository, in `generic-skills/`, `third-party-skills/`, and `security-review-skills/` |
| `skills/specterops-skills/` | a submodule pinned to [SpecterOps/skills](https://github.com/SpecterOps/skills) |
| `dsh-manage.mjs` | discovers the plugins and skills below and syncs a profile with them |

All plugin repositories are listed in `.gitmodules` at the root. They are
**flattened** rather than nested under an intermediate repo: nested submodules do
not initialize under `git clone --recurse-submodules`, so a flat listing is what
makes a plain recursive clone produce a complete tree.

## Relationship to the upstream project

This checkout started as a fork of DeepSeek Harness and is now the project. It does
not track the original repository and takes no updates from it, so `origin` is the
only remote and every commit here is local work. The harness packages keep the
`deepseek-ai` npm scope because that is where they publish, and the release
workflows keep the `deepseek-ai/deepseek-harness` repository URL because npm
resolves trusted publishing against it. Nothing else refers to the original
repository, and no branch here tracks a branch outside `origin`.

## Setup

`dsh-manage` has no bootstrap mode. `--setup` was removed, and the only thing it
builds is the harness itself, under `--install`. Nothing built is
version-controlled, so a fresh clone has to produce it in four steps.

```sh
git clone --recurse-submodules https://github.com/n0pe-sled/deepseek-harness.git
cd deepseek-harness

pnpm install                      # harness dependencies
pnpm run build                    # harness build output

node dsh-manage.mjs --ensure-deps   # mirror the harness dependency closure into
                                   # plugins/node_modules, so out-of-tree plugins
                                   # resolve @deepseek-ai/*

# every plugin builds its own lib/ with tsdown; the guard skips directories that
# carry no package.json, such as plugins/_security-review/
for dir in plugins/*/; do
  [ -f "$dir/package.json" ] || continue
  (cd "$dir" && pnpm install && pnpm run build)
done
```

Cloned without `--recurse-submodules`? `plugins/` arrives empty, so run
`git submodule update --init --recursive` first. The recursive clone is a
convenience rather than a requirement. `skills/` is plain files, so it arrives
either way.

Then pick what the profile runs:

```sh
node dsh-manage.mjs --list      # what was discovered
node dsh-manage.mjs             # interactive picker
node dsh-manage.mjs --all       # enable everything
node dsh-manage.mjs --install   # build and install `dsh` + `dsh-manage` in ~/.local/bin
```

Without flags, and with stdin attached to a terminal, the picker is interactive.
`--all`, `--plugins`, and `--skills` skip it. Applying a selection rewrites
`$DSH_HOME/profiles/<name>/package.json`, runs `pnpm install` in that directory,
and symlinks the chosen skills into `$DSH_HOME/skills`.

`dsh-manage` resolves `plugins/` and `skills/` from the directory containing the
script itself, through symlinks, so the checkout can live anywhere.
`DSH_PLUGINS_REPO` and `DSH_SKILLS_REPO` override that when the repos sit
elsewhere, and `DSH_INSTALL_ANCHOR` and `DSH_HARNESS_REPO` do the same for the
harness root that `--install` and `--ensure-deps` read.

## Flags

| Flag | What it does |
|---|---|
| `--profile <name>` | profile to sync, default `web` |
| `--all` | select all plugins and skills without the TUI |
| `--plugins <names>` | comma-separated plugin names to enable, the others are uninstalled, no TUI |
| `--skills <names>` | comma-separated skill names to enable, the others are uninstalled, no TUI |
| `--list` | list discovered plugins and skills and exit |
| `--ensure-deps` | mirror the dsh installation dependency closure into the plugins repo `node_modules`, idempotent, no profile writes |
| `--install` | build the checked-out harness and install `dsh` plus `dsh-manage` into `~/.local/bin` |
| `--dry-run` | show what would change without writing anything |
| `--help` | show this help |

## What is deliberately not in the checkout

Three plugin directories are excluded from every plugin roster: this checkout, a
profile synced by `dsh-manage`, and the closure the desktop app ships. They are
`crescendo-attacker` (the Crescendo attacker plugin, not its own repository) and
`_security-review` (local scratch holding extracted tarballs and review artifacts),
neither of which is committed, plus `web-search-searxng`, which is no longer a
submodule. Every roster lists them by name and reports one that is present rather
than silently including it, so a scratch directory that gains a manifest can never
reach a shipped build.

## Plugin build output

Each plugin repository builds its own `lib/` with `pnpm run build`. `lib/` is not
version-controlled in the plugin repositories, so a fresh clone carries no build
output and each plugin's `exports` point at files that do not exist until you build
it. `dsh-manage` never builds a plugin: it discovers plugins, mirrors the harness
dependency closure with `--ensure-deps`, and links the ones you select into the
profile. A plugin checked out on another machine therefore arrives unbuilt and stays
that way until you run `pnpm install` and `pnpm run build` in it.
