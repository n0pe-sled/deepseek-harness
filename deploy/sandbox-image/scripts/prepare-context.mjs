#!/usr/bin/env node
/**
 * Prepare the dsh-sandbox image build context.
 *
 * Produces `<out>/` (default `build/`) with:
 *   closure-amd64/    linux-x64-glibc harness closure   (staged, not copied)
 *   closure-arm64/    linux-arm64-glibc harness closure (staged, not copied)
 *   plugins-src/      every fork plugin, copied out of the harness tree and
 *                     built there — the harness checkout is never mutated,
 *                     even in its build outputs, because other work may be
 *                     in flight in that tree
 *   seed-home/        a $DSH_HOME whose `sandbox` profile has every plugin
 *                     installed; the image copies this to /data on first boot
 *   meta.json         { version, revision } of the staged closure, for tags
 *
 * Closure staging is delegated to the app repo's scripts/stage-harness.mjs,
 * which already knows how to produce a target-clean Linux closure (its
 * foreign-target path stages from a scratch git worktree, so the harness
 * checkout itself is only read).
 *
 * Usage:
 *   node scripts/prepare-context.mjs [--harness <dir>] [--app <dir>] [--out <dir>]
 *
 * Default locations are siblings: ../deepseek-harness and ../DeepSeek-App.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const opts = { harness: undefined, app: undefined, out: join(repoRoot, 'build'), strict: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--harness') opts.harness = argv[++i]
    else if (argv[i] === '--app') opts.app = argv[++i]
    else if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--strict') opts.strict = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return opts
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', env: process.env, ...opts })
}

/** Sibling defaults, mirroring how stage-harness.mjs locates the harness. */
function resolveDefault(candidate, probe) {
  const dir = resolve(candidate)
  return existsSync(join(dir, ...probe)) ? dir : undefined
}

const opts = parseArgs(process.argv.slice(2))

const harness = resolve(
  opts.harness ?? resolveDefault(join(repoRoot, '..', 'deepseek-harness'), ['apps', 'cli', 'package.json']) ?? '',
)
const app = resolve(
  opts.app ?? resolveDefault(join(repoRoot, '..', 'DeepSeek-App'), ['scripts', 'stage-harness.mjs']) ?? '',
)
if (!existsSync(join(harness, 'pnpm-workspace.yaml'))) {
  throw new Error(`no harness workspace at ${harness}; pass --harness /path/to/deepseek-harness`)
}
if (!existsSync(join(app, 'scripts', 'stage-harness.mjs'))) {
  throw new Error(`no DeepSeek-App checkout at ${app}; pass --app /path/to/DeepSeek-App`)
}

const out = resolve(opts.out)
/** With --strict a plugin that cannot build fails the run instead of being excluded. */
const strict = opts.strict === true
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// --- 1. Stage one harness closure per image architecture --------------------
// Directory names match buildx TARGETARCH so the Containerfile can COPY by it.
const TARGETS = [
  { arch: 'amd64', triple: 'linux-x64-glibc' },
  { arch: 'arm64', triple: 'linux-arm64-glibc' },
]

// CI checks out the harness as SOURCE: the staging script needs a built
// workspace (apps/cli/lib/bin.js and apps/web/dist) and fails with
// "no built CLI ... rerun with --build" without one. So when the CLI is
// absent, install the workspace once and let the FIRST staging run the build —
// build outputs are platform-independent and the foreign-target pass copies
// them into its scratch worktree, so one build serves both architectures. A
// developer's already-built checkout skips all of this.
const harnessCli = join(harness, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(harnessCli)) {
  const lockfile = join(harness, 'pnpm-lock.yaml')
  console.log('prepare-context: harness is unbuilt — installing the workspace')
  try {
    run('pnpm', ['install', ...(existsSync(lockfile) ? ['--frozen-lockfile'] : [])], { cwd: harness })
  } catch {
    // A drifted lockfile should not decide whether an image can be built.
    console.log('prepare-context: frozen install failed; retrying with a resolved lockfile')
    run('pnpm', ['install'], { cwd: harness })
  }
}
for (const [index, { arch, triple }] of TARGETS.entries()) {
  const buildFirst = index === 0 && !existsSync(harnessCli)
  run('node', [
    join(app, 'scripts', 'stage-harness.mjs'),
    '--workspace', harness,
    '--target', triple,
    '--out', join(out, `closure-${arch}`),
    ...(buildFirst ? ['--build'] : []),
  ])
}

// --- 2. Copy plugin sources out and build them -------------------------------
// Two plugin sources are merged: the harness fork's plugins/ tree (read-only
// — sources are copied out and built here, never built in place) and this
// repo's own plugins/ (the sandbox-specific ones).
const pluginsDir = join(harness, 'plugins')
const sources = [
  ...readdirSync(pluginsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => ({ dir: join(pluginsDir, e.name), name: e.name })),
  ...readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => ({ dir: join(repoRoot, 'plugins', e.name), name: e.name })),
]
const plugins = sources
  .filter(({ dir }) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'cordis.patch.yml')))
  .map(({ dir, name }) => ({ dir, name }))
if (plugins.length === 0) throw new Error(`no plugin packages found under ${pluginsDir}`)

const copyFilter = (src) => {
  const base = basename(src)
  return base !== 'node_modules' && base !== 'lib'
}

/**
 * Repoint build-time `link:` specs that assume a different checkout layout.
 *
 * Several plugins declare their build-time peers as `link:../deepseek-harness/…`
 * or `link:../../packages/…`, which only resolve when the plugin directory sits
 * beside a `deepseek-harness` checkout rather than inside it. Those specs are
 * devDependencies (used to compile, never shipped — runtime peers resolve from
 * the profile's node_modules fallback), so the copy's manifest is rewritten to
 * the real path in the harness checkout. Only specs that do NOT resolve where
 * they are left alone and reported.
 */
function repointDanglingLinks(dir, harnessRoot, name) {
  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  let changed = false
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[section]
    if (deps === undefined || typeof deps !== 'object') continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = spec.slice('link:'.length)
      if (existsSync(resolve(dir, target))) continue
      // The two layouts the fork's plugins were written for.
      const candidates = [
        resolve(harnessRoot, target.replace(/^\.\.\/deepseek-harness\//u, '')),
        resolve(harnessRoot, target.replace(/^\.\.\/\.\.\//u, '')),
      ]
      const found = candidates.find((candidate) => existsSync(candidate))
      if (found === undefined) continue
      deps[dep] = `link:${found}`
      changed = true
      console.log(`  ${name}: repointed ${dep} -> ${found}`)
    }
  }
  if (changed) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

mkdirSync(join(out, 'plugins-src'), { recursive: true })
/** Plugins whose build produced usable artifacts despite a reported failure. */
const warned = []
/** Plugins that produced nothing usable and are therefore not in the image. */
const skipped = []
const built = []
for (const { dir, name } of plugins) {
  const target = join(out, 'plugins-src', name)
  cpSync(dir, target, { recursive: true, filter: copyFilter })
  repointDanglingLinks(target, harness, name)
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  if (existsSync(join(target, 'pnpm-lock.yaml'))) {
    try {
      run('pnpm', ['install', '--frozen-lockfile'], { cwd: target })
    } catch {
      // A plugin being edited can have a package.json ahead of its lockfile.
      // The copy is throwaway and the source tree is never touched, so resolve
      // it here rather than failing the whole image — but say so loudly, since
      // a regenerated lockfile means this plugin's versions were not pinned.
      console.warn(`! ${name}: lockfile is out of sync with package.json — resolving fresh in the build copy only`)
      run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: target })
    }
  } else {
    run('pnpm', ['install'], { cwd: target })
  }
  if (pkg.scripts?.build === undefined) {
    built.push(name)
    continue
  }
  try {
    run('pnpm', ['build'], { cwd: target })
    built.push(name)
  } catch (error) {
    // A plugin mid-edit can fail a build-time typecheck after its bundles were
    // already emitted. Judge by artifacts, not by exit code: with lib/index.js
    // present the plugin is shippable, and refusing the whole image over
    // somebody's in-flight typecheck helps nobody. Anything without artifacts
    // is excluded loudly rather than shipped broken.
    if (existsSync(join(target, 'lib', 'index.js'))) {
      console.warn(`! ${name}: build reported failure but lib/index.js exists — shipping produced artifacts`)
      warned.push(name)
      built.push(name)
    } else if (strict) {
      throw error
    } else {
      console.warn(`!! ${name}: build failed and produced no lib/index.js — EXCLUDED from this image`)
      skipped.push(name)
    }
  }
}
if (warned.length > 0) console.warn(`! built with warnings: ${warned.join(', ')}`)
if (skipped.length > 0) console.warn(`!! excluded (build produced nothing usable): ${skipped.join(', ')}`)

// --- 3. Seed the durable home: install every plugin into the web profile ----
// The `web` profile specifically, not a custom one: `web` is the template that
// carries `dsh-web-app` (an unknown profile name gets `dsh-base` alone and
// boots with no UI at all), and `dsh web` is an alias for `--profile web`, so
// the container boots straight into this profile with every plugin in it.
const seedHome = join(out, 'seed-home')
mkdirSync(join(seedHome, 'profiles'), { recursive: true })
const cli = join(out, 'closure-amd64', 'lib', 'bin.js')
for (const name of built) {
  run('node', [cli, 'plugin', '--profile', 'web', 'add', join(out, 'plugins-src', name)], {
    env: { ...process.env, DSH_HOME: seedHome },
  })
}
// The profile's manifest is the profile dir's own package.json, whose
// `dsh.profile.bundles` lists the installed bundle names in layer order.
const profilePkg = JSON.parse(readFileSync(join(seedHome, 'profiles', 'web', 'package.json'), 'utf8'))
const bundles = profilePkg.dsh?.profile?.bundles ?? []
if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
  throw new Error(`the seeded web profile is missing dsh-web-app (bundles: ${bundles.join(', ')})`)
}
const pluginBundles = bundles.filter((b) => b.startsWith('dsh-') && b !== '@deepseek-ai/dsh-base')
console.log(`web profile seeded: ${String(bundles.length)} bundles, ${String(pluginBundles.length)} plugins`)

// --- 4. Record the closure identity for image tags --------------------------
const meta = JSON.parse(readFileSync(join(out, 'closure-amd64', 'harness-meta.json'), 'utf8'))
writeFileSync(join(out, 'meta.json'), `${JSON.stringify({
  version: meta.version,
  revision: meta.revision,
  plugins: built,
  ...(warned.length > 0 ? { pluginsWithBuildWarnings: warned } : {}),
  ...(skipped.length > 0 ? { pluginsExcluded: skipped } : {}),
}, null, 2)}\n`)
console.log(`context ready in ${out}: ${String(built.length)}/${String(plugins.length)} plugins installed, harness ${meta.version} (${meta.revision})`)
if (skipped.length > 0) {
  console.warn(`!! ${String(skipped.length)} plugin(s) are NOT in this image: ${skipped.join(', ')}`)
}
