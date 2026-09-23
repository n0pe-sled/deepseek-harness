/**
 * Stage the harness closure this app ships — from the PINNED local checkout.
 *
 * The app bundles the `deepseek-harness` workspace at whatever version and
 * revision that checkout is on (0.1.1-rc.2 today), including its local plugins
 * and skills. It deliberately never installs a published `@deepseek-ai/dsh`
 * from the npm registry: the shipped harness must be the same bytes the
 * developer runs locally, not whatever `latest` happens to point at.
 *
 * The closure comes from `pnpm deploy` with the harness repo's own staging
 * flags (scripts/build-exe-for-python-sdk.ts uses the same recipe):
 * production-only, hoisted node linker, workspace packages linked rather than
 * fetched. Two post-steps then make the tree shippable:
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
 *   node scripts/stage-harness.mjs                        # pinned checkout, current build
 *   node scripts/stage-harness.mjs --build                # run the harness build first
 *   node scripts/stage-harness.mjs --workspace /path/to/deepseek-harness
 *   node scripts/stage-harness.mjs --keep-stage           # keep the scratch deploy
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findUnresolvedDependencies } from './lib/resolve-closure.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(repoRoot, 'resources/harness')
/** Scratch deploy target; removed unless --keep-stage. */
const stageDir = resolve(repoRoot, 'resources/.harness-stage')
/** The workspace package that owns the `dsh` bin. */
const DEPLOY_FILTER = '@deepseek-ai/dsh'
/** Workspace-relative pnpm virtual store, source for link-override packages. */
const DEPLOY_FILTER_STORE = 'node_modules/.pnpm'
/** Bumped when the staged layout changes, so a stale tree is never mistaken for a fresh one. */
const LAYOUT = 2

function parseArgs(argv) {
  const opts = { workspace: undefined, build: false, keepStage: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace') opts.workspace = argv[++i]
    else if (arg === '--build') opts.build = true
    else if (arg === '--keep-stage') opts.keepStage = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

/** Locate the harness checkout: explicit flag, $DSH_HARNESS_WORKSPACE, or a sibling. */
function resolveWorkspace(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_HARNESS_WORKSPACE,
    resolve(repoRoot, '..', 'deepseek-harness'),
  ].filter((c) => typeof c === 'string' && c !== '')
  for (const candidate of candidates) {
    const dir = resolve(candidate)
    if (existsSync(join(dir, 'apps', 'cli', 'package.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
  }
  throw new Error(
    `no harness workspace found (looked at: ${candidates.join(', ')}). Pass --workspace /path/to/deepseek-harness.`,
  )
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env })
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
  // vendor/*), so walk the workspace roots and match on each manifest's name.
  for (const root of ['packages', 'apps', 'vendor']) {
    const rootPath = join(workspace, root)
    if (!existsSync(rootPath)) continue
    for (const first of readdirSync(rootPath)) {
      const firstPath = join(rootPath, first)
      if (!statSync(firstPath).isDirectory()) continue
      const probes = [firstPath]
      for (const second of readdirSync(firstPath)) {
        const secondPath = join(firstPath, second)
        if (statSync(secondPath).isDirectory()) probes.push(secondPath)
      }
      for (const probe of probes) {
        const manifest = join(probe, 'package.json')
        if (!existsSync(manifest)) continue
        try {
          if (JSON.parse(readFileSync(manifest, 'utf8')).name === fullName) return probe
        } catch {
          // A malformed manifest cannot be the package we are looking for.
        }
      }
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
 * `pnpm deploy --legacy` leaves packages nested inside another's `node_modules`
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
  // whose specifier is resolvable are queued — an optional peer such as the
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
    const wanted = name.startsWith('@') ? name.slice(1).replace('/', '+') : name
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

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (process.platform !== 'darwin') {
    console.warn(`warning: staging on ${process.platform}; the closure carries ${process.platform}-specific native addons`)
  }
  const workspace = resolveWorkspace(opts.workspace)
  const pinnedVersion = JSON.parse(readFileSync(join(workspace, 'apps', 'cli', 'package.json'), 'utf8')).version
  const revision = gitRevision(workspace)
  console.log(`stage-harness: workspace ${workspace}`)
  console.log(`stage-harness: pinned ${DEPLOY_FILTER}@${pinnedVersion} (revision ${revision})`)

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

  console.log(`stage-harness: pnpm deploy ${DEPLOY_FILTER} -> ${stageDir}`)
  rmSync(stageDir, { recursive: true, force: true })
  run('pnpm', [
    '--filter', DEPLOY_FILTER, 'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    stageDir,
  ], workspace)

  const deployedManifest = join(stageDir, 'package.json')
  if (!existsSync(deployedManifest)) {
    throw new Error(`pnpm deploy produced no package.json at ${deployedManifest}`)
  }
  const deployed = JSON.parse(readFileSync(deployedManifest, 'utf8'))
  if (deployed.version !== pinnedVersion) {
    throw new Error(`deployed version ${String(deployed.version)} does not match the pinned ${pinnedVersion}`)
  }

  // The CLI package is the deploy root, so its built lib/ belongs at the top
  // level; deploy filtered it out through `files`, so copy it from the checkout.
  cpSync(join(workspace, 'apps', 'cli', 'lib'), join(stageDir, 'lib'), { recursive: true, dereference: true })
  const restored = restoreBuildArtifacts(workspace, stageDir)
  if (restored.length > 0) console.log(`stage-harness: restored build outputs: ${restored.join(', ')}`)

  materializeLinks(join(stageDir, 'node_modules'))

  // Flatten the tree so every package the product needs is reachable from the
  // closure root; see flattenClosure for why the deployed layout cannot boot.
  const flattened = flattenClosure(workspace, stageDir, deployed)
  if (flattened.length > 0) {
    console.log(`stage-harness: flattened ${String(flattened.length)} package(s) into the closure root`)
  }
  materializeLinks(join(stageDir, 'node_modules'))

  // Nothing may remain unresolvable: a missing package here would only surface
  // as a boot crash in the shipped app.
  const unresolved = listUnresolved(stageDir)
  if (unresolved.length > 0) {
    throw new Error(`staged closure is missing packages: ${unresolved.join(', ')}`)
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(dirname(outDir), { recursive: true })
  cpSync(stageDir, outDir, { recursive: true, dereference: true })

  // node-pty's macOS PTY helper must stay executable through both copies.
  const spawnHelper = join(outDir, 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  const helperPresent = existsSync(spawnHelper)
  if (helperPresent) chmodSync(spawnHelper, 0o755)

  const stagedCli = join(outDir, 'lib', 'bin.js')
  if (!existsSync(stagedCli)) throw new Error(`staged closure has no CLI entry at ${stagedCli}`)
  const stagedFrontend = join(outDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(stagedFrontend)) throw new Error(`staged closure has no web UI at ${stagedFrontend}`)

  writeFileSync(join(outDir, 'harness-meta.json'), `${JSON.stringify({
    version: deployed.version,
    revision,
    workspace,
    layout: LAYOUT,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    stagedAt: new Date().toISOString(),
  }, null, 2)}\n`)

  if (!opts.keepStage) rmSync(stageDir, { recursive: true, force: true })
  console.log(`stage-harness: ${DEPLOY_FILTER}@${String(deployed.version)} (${revision}) staged at resources/harness`)
  console.log(`stage-harness: web UI present, spawn-helper ${helperPresent ? 'present and executable' : 'ABSENT (PTY tools will fail on macOS)'}`)
}

main()
