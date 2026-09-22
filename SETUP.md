# Local checkout setup

This is a fork of DeepSeek Harness that carries the plugins and skills used on
this machine, so one clone reproduces the working setup.

## What is in the checkout

| Path | Contents |
|---|---|
| `packages/`, `apps/`, `vendor/` | the upstream harness, unchanged in layout |
| `plugins/<name>/` | one git submodule per plugin, each its own repository under [`n0pe-sled`](https://github.com/n0pe-sled?tab=repositories) |
| `skills/` | a submodule of [`deepseek-harness-skills`](https://github.com/n0pe-sled/deepseek-harness-skills), whose own `generic-skills/`, `third-party-skills/`, and `security-review-skills/` directories hold plain skill files |
| `dsh-manage.mjs` | discovers the plugins and skills below and syncs a profile with them |

All plugin repositories are listed in `.gitmodules` at the root. They are
**flattened** rather than nested under an intermediate repo: nested submodules do
not initialize under `git clone --recurse-submodules`, so a flat listing is what
makes a plain recursive clone produce a complete tree.

## Setup

```sh
git clone --recurse-submodules https://github.com/n0pe-sled/deepseek-harness.git
cd deepseek-harness
node dsh-manage.mjs --setup
```

`--setup` is the whole install. Nothing built is version-controlled, so it does
everything a fresh clone is missing: initialize the submodules, run
`pnpm install` and `pnpm run build` for the harness, mirror the harness
dependency closure into `plugins/node_modules` so out-of-tree plugins resolve
`@deepseek-ai/*`, and build each plugin's `lib/` for this platform. It writes
nothing to a profile.

Cloned without `--recurse-submodules`? `--setup` initializes the submodules too,
so the recursive clone is a convenience rather than a requirement.

Then pick what the profile runs:

```sh
node dsh-manage.mjs --list      # what was discovered
node dsh-manage.mjs             # interactive picker
node dsh-manage.mjs --all       # enable everything
node dsh-manage.mjs --install   # build and install `dsh` + `dsh-manage` in ~/.local/bin
```

`dsh-manage` resolves `plugins/` and `skills/` from the directory containing the
script itself, so the checkout can live anywhere. `DSH_PLUGINS_REPO`,
`DSH_SKILLS_REPO`, `DSH_HARNESS_REPO`, and `DSH_INSTALL_ANCHOR` override that
when the repos sit elsewhere.

## What is deliberately not in the checkout

- `plugins/crescendo-attacker/` — the Crescendo attacker plugin, excluded from
  this migration on purpose and not yet its own repository.
- `plugins/_security-review/` — local scratch (extracted tarballs and review
  artifacts, about 157 MB). Never committed.

Both remain untracked working copies; neither is reachable from a clone.

## Plugin build output

`dsh-manage` records the platform that produced each plugin's `lib/` in
`lib/.dsh-build-target` and rebuilds when that stamp is missing or names another
platform. `lib/` is not version-controlled in the plugin repositories, so a
Linux host rebuilds plugins checked out on macOS, and vice versa.
