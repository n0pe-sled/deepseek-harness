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
 *   meta.json         release, harness, and plugin revisions for image tags
 *
 * Closure staging is delegated to the desktop app's scripts/stage-harness.mjs,
 * which already knows how to produce a target-clean Linux closure (its
 * foreign-target path stages from a scratch git worktree, so the harness
 * checkout itself is only read).
 *
 * Usage:
 *   node scripts/prepare-context.mjs [--harness <dir>] [--app <dir>] [--out <dir>]
 *
 * This directory is deploy/sandbox-image inside the harness repository, so both
 * defaults are reached by walking out of it: the harness root two levels up, and
 * the app two levels up and back down into apps/desktop. Pass --harness and
 * --app to build from separate checkouts instead.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeExclusions, discoverPlugins, partitionPlugins } from '../../../scripts/plugin-roster.mjs'
import { copyRuntimeDependencies } from './runtime-dependencies.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The plugin packages this image ships, from both plugin trees.
 *
 * The harness repository's `plugins/` tree is the fork's own, and the `plugins/`
 * beside this script holds the plugins only the image needs; both survive the move
 * into the harness repository, because the fork's plugins stay at
 * `<harness>/plugins` and this directory sits below them.
 *
 * The roster module owns the discovery rule and the exclusion set, so this image
 * refuses exactly what every other shipping path refuses. An excluded plugin
 * directory that is present is reported rather than skipped silently.
 *
 * @param harness - the harness checkout root.
 * @param options - `sandboxRoot` names the checkout holding this script, so a
 * caller can read another one.
 * @returns the plugin entries the image installs, in discovery order.
 */
export function discoverContextPlugins(harness, options = {}) {
  const sandboxRoot = options.sandboxRoot ?? repoRoot
  const discovered = discoverPlugins(harness, {
    roots: [join(harness, 'plugins'), join(sandboxRoot, 'plugins')],
  })
  const { shipped, excluded } = partitionPlugins(discovered)
  if (excluded.length > 0) console.warn(`! ${describeExclusions(excluded)}`)
  if (shipped.length === 0) throw new Error(`no plugin packages found under ${join(harness, 'plugins')}`)
  return shipped
}

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

/** A default that counts only when the directory holds the probe file. */
function resolveDefault(candidate, probe) {
  const dir = resolve(candidate)
  return existsSync(join(dir, ...probe)) ? dir : undefined
}

/** Prepare the image build context: stage both closures, build every plugin, seed a home, record the identity. */
async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const harness = resolve(
    opts.harness ?? resolveDefault(join(repoRoot, '..', '..'), ['apps', 'cli', 'package.json']) ?? '',
  )
  // The app repository moved into the harness repository, so the default app is
  // nested inside whichever harness root was resolved above rather than beside this
  // directory. --app still overrides it for a standalone app checkout.
  const app = resolve(
    opts.app ?? resolveDefault(join(harness, 'apps', 'desktop'), ['scripts', 'stage-harness.mjs']) ?? '',
  )
  if (!existsSync(join(harness, 'pnpm-workspace.yaml'))) {
    throw new Error(`no harness workspace at ${harness}; pass --harness /path/to/deepseek-harness`)
  }
  if (!existsSync(join(app, 'scripts', 'stage-harness.mjs'))) {
    throw new Error(`no desktop app checkout at ${app}; pass --app /path/to/deepseek-harness/apps/desktop`)
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
    if (!existsSync(lockfile)) throw new Error('Harness lockfile is required')
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: harness })
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
  // The sources are copied out and built here rather than built in place, because
  // other work may be in flight in the harness checkout.
  const plugins = discoverContextPlugins(harness, { sandboxRoot: repoRoot })

  const copyFilter = (src) => {
    const base = basename(src)
    return base !== 'node_modules' && base !== 'lib' && base !== '.git'
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
  async function repointDanglingLinks(dir, harnessRoot, name) {
    const { load, dump } = await import('js-yaml')
    const lockPath = join(dir, 'pnpm-lock.yaml')
    if (!existsSync(lockPath)) throw new Error(`Plugin lockfile is required: ${name}`)
    const lock = load(readFileSync(lockPath, 'utf8'))
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
        const locked = lock.importers?.['.']?.[section]?.[dep]
        if (!locked || locked.specifier !== spec || locked.version !== spec) {
          throw new Error(`Unpinned local dependency ${name}: ${dep}`)
        }
        deps[dep] = `link:${found}`
        locked.specifier = deps[dep]
        locked.version = deps[dep]
        changed = true
        console.log(`  ${name}: repointed ${dep} -> ${found}`)
      }
    }
    if (changed) {
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
      writeFileSync(lockPath, dump(lock, { lineWidth: -1, noRefs: true }))
    }
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
    await repointDanglingLinks(target, harness, name)
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: target })
    if (pkg.scripts?.build === undefined) {
      built.push(name)
      continue
    }
    try {
      run('pnpm', ['build'], { cwd: target })
      built.push(name)
    } catch (error) {
      if (strict) throw error
      // A plugin mid-edit can fail a build-time typecheck after its bundles were
      // already emitted. Judge by artifacts, not by exit code: with lib/index.js
      // present the plugin is shippable, and refusing the whole image over
      // somebody's in-flight typecheck helps nobody. Anything without artifacts
      // is excluded loudly rather than shipped broken.
      if (existsSync(join(target, 'lib', 'index.js'))) {
        console.warn(`! ${name}: build reported failure but lib/index.js exists — shipping produced artifacts`)
        warned.push(name)
        built.push(name)
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

  // Ship only the locked portable runtime dependencies. Native peers resolve from each harness closure.
  for (const name of built) {
    const target = join(out, 'plugins-src', name)
    const runtime = join(out, `runtime-${name}`)
    mkdirSync(runtime, { recursive: true })
    copyRuntimeDependencies(target, runtime)
    rmSync(join(target, 'node_modules'), { recursive: true, force: true })
    cpSync(runtime, join(target, 'node_modules'), { recursive: true })
    rmSync(runtime, { recursive: true, force: true })
  }

  // --- 4. Record the closure identity for image tags --------------------------
  const meta = JSON.parse(readFileSync(join(out, 'closure-amd64', 'harness-meta.json'), 'utf8'))
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify({
    version: meta.version,
    releaseVersion: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harness, encoding: 'utf8' }).trim(),
    pluginRevisions: Object.fromEntries(plugins.map(({ dir, name }) => [name,
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
    ])),
    plugins: built,
    ...(warned.length > 0 ? { pluginsWithBuildWarnings: warned } : {}),
    ...(skipped.length > 0 ? { pluginsExcluded: skipped } : {}),
  }, null, 2)}\n`)
  console.log(`context ready in ${out}: ${String(built.length)}/${String(plugins.length)} plugins installed, harness ${meta.version} (${meta.revision})`)
  if (skipped.length > 0) {
    console.warn(`!! ${String(skipped.length)} plugin(s) are NOT in this image: ${skipped.join(', ')}`)
  }
}

// A test imports the discovery above; only a real run prepares a context.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
