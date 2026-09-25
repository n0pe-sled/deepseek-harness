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
  const opts = { harness: undefined, app: undefined, out: join(repoRoot, 'build') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--harness') opts.harness = argv[++i]
    else if (argv[i] === '--app') opts.app = argv[++i]
    else if (argv[i] === '--out') opts.out = argv[++i]
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
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// --- 1. Stage one harness closure per image architecture --------------------
// Directory names match buildx TARGETARCH so the Containerfile can COPY by it.
const TARGETS = [
  { arch: 'amd64', triple: 'linux-x64-glibc' },
  { arch: 'arm64', triple: 'linux-arm64-glibc' },
]
for (const { arch, triple } of TARGETS) {
  run('node', [join(app, 'scripts', 'stage-harness.mjs'), '--workspace', harness, '--target', triple, '--out', join(out, `closure-${arch}`)])
}

// --- 2. Copy plugin sources out of the harness tree and build them ----------
const pluginsDir = join(harness, 'plugins')
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name)
  .filter((name) => existsSync(join(pluginsDir, name, 'package.json')) && existsSync(join(pluginsDir, name, 'cordis.patch.yml')))
if (plugins.length === 0) throw new Error(`no plugin packages found under ${pluginsDir}`)

const copyFilter = (src) => {
  const base = basename(src)
  return base !== 'node_modules' && base !== 'lib'
}
mkdirSync(join(out, 'plugins-src'), { recursive: true })
for (const name of plugins) {
  cpSync(join(pluginsDir, name), join(out, 'plugins-src', name), { recursive: true, filter: copyFilter })
  const dir = join(out, 'plugins-src', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const frozen = existsSync(join(dir, 'pnpm-lock.yaml'))
  run('pnpm', ['install', ...(frozen ? ['--frozen-lockfile'] : [])], { cwd: dir })
  if (pkg.scripts?.build !== undefined) run('pnpm', ['build'], { cwd: dir })
}

// --- 3. Seed the durable home: install every plugin into the sandbox profile
const seedHome = join(out, 'seed-home')
mkdirSync(join(seedHome, 'profiles'), { recursive: true })
const cli = join(out, 'closure-amd64', 'lib', 'bin.js')
for (const name of plugins) {
  run('node', [cli, 'plugin', '--profile', 'sandbox', 'add', join(out, 'plugins-src', name)], {
    env: { ...process.env, DSH_HOME: seedHome },
  })
}
// The profile's manifest is the profile dir's own package.json, whose
// `dsh.profile.bundles` lists the installed bundle names in layer order.
const profilePkg = JSON.parse(readFileSync(join(seedHome, 'profiles', 'sandbox', 'package.json'), 'utf8'))
const bundleCount = (profilePkg.dsh?.profile?.bundles ?? []).length
if (bundleCount === 0) throw new Error('the sandbox profile seeded with no bundles — plugin install failed silently')
console.log(`sandbox profile seeded with ${String(bundleCount)} bundles`)

// --- 4. Record the closure identity for image tags --------------------------
const meta = JSON.parse(readFileSync(join(out, 'closure-amd64', 'harness-meta.json'), 'utf8'))
writeFileSync(join(out, 'meta.json'), `${JSON.stringify({ version: meta.version, revision: meta.revision }, null, 2)}\n`)
console.log(`context ready in ${out}: ${plugins.length} plugins, harness ${meta.version} (${meta.revision})`)
