/**
 * Stage the harness closure this app ships, from the checkout it lives in.
 *
 * The app bundles the `deepseek-harness` workspace at whatever version and
 * revision that checkout is on, including its local plugins and skills. The app
 * lives at `apps/desktop` inside it, so staging reads the repository root two
 * levels up unless `--workspace` or `$DSH_HARNESS_WORKSPACE` points elsewhere.
 * It deliberately never installs a published `@deepseek-ai/dsh`
 * from the npm registry: the shipped harness must be the same bytes the
 * developer runs locally, not whatever `latest` happens to point at.
 *
 * The closure comes from frozen-lockfile `pnpm deploy`: production-only,
 * lifecycle scripts disabled, a hoisted node linker, and workspace packages
 * linked rather than fetched. Two post-steps then make the tree shippable:
 *
 *   1. `pnpm deploy` copies each package through its publish `files` field, so
 *      build outputs absent from `files` (the CLI's built `lib/`) do not
 *      survive. They are copied from the checkout afterwards.
 *   2. A packaged app cannot carry symlinks (electron-builder and code signing
 *      both reject them), so every link becomes a real copy and `.bin` shims
 *      are dropped.
 *
 * Output: `resources/harness` — `lib/bin.js` plus a flat `node_modules` — which
 * electron-builder copies to `<app>/Contents/Resources/harness`. The packaged
 * app boots it with its own Electron binary as the Node runtime; see
 * src/main/instances/bundled.ts.
 *
 *   node scripts/stage-harness.mjs                        # this checkout, current build
 *   node scripts/stage-harness.mjs --build                # run the harness build first
 *   node scripts/stage-harness.mjs --workspace /path/to/deepseek-harness
 *   node scripts/stage-harness.mjs --keep-stage           # keep the scratch deploy
 *   node scripts/stage-harness.mjs --target linux-x64-glibc --out resources/harness-linux-x64
 *
 * Staging for another platform. The closure is not portable across platforms:
 * koffi, sharp and node-addon-require-builtin each publish per-platform native
 * packages, so a darwin closure cannot run on a linux remote. `--target` stages
 * a closure for the named platform instead of this machine. `pnpm` decides which
 * native packages to fetch from `supportedArchitectures` in the workspace
 * `pnpm-workspace.yaml`, and that setting is a union with the host: narrowing it
 * to the target alone breaks the host build tooling (esbuild, lefthook and
 * koffi all run install scripts that need this machine's binaries). So staging
 * for a foreign target resolves both, then prunes the foreign-platform packages
 * out of the closure and verifies what is left still resolves.
 *
 * Staging for a foreign target deploys from a scratch git worktree rather than
 * the caller's checkout, so the caller's `pnpm-workspace.yaml` and installed
 * tree are never edited.
 */
import { NODE_VERSION, nodeDistribution, stageNode } from './stage-node.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnresolvedDependencies } from './lib/resolve-closure.ts'
import { formatTarget, harnessCacheKey, hostTarget, packageMatchesTarget, parseTarget, prebuildDirMatchesTarget, targetsEqual } from '../src/shared/harness-target.ts'
import { describeExclusions, discoverPlugins, discoverSkills, partitionPlugins } from '../../../scripts/plugin-roster.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Closure staged for this machine, which is what the packaged app ships. */
const outDir = resolve(repoRoot, 'resources/harness')
/** Scratch deploy target; removed unless --keep-stage. */
const stageDir = resolve(repoRoot, 'resources/.harness-stage')
/** Scratch checkouts used to resolve a foreign target; removed unless --keep-worktree. */
const worktreeRoot = resolve(repoRoot, 'resources/.harness-worktree')
/** The workspace package that owns the `dsh` bin. */
const DEPLOY_FILTER = '@deepseek-ai/dsh'
/** Workspace-relative pnpm virtual store, source for link-override packages. */
const DEPLOY_FILTER_STORE = 'node_modules/.pnpm'
/** Bumped when the staged layout changes, so a stale tree is never mistaken for a fresh one. */
const LAYOUT = 4
/**
 * Directory inside a closure holding the fork's skills.
 *
 * The closure's own `skills/` is safe from Node's resolution walk (nothing
 * imports through it) and the seed script copies out of it, so it is the one
 * place a payload can sit without shadowing a `node_modules` package.
 */
const CLOSURE_SKILLS_DIR = 'skills'
/**
 * Seeder shipped inside every closure.
 *
 * The same bytes seed a local home (the app imports them) and a remote one (the
 * launch script runs them there), and both read the roster from the closure's own
 * version record, so the app never has to know a plugin name itself.
 */
const SEED_SCRIPT_NAME = 'seed-home.mjs'

function parseArgs(argv) {
  const opts = { workspace: undefined, build: false, keepStage: false, target: undefined, out: undefined, keepWorktree: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace') opts.workspace = argv[++i]
    else if (arg === '--build') opts.build = true
    else if (arg === '--keep-stage') opts.keepStage = true
    else if (arg === '--target') opts.target = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--keep-worktree') opts.keepWorktree = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

/**
 * Locate the harness checkout.
 *
 * The app lives at `apps/desktop` inside the harness, so the in-repo root is
 * `../..` and is searched FIRST: a developer who also keeps a sibling
 * `../deepseek-harness` checkout must still stage the harness the app ships
 * inside. An explicit `--workspace` and `$DSH_HARNESS_WORKSPACE` keep working,
 * and a sibling checkout still resolves when the app stands alone.
 *
 * A candidate has to look like the harness root, not merely be named like one.
 * The staging output (`resources/harness`) and the scratch worktree
 * (`resources/.harness-worktree`) sit inside the app, and staging runs
 * `pnpm deploy` from whichever workspace this returns. Accepting either as the
 * root would deploy from inside the tree being staged.
 */
function resolveWorkspace(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_HARNESS_WORKSPACE,
    resolve(repoRoot, '..', '..'),
    resolve(repoRoot, '..', 'deepseek-harness'),
  ].filter((c) => typeof c === 'string' && c !== '')
  for (const candidate of candidates) {
    const dir = resolve(candidate)
    if (isHarnessRoot(dir)) return dir
  }
  throw new Error(
    `no harness workspace found (looked at: ${candidates.join(', ')}). Pass --workspace /path/to/deepseek-harness.`,
  )
}

/**
 * True when a directory is a harness root: `apps/cli/package.json` names the
 * workspace `dsh` deploys from, and `pnpm-workspace.yaml` is the config
 * `pnpm deploy` reads. Both are required.
 */
function isHarnessRoot(dir) {
  return existsSync(join(dir, 'apps', 'cli', 'package.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env })
}

/** Run a command and return trimmed stdout, or throw with its stderr attached. */
function capture(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * The `supportedArchitectures` block pnpm reads to decide which native optional
 * dependencies to fetch. It is always a union with this machine's own platform,
 * because the workspace's install scripts (esbuild, lefthook, koffi) run here
 * and need this machine's binaries. Pruning happens later, on the closure.
 */
function supportedArchitecturesYaml(target) {
  const host = hostTarget()
  const oses = [...new Set([host.platform, target.platform])]
  const cpus = [...new Set([host.arch, target.arch])]
  const libcs = [...new Set([...(host.platform === 'linux' ? [host.libc ?? 'glibc'] : ['current']), ...(target.platform === 'linux' ? [target.libc ?? 'glibc'] : [])])]
  const lines = [
    'supportedArchitectures:',
    '  os:',
    ...oses.map((v) => `    - ${v}`),
    '  cpu:',
    ...cpus.map((v) => `    - ${v}`),
  ]
  if (libcs.length > 0) lines.push('  libc:', ...libcs.map((v) => `    - ${v}`))
  return lines.join('\n')
}

/**
 * A throwaway checkout of the harness at the revision being staged, carrying a
 * `pnpm-workspace.yaml` that resolves native packages for the wanted target.
 *
 * A worktree rather than an in-place edit: `pnpm install` in the developer's
 * checkout would rewrite its `pnpm-workspace.yaml` and installed tree, and a
 * staging step that damages the workspace it reads is not worth the saved
 * seconds. The worktree is detached at the workspace's current HEAD, so the
 * revision in the closure is the revision that was asked for.
 */
function makeTargetWorktree(workspace, target) {
  const head = capture('git', ['rev-parse', 'HEAD'], workspace)
  const path = join(worktreeRoot, head.slice(0, 10))
  removeTargetWorktree(workspace, path)
  mkdirSync(worktreeRoot, { recursive: true })
  run('git', ['worktree', 'add', '--detach', path, head], workspace)
  const configPath = join(path, 'pnpm-workspace.yaml')
  const config = readFileSync(configPath, 'utf8')
  const block = supportedArchitecturesYaml(target)
  const withArch = config.includes('supportedArchitectures')
    ? config.replace(/supportedArchitectures:[\s\S]*?(?=\n\S|\s*$)/, block)
    : config.replace(/^peerDependencyRules:/m, `${block}\n\npeerDependencyRules:`)
  writeFileSync(configPath, withArch)
  return path
}

/** Remove a scratch worktree and its git bookkeeping. */
function removeTargetWorktree(workspace, path) {
  try {
    run('git', ['worktree', 'remove', '--force', path], workspace)
  } catch {
    rmSync(path, { recursive: true, force: true })
  }
  rmSync(worktreeRoot, { recursive: true, force: true })
}

/**
 * Delete the native packages built for some other platform.
 *
 * `supportedArchitectures` has to be a union with the host, so the deploy
 * carries darwin, win32, musl and both architectures at once: roughly 120MB of
 * libvips, koffi and node-pty payload the remote can never load, against about
 * 47MB for the whole closure gzipped. Deleting it is safe in a way that
 * guessing never is, because `packageMatchesTarget` only removes a name it can
 * positively read as a different platform; anything unrecognized is kept.
 *
 * The walk is recursive because foreign copies also sit inside other packages'
 * own `node_modules` (the hoisted linker leaves peer-specialized copies there,
 * and `flattenClosure` skips what already exists). Symlinks are skipped rather
 * than followed: `materializeLinks` has already replaced them with real copies,
 * and following one that survived would descend the same tree twice.
 *
 * Unresolved dependencies are re-checked by the caller afterwards, so a prune
 * that removed something load-bearing fails staging instead of failing remotely.
 */
function pruneForeignArtifacts(target, nodeModules, removed = []) {
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const name = entry.name
    const path = join(nodeModules, name)
    if (name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isSymbolicLink() || !scoped.isDirectory()) continue
        const full = `${name}/${scoped.name}`
        const scopedPath = join(path, scoped.name)
        if (!packageMatchesTarget(full, target)) {
          rmSync(scopedPath, { recursive: true, force: true })
          removed.push(full)
          continue
        }
        const nested = join(scopedPath, 'node_modules')
        if (existsSync(nested)) pruneForeignArtifacts(target, nested, removed)
      }
      continue
    }
    if (!packageMatchesTarget(name, target)) {
      rmSync(path, { recursive: true, force: true })
      removed.push(name)
      continue
    }
    // node-pty keeps every platform's PTY binding under `prebuilds/`, so the
    // foreign ones are pruned at that level. Reached from the package itself:
    // `prebuilds` is not a package name and the generic recursion below only
    // descends into `node_modules`.
    if (name === 'node-pty') {
      const ptyPrebuilds = join(path, 'prebuilds')
      if (existsSync(ptyPrebuilds)) {
        for (const dir of readdirSync(ptyPrebuilds)) {
          if (prebuildDirMatchesTarget(dir, target)) continue
          rmSync(join(ptyPrebuilds, dir), { recursive: true, force: true })
          removed.push(`node-pty/prebuilds/${dir}`)
        }
      }
    }
    const nested = join(path, 'node_modules')
    if (existsSync(nested)) pruneForeignArtifacts(target, nested, removed)
  }
  return removed
}

/** Total bytes under a directory, for the human-readable staging summary. */
function directorySize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += directorySize(path)
    else if (entry.isFile()) total += statSync(path).size
  }
  return total
}

/** True when a path is a real directory (not a symlink, not missing). */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Every directory in the workspace that can hold a package, taken from the
 * workspace's own `pnpm-workspace.yaml` and expanded one level deep.
 *
 * Read rather than hardcoded because the layout changes: `native/landlock-run`
 * and its `packages/*` members are a workspace inside the workspace, and a
 * hardcoded `packages|apps|vendor` list silently skipped them. That skipped
 * package's `lib/` never reached the closure, so a staged harness booted on a
 * remote died on `Cannot find module .../node-addon-landlock-run/lib/index.js`.
 *
 * `packages` globs with a wildcard at the end mean "one more level under each
 * match", which is the only shape this workspace uses, so a single extra
 * expansion covers it.
 */
function workspacePackageDirs(workspace) {
  const configPath = join(workspace, 'pnpm-workspace.yaml')
  const patterns = []
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf8')
    const block = /^packages:\n((?:[ \t]+-.*\n?)*)/m.exec(config)
    if (block !== null) {
      for (const line of block[1].split('\n')) {
        const entry = line.replace(/^\s*-\s*/, '').replace(/#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
        if (entry !== '' && !entry.startsWith('!')) patterns.push(entry)
      }
    }
  }
  for (const fallback of ['packages/*/*', 'apps/*', 'vendor/*', 'native/landlock-run/packages/*']) {
    if (!patterns.includes(fallback)) patterns.push(fallback)
  }

  const dirs = []
  const add = (dir) => {
    if (!dirs.includes(dir) && isDirectory(dir)) dirs.push(dir)
  }
  for (const pattern of patterns) {
    const segments = pattern.split('/').filter((s) => s !== '')
    let matches = [workspace]
    for (const segment of segments) {
      const next = []
      for (const base of matches) {
        if (segment === '*') {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) next.push(join(base, entry.name))
          }
        } else {
          next.push(join(base, segment))
        }
      }
      matches = next
    }
    for (const match of matches) add(match)
  }
  return dirs
}

/**
 * Copy every package's build outputs from one checkout into another.
 *
 * A scratch worktree contains only committed files, and this workspace keeps
 * `lib/` and `dist/` out of git, so a fresh worktree has no built code at all.
 * Most of it is restored into the closure after deploy anyway, but not all:
 * `native/landlock-run` declares its own workspace and is deliberately excluded
 * from the build globs, so its members are built by hand and their `lib/` has
 * to come from the checkout that was built. Without this the closure boots on
 * the remote and dies on `Cannot find module .../node-addon-landlock-run/lib/index.js`.
 *
 * Same two artifacts the closure restorer knows about, so the two steps cannot
 * disagree about what counts as a build output.
 */
function copyBuildOutputs(fromWorkspace, toWorkspace) {
  let copied = 0
  for (const pkgDir of workspacePackageDirs(fromWorkspace)) {
    const relative = pkgDir.slice(fromWorkspace.length + 1)
    for (const artifact of ['lib', 'dist']) {
      const from = join(pkgDir, artifact)
      if (!isDirectory(from)) continue
      const to = join(toWorkspace, relative, artifact)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { recursive: true, dereference: true })
      copied += 1
    }
  }
  return copied
}

/** Short git revision of the harness checkout, or 'unknown' outside a repo. */
function gitRevision(workspace) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Every symlink below a directory, depth-first. */
function findSymlink(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (lstatSync(path).isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every symlink with a real copy and drop `.bin` shims.
 *
 * Nested `node_modules` directories are kept: the hoisted linker still leaves
 * packages that only some consumers need (peer-specialized or platform-gated
 * ones) inside a parent's own `node_modules`, and dropping them is what made a
 * first attempt at this staging fail to boot with
 * `Cannot find package '@mistralai/mistralai'`. Nested trees are walked rather
 * than skipped so their links are materialized too.
 */
function materializeLinks(nodeModules) {
  let remaining = findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      rmSync(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = findSymlink(nodeModules)
      continue
    }
    const source = realpathSync(remaining)
    rmSync(remaining, { recursive: true, force: true })
    cpSync(source, remaining, { recursive: true, dereference: true })
    remaining = findSymlink(nodeModules)
  }
}

/** Map one workspace package name to its source directory in the checkout. */
function sourceDirFor(workspace, fullName) {
  // Names do not map to paths predictably (packages/<category>/<leaf>, apps/*,
  // vendor/*, native/landlock-run/packages/*), so walk every package directory
  // the workspace declares and match on each manifest's name.
  for (const probe of workspacePackageDirs(workspace)) {
    const manifest = join(probe, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === fullName) return probe
    } catch {
      // A malformed manifest cannot be the package we are looking for.
    }
  }
  return undefined
}

/** Read a package.json name, or undefined when the file is absent or invalid. */
function readManifestName(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Flatten the closure into one root `node_modules` holding every package the
 * product actually needs.
 *
 * Deployments can leave packages nested inside another's `node_modules`
 * where they cannot see siblings that exist only at the closure root, because
 * Node resolves imports by walking up from the importing file. The shipped app
 * then dies at boot with `Cannot find package '@deepseek-ai/cordis-plugin-group'`
 * — a `vendor/group` workspace package that `@deepseek-ai/dsh-app-boot` needs.
 *
 * Hoisting every package to the root removes the question, but the set has to
 * be bounded: walking all of `packages/**`, `apps/**` and `vendor/**` drags in
 * unrelated development tooling (eslint, oxlint, mermaid) whose own optional
 * dependencies are not even installed. So the set is the transitive closure of
 * the deploy root's own `dependencies`, resolved one package at a time:
 *
 *   1. the workspace's pnpm store — the exact revisions the closure was built
 *      against,
 *   2. the checkout's workspace packages, which never enter the store.
 *
 * Nested copies are left untouched: they are what a particular consumer
 * resolved, and narrowing that is not this step's job.
 */
function flattenClosure(workspace, target, rootManifest) {
  const nodeModules = join(target, 'node_modules')
  const store = join(workspace, DEPLOY_FILTER_STORE)
  // Peers count too, and for the workspace packages they are the whole point:
  // every `@deepseek-ai/dsh-*` package declares its siblings as
  // `workspace:^` peers, and the runtime imports them at load time. Only peers
  // whose specifier is resolvable are copied — an optional peer such as the
  // `bufferutil` that `ws` lists is deliberately not installed.
  const declaredNames = (manifest) => [
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.peerDependencies ?? {}),
  ]
  const queued = declaredNames(rootManifest)
  const seen = new Set(queued)
  const added = []

  const place = (name, source) => {
    const dest = join(nodeModules, ...name.split('/'))
    if (existsSync(dest)) return
    mkdirSync(dirname(dest), { recursive: true })
    // Copy the package payload only: store entries carry a nested node_modules
    // of their own, and dragging it along builds self-referential chains.
    const nested = join(source, 'node_modules')
    cpSync(source, dest, {
      recursive: true,
      dereference: true,
      filter: (path) => path !== nested && !path.startsWith(nested + sep),
    })
    added.push(name)
  }

  while (queued.length > 0) {
    const name = queued.shift()
    if (name === undefined) break
    const source = resolvePackageSource(workspace, store, name)
    if (source === undefined) continue
    place(name, source)
    // Follow the resolved copy's own runtime needs, so a workspace package's
    // dependencies and peers are hoisted too (not its devDependencies).
    for (const dependency of declaredNames(readManifest(source))) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      queued.push(dependency)
    }
  }
  return added
}

/** Read a package's manifest, or undefined when absent or unparsable. */
function readManifest(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Find one package's source directory: the workspace pnpm store first (the
 * exact revision the closure was built against), then the checkout's workspace
 * packages, which is where `link:vendor/*` overrides live and never enter the
 * store. Only a workspace copy with a built entry is accepted, so a half-built
 * package fails staging instead of failing at boot.
 */
function resolvePackageSource(workspace, store, name) {
  if (existsSync(store)) {
    const installed = join(store, 'node_modules', ...name.split('/'))
    if (readManifest(installed) !== undefined) return realpathSync(installed)
    const wanted = name.replace('/', '+')
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith(`${wanted}@`)) continue
      const candidate = join(store, entry, 'node_modules', ...name.split('/'))
      if (readManifestName(candidate) === name) return candidate
    }
  }
  const source = sourceDirFor(workspace, name)
  if (source === undefined) return undefined
  return hasBuiltEntry(source) ? source : undefined
}

/**
 * Human-readable list of the dependencies nothing in the staged tree can
 * satisfy, judged by Node's own resolution walk from each declaring package
 * (see scripts/lib/resolve-closure.ts). Deduplicated by package name.
 */
function listUnresolved(target) {
  const seen = new Set()
  const labels = []
  for (const entry of findUnresolvedDependencies(target)) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    labels.push(`${entry.name} (needed by ${entry.declaredBy})`)
  }
  return labels
}

/**
 * Every string target reachable in an `exports` value, skipping TypeScript-only
 * conditions. Node never loads a `types` target, and packages such as
 * `json-schema-to-ts` declare a `types` file they do not ship, so counting
 * those would reject a copy that resolves fine at run time.
 */
function collectExportTargets(value, into) {
  if (typeof value === 'string') {
    into.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectExportTargets(entry, into)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [condition, nested] of Object.entries(value)) {
      if (condition === 'types' || condition === 'typescript') continue
      collectExportTargets(nested, into)
    }
  }
}

/**
 * Resolve one `main`/`exports` target to a file inside the package, honoring
 * the conventions real packages use: a bare relative path is as valid as a
 * `./`-prefixed one, `main` may be extensionless (`"index"`), and the target
 * may be a directory holding an `index.js`.
 */
function targetFile(dir, target) {
  const relative = target.startsWith('./') ? target.slice(2) : target
  if (relative === '' || relative.startsWith('/') || relative.startsWith('../')) return undefined
  const base = join(dir, relative)
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const suffix of ['.js', '.cjs', '.mjs', '.json', '.node']) {
    if (existsSync(base + suffix)) return base + suffix
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const index of ['index.js', 'index.cjs', 'index.mjs']) {
      const candidate = join(base, index)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** True when a package's main/exports target an existing built file. */
function hasBuiltEntry(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const candidates = []
    for (const field of ['main', 'module']) {
      if (typeof manifest[field] === 'string') candidates.push(manifest[field])
    }
    collectExportTargets(manifest.exports, candidates)
    if (candidates.length === 0) {
      return ['index.js', 'index.cjs', 'index.mjs'].some((index) => existsSync(join(dir, index)))
        || existsSync(join(dir, 'index.d.ts'))
    }
    return candidates.some((c) => targetFile(dir, c) !== undefined)
  } catch {
    return false
  }
}

/**
 * Copy build outputs that `pnpm deploy` drops because they are absent from a
 * package's publish `files` field. Only packages whose sources live in this
 * checkout are considered; registry dependencies deploy intact.
 */
function restoreBuildArtifacts(workspace, target) {
  const nodeModules = join(target, 'node_modules')
  const restored = []
  for (const scopeDir of readdirSync(nodeModules)) {
    if (!scopeDir.startsWith('@')) continue
    const scopePath = join(nodeModules, scopeDir)
    if (!statSync(scopePath).isDirectory()) continue
    for (const pkgName of readdirSync(scopePath)) {
      const dest = join(scopePath, pkgName)
      if (!existsSync(join(dest, 'package.json'))) continue
      const source = sourceDirFor(workspace, `${scopeDir}/${pkgName}`)
      if (source === undefined) continue
      for (const artifact of ['lib', 'dist']) {
        const from = join(source, artifact)
        const to = join(dest, artifact)
        if (!existsSync(from) || existsSync(to)) continue
        cpSync(from, to, { recursive: true, dereference: true })
        restored.push(`${scopeDir}/${pkgName}/${artifact}`)
      }
    }
  }
  return restored
}

/** Copy one plugin's source out of the checkout, without its installed or built trees. */
function copyPluginSource(from, to) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const base = path.slice(path.lastIndexOf(sep) + 1)
      return base !== 'node_modules' && base !== 'lib' && base !== '.git'
    },
  })
}

/**
 * Copy one built plugin into the closure, without its installed tree.
 *
 * Only `node_modules` is skipped: the built `lib/` is what the Loader imports,
 * so a copy that dropped it would ship a package the Loader cannot load, and
 * `pnpm-lock.yaml` and `pnpm-workspace.yaml` stay for provenance.
 */
function copyBuiltPlugin(from, to) {
  cpSync(from, to, { recursive: true, dereference: true, filter: withoutNestedModules })
}

/**
 * Copy one installed package, without the `node_modules` its own tree holds.
 *
 * A dependency's installed copy carries a nested `node_modules` for the packages
 * only it needs. Every runtime dependency is placed at the closure root instead,
 * where Node's upward walk finds it, and copying the nested tree would repeat the
 * whole closure inside one package.
 */
function copyModulePayload(from, to) {
  cpSync(from, to, { recursive: true, dereference: true, filter: withoutNestedModules })
}

/** Test one path inside a package payload: only a nested `node_modules` is skipped. */
function withoutNestedModules(path) {
  return path.slice(path.lastIndexOf(sep) + 1) !== 'node_modules'
}


/**
 * Repoint the build-time `link:` specs that assume a different checkout layout.
 *
 * Most of this fork's plugins declare their build-time peers as
 * `link:../deepseek-harness/…` or `link:../../packages/…`, which resolves
 * only when the plugin directory sits beside a `deepseek-harness` checkout rather
 * than inside one. Those specs are devDependencies (they compile the plugin and
 * never ship; runtime peers resolve from the closure), so a copy staged elsewhere
 * has them repointed at the real path in the checkout. A spec that already
 * resolves is left alone.
 *
 * Both the manifest and the lockfile are rewritten: `pnpm install
 * --frozen-lockfile` compares the two, and a specifier changed in one alone is a
 * frozen-lockfile failure rather than a build.
 */
async function repointDanglingLinks(dir, workspace, name) {
  const { load, dump } = await import('js-yaml')
  const lockPath = join(dir, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) throw new Error(`plugin ${name} has no pnpm-lock.yaml to install from`)
  const lock = load(readFileSync(lockPath, 'utf8'))
  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  let changed = false
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[section]
    if (deps === undefined || typeof deps !== 'object') continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      if (existsSync(resolve(dir, spec.slice('link:'.length)))) continue
      const relative = spec.slice('link:'.length)
      const candidates = [
        resolve(workspace, relative.replace(/^\.\.\/deepseek-harness\//u, '')),
        resolve(workspace, relative.replace(/^\.\.\/\.\.\//u, '')),
      ]
      const found = candidates.find((candidate) => existsSync(candidate))
      if (found === undefined) continue
      // The lockfile has to move with the manifest: pnpm refuses a lock whose
      // specifier disagrees with the manifest it installs.
      const locked = lock.importers?.['.']?.[section]?.[dep]
      if (locked === undefined || locked.specifier !== spec || locked.version !== spec) {
        throw new Error(`plugin ${name} pins ${dep} as ${spec} in package.json but ${JSON.stringify(locked)} in pnpm-lock.yaml`)
      }
      deps[dep] = `link:${found}`
      locked.specifier = deps[dep]
      locked.version = deps[dep]
      changed = true
    }
  }
  if (changed) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    writeFileSync(lockPath, dump(lock, { lineWidth: -1, noRefs: true }))
  }
}

/**
 * Copy one plugin's own runtime dependencies into the closure root.
 *
 * The built plugin is a bundle: it externalizes `@deepseek-ai/*` peers and
 * whatever its tsdown config lists as production dependencies, and everything else
 * is inlined into `lib/`. A name the closure already carries is left alone,
 * which is what keeps the closure's own platform-specific copy of a package such
 * as `node-pty` authoritative: it was chosen for this target, and the plugin
 * resolving it by Node's upward walk is the same package the rest of the closure
 * loads.
 *
 * Each dependency is resolved from the package it was declared by, not from the
 * closure: the hoisted linker leaves a package nested under its consumer when two
 * consumers need different versions, and a closure-root-only lookup misses it —
 * `monaco-editor` keeps its own `marked` in `node_modules/monaco-editor`.
 *
 * Native and platform-specific packages are accepted here, unlike in the container:
 * that image serves two architectures from one payload, while a closure serves one
 * target, which is the whole reason staging runs per target.
 *
 * @param from - the built plugin directory holding the installed tree.
 * @param closureRoot - the closure root that receives the packages.
 * @param added - sink for the names this call placed.
 * @param seen - names already judged, so one package is resolved once.
 */
function placePluginRuntimeDependencies(from, closureRoot, added, seen = new Set()) {
  const manifest = readManifest(from)
  if (manifest === undefined) return
  const source = manifest.name
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/')) continue
    const resolved = resolveInstalledPackage(from, name)
    if (resolved === undefined) continue
    // A package's own name is not a dependency of itself, so this only breaks
    // the walk on a package that reached itself through a cycle.
    if (seen.has(name)) continue
    seen.add(name)
    if (typeof source === 'string' && name === source) continue
    const dest = join(closureRoot, 'node_modules', ...name.split('/'))
    if (!existsSync(dest)) {
      mkdirSync(dirname(dest), { recursive: true })
      copyModulePayload(resolved, dest)
      added.push(name)
    }
    placePluginRuntimeDependencies(resolved, closureRoot, added, seen)
  }
}

/**
 * Resolve one package the way Node does from a declaring package, or undefined.
 *
 * The walk ascends from the declaring package, so a version the linker nested
 * under a consumer is found before the closure root's own copy.
 *
 * @param from - the declaring package directory.
 * @param name - the dependency name.
 * @returns the resolved package directory, or undefined when nothing resolves.
 */
function resolveInstalledPackage(from, name) {
  let current = from
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
/**
 * Stage the fork's plugins and skills into a closure.
 *
 * A plugin is placed INSIDE the closure, at `<closure>/node_modules/<name>`, so a
 * profile resolves it as a bundle from the install anchor without pnpm and without
 * a profile `dependencies` entry. The closure root is the same directory the
 * closure's own packages live in, so the plugin's `@deepseek-ai/*` peers and its
 * third-party runtime dependencies resolve by Node's ordinary upward walk. This is
 * the container's placement rule, and it is the only one of the two proven: the
 * closure's install-anchor resolution walks `node_modules` directories, so
 * `<closure>/plugins-src/<name>` would need a profile dependency and an install
 * that a packaged app cannot run.
 *
 * The pnpm work happens on a copy of each plugin under the OS temp directory,
 * never in the checkout and never in `<workspace>/plugins/*`: staging reads a
 * checkout another process may be working in. Temp rather than the scratch deploy
 * directory is load-bearing — `pnpm install` walks up for a `pnpm-workspace.yaml`,
 * and a directory inside the harness resolves the harness workspace's own config,
 * which installs the whole workspace instead of the one plugin.
 *
 * The closure carries the whole third-party runtime dependency set of every
 * plugin, and `listUnresolved` then judges the result the way Node would.
 *
 * @param workspace - the harness checkout whose plugins are staged.
 * @param closureRoot - the closure root that receives the packages and skills.
 * @returns the staged plugin bundle names, skill names, and excluded directory names.
 */
async function stagePluginsAndSkills(workspace, closureRoot) {
  const discovered = discoverPlugins(workspace)
  const { shipped, excluded } = partitionPlugins(discovered)
  if (excluded.length > 0) console.warn(`stage-harness: ${describeExclusions(excluded)}`)
  if (shipped.length === 0) throw new Error(`no plugin packages found under ${join(workspace, 'plugins')}`)

  const pluginsRoot = join(tmpdir(), `dsh-plugin-stage-${String(process.pid)}`)
  mkdirSync(pluginsRoot, { recursive: true })
  const staged = []
  try {
    for (const plugin of shipped) {
      const build = join(pluginsRoot, plugin.name)
      console.log(`stage-harness: plugin ${plugin.packageName}`)
      copyPluginSource(plugin.dir, build)
      await repointDanglingLinks(build, workspace, plugin.name)
      run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], build)
      const manifest = JSON.parse(readFileSync(join(build, 'package.json'), 'utf8'))
      if (manifest.scripts?.build !== undefined) run('pnpm', ['build'], build)
      // Judged by artifacts, not by exit code: a plugin mid-edit can fail a
      // build-time typecheck after its bundles were already emitted, and a plugin
      // with no `lib/index.js` is not loadable at all.
      if (!existsSync(join(build, 'lib', 'index.js'))) {
        throw new Error(`plugin ${plugin.packageName} produced no lib/index.js; a closure must carry a loadable plugin or none`)
      }
      const dest = join(closureRoot, 'node_modules', ...plugin.packageName.split('/'))
      if (existsSync(dest)) throw new Error(`closure already carries ${plugin.packageName}`)
      copyBuiltPlugin(build, dest)
      placePluginRuntimeDependencies(build, closureRoot, [])
      staged.push(plugin.packageName)
    }
    const skills = stageSkills(workspace, closureRoot)
    return { plugins: staged, skills, excluded: excluded.map((entry) => entry.name) }
  } finally {
    rmSync(pluginsRoot, { recursive: true, force: true })
  }
}

/**
 * Copy the fork's skills into `<closure>/skills/<name>`.
 *
 * One directory per skill, named by its frontmatter `name`, which is exactly the
 * shape the skill-filesystem provider scans in `$DSH_HOME/skills` and the shape
 * `dsh-manage` links there. The skill's own directory is copied whole so a
 * skill's own supporting files travel with it.
 *
 * @param workspace - the harness checkout whose skills are staged.
 * @param closureRoot - the closure root that receives them.
 * @returns the staged skill names.
 */
function stageSkills(workspace, closureRoot) {
  const skills = discoverSkills(workspace)
  if (skills.length === 0) throw new Error(`no skills found under ${join(workspace, 'skills')}`)
  for (const skill of skills) {
    const dest = join(closureRoot, CLOSURE_SKILLS_DIR, skill.name)
    if (existsSync(dest)) throw new Error(`closure already carries skill ${skill.name}`)
    // The parent is created here rather than by the copy: a destination's own
    // parent has to exist for the filesystem provider to find the entry at all,
    // and an all-empty skills tree must still be a directory.
    mkdirSync(join(closureRoot, CLOSURE_SKILLS_DIR), { recursive: true })
    cpSync(skill.dir, dest, { recursive: true, dereference: true })
  }
  return skills.map((skill) => skill.name)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const host = hostTarget()
  const target = opts.target === undefined ? host : parseTarget(opts.target)
  nodeDistribution(target)
  const foreign = !targetsEqual(target, host)
  const output = opts.out === undefined ? outDir : resolve(repoRoot, opts.out)
  const scratch = foreign ? resolve(repoRoot, 'resources/.harness-stage-target') : stageDir

  if (!foreign && process.platform !== 'darwin') {
    console.warn(`warning: staging on ${process.platform}; the closure carries ${process.platform}-specific native addons`)
  }
  const workspace = resolveWorkspace(opts.workspace)
  const pinnedVersion = JSON.parse(readFileSync(join(workspace, 'apps', 'cli', 'package.json'), 'utf8')).version
  const revision = gitRevision(workspace)
  console.log(`stage-harness: workspace ${workspace}`)
  console.log(`stage-harness: pinned ${DEPLOY_FILTER}@${pinnedVersion} (revision ${revision})`)
  console.log(`stage-harness: target ${formatTarget(target)}${foreign ? ` (cross-staging from ${formatTarget(host)})` : ''}`)
  console.log(`stage-harness: cache key ${harnessCacheKey(pinnedVersion, revision, target, NODE_VERSION)}`)

  if (opts.build) {
    console.log('stage-harness: building the harness workspace')
    run('pnpm', ['run', 'build'], workspace)
  }

  const cliEntry = join(workspace, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cliEntry)) {
    throw new Error(`no built CLI at ${cliEntry}; rerun with --build (or run pnpm run build in the workspace)`)
  }
  const frontendDist = join(workspace, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(frontendDist)) {
    throw new Error(`no built web UI at ${frontendDist}; rerun with --build (or run pnpm run build in the workspace)`)
  }

  // A foreign target resolves its native packages from a scratch checkout, so
  // this repository's own workspace config and installed tree stay untouched.
  // Build outputs are not part of that: they are platform-independent, so they
  // are copied out of the caller's build below rather than rebuilt there.
  let deployWorkspace = workspace
  let worktree
  if (foreign) {
    console.log('stage-harness: preparing a scratch worktree with target architectures')
    worktree = makeTargetWorktree(workspace, target)
    deployWorkspace = worktree
    const seeded = copyBuildOutputs(workspace, worktree)
    console.log(`stage-harness: seeded ${String(seeded)} build output(s) from ${workspace}`)
    console.log(`stage-harness: installing target native packages (${formatTarget(host)} + ${formatTarget(target)})`)
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], worktree)
  }

  // pnpm deploy writes its production options into the source workspace's
  // deps-status cache; retain the development installation's configuration.
  const workspaceStatePath = join(deployWorkspace, 'node_modules', '.pnpm-workspace-state-v1.json')
  const workspaceState = existsSync(workspaceStatePath) ? readFileSync(workspaceStatePath) : undefined
  try {
    console.log(`stage-harness: pnpm deploy ${DEPLOY_FILTER} -> ${scratch}`)
    rmSync(scratch, { recursive: true, force: true })
    run('pnpm', [
      '--filter', DEPLOY_FILTER, 'deploy',
      '--prod',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      '--config.link-workspace-packages=true',
      scratch,
    ], deployWorkspace)

    const deployedManifest = join(scratch, 'package.json')
    if (!existsSync(deployedManifest)) {
      throw new Error(`pnpm deploy produced no package.json at ${deployedManifest}`)
    }
    const deployed = JSON.parse(readFileSync(deployedManifest, 'utf8'))
    if (deployed.version !== pinnedVersion) {
      throw new Error(`deployed version ${String(deployed.version)} does not match the pinned ${pinnedVersion}`)
    }

    // The CLI package is the deploy root, so its built lib/ belongs at the top
    // level; deploy filtered it out through `files`, so copy it from the checkout.
    cpSync(join(workspace, 'apps', 'cli', 'lib'), join(scratch, 'lib'), { recursive: true, dereference: true })
    // Read build outputs from the checkout that was actually deployed, so the
    // source directory of a package always sits next to the node_modules the
    // workspace's own build produced for it.
    const restored = restoreBuildArtifacts(deployWorkspace, scratch)
    if (restored.length > 0) console.log(`stage-harness: restored build outputs: ${restored.join(', ')}`)

    materializeLinks(join(scratch, 'node_modules'))

    // Flatten the tree so every package the product needs is reachable from the
    // closure root; see flattenClosure for why the deployed layout cannot boot.
    const flattened = flattenClosure(deployWorkspace, scratch, deployed)
    if (flattened.length > 0) {
      console.log(`stage-harness: flattened ${String(flattened.length)} package(s) into the closure root`)
    }
    materializeLinks(join(scratch, 'node_modules'))

    // A target closure must not carry another platform's native packages, and
    // pruning them can strand a dependency, so the unresolved check below runs
    // after this, on the pruned tree.
    if (foreign) {
      const before = directorySize(scratch)
      const removed = pruneForeignArtifacts(target, join(scratch, 'node_modules'))
      const after = directorySize(scratch)
      console.log(`stage-harness: pruned ${String(removed.length)} foreign native package(s), ${mb(before - after)} smaller`)
    }

    // The fork's plugins and skills go in before the unresolved check, so a
    // plugin dependency that does not resolve fails staging instead of a boot.
    const roster = await stagePluginsAndSkills(workspace, scratch)
    console.log(`stage-harness: ${String(roster.plugins.length)} plugin(s) and ${String(roster.skills.length)} skill(s) staged into the closure`)

    // Nothing may remain unresolvable: a missing package here would only surface
    // as a boot crash in the shipped app.
    const unresolved = listUnresolved(scratch)
    if (unresolved.length > 0) {
      throw new Error(`staged closure is missing packages: ${unresolved.join(', ')}`)
    }

    await stageNode(target, scratch)

    rmSync(output, { recursive: true, force: true })
    mkdirSync(dirname(output), { recursive: true })
    cpSync(scratch, output, { recursive: true, dereference: true })

    // node-pty ships a PTY helper beside its prebuilds; it is a real executable
    // and must survive both copies with its mode intact. Only darwin ships one
    // today, so on linux this reports absence rather than failing.
    const helperPath = join(output, 'node_modules', 'node-pty', 'prebuilds', `${target.platform}-${target.arch}`, 'spawn-helper')
    const helperPresent = existsSync(helperPath)
    if (helperPresent) chmodSync(helperPath, 0o755)

    const stagedCli = join(output, 'lib', 'bin.js')
    if (!existsSync(stagedCli)) throw new Error(`staged closure has no CLI entry at ${stagedCli}`)
    const stagedFrontend = join(output, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
    if (!existsSync(stagedFrontend)) throw new Error(`staged closure has no web UI at ${stagedFrontend}`)

    writeFileSync(join(output, 'harness-meta.json'), `${JSON.stringify({
      version: deployed.version,
      revision,
      workspace,
      layout: LAYOUT,
      platform: target.platform,
      arch: target.arch,
      ...(target.platform === 'linux' ? { libc: target.libc ?? 'glibc' } : {}),
      node: process.version,
      runtimeVersion: NODE_VERSION,
      plugins: roster.plugins,
      skills: roster.skills,
      ...(roster.excluded.length > 0 ? { pluginsExcluded: roster.excluded } : {}),
      stagedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    // The app seeds a home from this record, so it lives inside the closure
    // rather than in the app's own source: a closure is the unit that ships, and
    // it is also the unit a remote receives, so one record serves both.
    writeFileSync(join(output, SEED_SCRIPT_NAME), readFileSync(join(repoRoot, 'scripts', SEED_SCRIPT_NAME)))
    console.log(`stage-harness: plugins ${roster.plugins.join(', ') || 'none'}`)
    console.log(`stage-harness: skills ${roster.skills.join(', ') || 'none'}`)

    const relative = output.startsWith(repoRoot + sep) ? output.slice(repoRoot.length + 1) : output
    console.log(`stage-harness: ${DEPLOY_FILTER}@${String(deployed.version)} (${revision}) staged at ${relative} for ${formatTarget(target)}`)
    console.log(`stage-harness: ${mb(directorySize(output))} on disk; web UI present, spawn-helper ${helperPresent ? 'present and executable' : 'absent (not needed on this target)'}`)
  } finally {
    if (workspaceState === undefined) rmSync(workspaceStatePath, { force: true })
    else writeFileSync(workspaceStatePath, workspaceState)
    if (!opts.keepStage) rmSync(scratch, { recursive: true, force: true })
    if (worktree !== undefined && !opts.keepWorktree) removeTargetWorktree(workspace, worktree)
  }
}

/** Format a byte count for the staging summary. */
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

await main()
