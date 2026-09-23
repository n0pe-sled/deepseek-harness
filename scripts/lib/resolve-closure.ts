/**
 * Resolve every dependency of a staged harness closure the way Node's ESM
 * loader does, and report the ones it cannot reach.
 *
 * A staged closure is a pile of packages copied out of a pnpm store, so
 * "the package exists somewhere in the tree" proves nothing: ESM resolution
 * walks up from the importing file and stops at the first `node_modules` that
 * answers. A package hoisted to the closure root while a consumer sits deep
 * inside another package's own tree is invisible, and the failure only appears
 * as a boot crash in the shipped app. This checker runs that same walk.
 *
 * It implements the CommonJS/ESM `node_modules` lookup rather than calling
 * `import.meta.resolve`, because it must report every miss instead of throwing
 * on the first one, and because resolution must be done *as if* from the
 * importing package's directory rather than from this script's location.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Node builtin module names, for the `node:`-prefixed and bare spellings. */
const BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

/** One dependency a package declares, with where it was declared. */
interface Requirement {
  /** The bare specifier, e.g. `@deepseek-ai/cosmokit`. */
  name: string
  /** The package that declared it (for error messages). */
  declaredBy: string
  /**
   * True for a `peerDependencies` entry. A peer that is not installed anywhere
   * is optional in practice (`ws` declares `bufferutil` and `utf-8-validate`
   * that way), so it is only flagged when a copy exists but is unusable. A
   * missing `dependencies` entry is always a packaging defect.
   */
  peer: boolean
}

/** A resolved dependency: the importing package and the bare name it needs. */
export interface UnresolvedDependency extends Requirement {
  /** Directory resolution started from (the importer's own directory). */
  from: string
}

/** Read and parse one directory's package.json, or undefined when unusable. */
function readManifest(dir: string): Record<string, unknown> | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const NAME_OF = (manifest: Record<string, unknown> | undefined): string =>
  typeof manifest?.['name'] === 'string' ? (manifest['name'] as string) : '<unnamed>'

/**
 * Every package directory inside a `node_modules` tree, nested trees included.
 * A nested tree belongs to the package that owns it, so its packages are
 * visited on their own too.
 */
function eachPackage(nodeModules: string, visit: (dir: string, manifest: Record<string, unknown>) => void): void {
  if (!existsSync(nodeModules)) return
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (!scoped.isDirectory()) continue
        const dir = join(path, scoped.name)
        const manifest = readManifest(dir)
        if (manifest !== undefined) visit(dir, manifest)
      }
      continue
    }
    const manifest = readManifest(path)
    if (manifest !== undefined) visit(path, manifest)
  }
}

/** The first `node_modules` directory at or above `from` that contains `name`. */
export function resolveFrom(from: string, name: string): string | undefined {
  let current = from
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Every string target reachable in an `exports` value, skipping the
 * TypeScript-only conditions.
 *
 * Node never loads a `types` (or `typescript`) condition, and a published
 * package legitimately ships `types` pointing at a `.d.ts` that a `.ts`-source
 * package does not emit at all. Counting those targets as runtime entries made
 * this checker reject resolvable packages — `json-schema-to-ts` declares
 * `{"types": "./lib/index.d.ts", "default": "./lib/index.js"}` and its `.d.ts`
 * is absent, while the `.js` Node actually loads is present.
 */
function collectExportTargets(value: unknown, into: string[]): void {
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
 * Resolve one `main`/`exports` target to a file inside the package, or
 * undefined when it does not name a file there.
 *
 * Three conventions have to hold, because real packages use all of them:
 *   - a target is usually `./`-prefixed, but a bare relative path such as
 *     `lib/cjs/index.js` in `main` is equally valid;
 *   - `main` may be extensionless (`"index"`, `"./index"`), which CommonJS
 *     resolution completes to `.js`;
 *   - the resolved thing may be a directory holding an `index.js`.
 */
function targetFile(dir: string, target: string): string | undefined {
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

/** True when a package's declared entry resolves to an existing runtime file. */
export function entryExists(dir: string): boolean {
  const manifest = readManifest(dir)
  if (manifest === undefined) return false
  const candidates: string[] = []
  for (const field of ['main', 'module']) {
    const value = manifest[field]
    if (typeof value === 'string') candidates.push(value)
  }
  collectExportTargets(manifest['exports'], candidates)
  // A package with no declared entry is fine: Node falls back to index.js.
  if (candidates.length === 0) {
    return ['index.js', 'index.cjs', 'index.mjs'].some((index) => existsSync(join(dir, index)))
  }
  return candidates.some((c) => targetFile(dir, c) !== undefined)
}

/**
 * True for packages that exist only to carry types: `@types/*` and packages
 * whose entire content is `.d.ts` files (`undici-types`, a dependency of
 * `@types/node`). They have no runtime entry by design, and no shipped code
 * imports them at run time.
 */
function isTypesPackage(name: string, dir: string | undefined): boolean {
  if (name.startsWith('@types/')) return true
  if (dir === undefined) return false
  const manifest = readManifest(dir)
  const hasRuntimeEntry = ['main', 'module', 'exports'].some((field) => manifest?.[field] !== undefined)
  if (hasRuntimeEntry) return false
  return existsSync(join(dir, 'index.d.ts'))
}

/**
 * Check that every runtime dependency in a staged closure resolves from its
 * own package directory. Returns the misses for a staging step to fail on.
 *
 * `dependencies` **and** `peerDependencies` are consulted. Peers matter because
 * a package can import one at load time while declaring it only as a peer, and
 * the deploy flag `--config.auto-install-peers=false` leaves those out of the
 * hoisted tree: staging passed an dependencies-only audit while the closure
 * still failed to boot on `@deepseek-ai/cordis-plugin-group`, which
 * `@deepseek-ai/dsh-app-boot` imports but declares only as a peer.
 *
 * `devDependencies` and `optionalDependencies` are not required. A dev-only
 * import is a genuine packaging bug, but reporting it here would flag every
 * package that ships tests in its tarball, which is noise rather than signal.
 */
export function findUnresolvedDependencies(root: string): UnresolvedDependency[] {
  const nodeModules = join(root, 'node_modules')
  // A name may exist as several copies (a hoisted one at the closure root plus
  // peer-specialized ones nested in consumers). A requirement is satisfied when
  // *any* copy of the declaring package can resolve it, so copies are grouped
  // rather than collapsed to the shallowest — collapsing produced a false miss
  // that then made the staging completion step copy `cordis` into its own
  // nested tree forever.
  const copies = new Map<string, { dir: string; manifest: Record<string, unknown> }[]>()
  eachPackage(nodeModules, (dir, manifest) => {
    const name = NAME_OF(manifest)
    const list = copies.get(name)
    if (list === undefined) copies.set(name, [{ dir, manifest }])
    else list.push({ dir, manifest })
  })

  const unresolved: UnresolvedDependency[] = []
  for (const [declaredBy, entries] of copies) {
    for (const { dir, manifest } of entries) {
      const requirements: Requirement[] = []
      for (const [field, peer] of [['dependencies', false], ['peerDependencies', true]] as const) {
        const declared = manifest[field]
        if (typeof declared !== 'object' || declared === null) continue
        for (const name of Object.keys(declared)) requirements.push({ name, declaredBy, peer })
      }
      for (const requirement of requirements) {
        const bare = requirement.name.startsWith('node:') ? requirement.name.slice(5) : requirement.name
        if (BUILTINS.has(bare)) continue
        if (resolvesFromAnyCopy(copies, declaredBy, requirement.name)) continue
        // An uninstalled optional peer is not a packaging defect; a missing
        // real dependency always is.
        if (requirement.peer && !isInstalled(copies, requirement.name)) continue
        unresolved.push({ name: requirement.name, declaredBy, from: dir })
      }
    }
  }
  return unresolved
}

/** True when a package of this name exists anywhere in the closure. */
function isInstalled(
  copies: Map<string, { dir: string; manifest: Record<string, unknown> }[]>,
  name: string,
): boolean {
  return copies.has(name)
}

/**
 * True when at least one copy of `declaredBy` can resolve `dependency` — the
 * question Node itself answers, since each copy of a package resolves imports
 * from its own location.
 */
function resolvesFromAnyCopy(
  copies: Map<string, { dir: string; manifest: Record<string, unknown> }[]>,
  declaredBy: string,
  dependency: string,
): boolean {
  const entries = copies.get(declaredBy)
  if (entries === undefined) return false
  for (const { dir } of entries) {
    if (resolvesFrom(dir, dependency)) return true
  }
  return false
}

/** True when `dependency` resolves from `dir` to a package with a runtime entry. */
function resolvesFrom(dir: string, dependency: string): boolean {
  const target = resolveFrom(dir, dependency)
  if (target === undefined) return isTypesPackage(dependency, undefined)
  return entryExists(target) || isTypesPackage(dependency, target)
}

/** Human-readable one-line summary of an unresolved dependency. */
export function describeUnresolved(entries: readonly UnresolvedDependency[]): string {
  return entries
    .map((e) => `${e.name} (needed by ${e.declaredBy}, from ${e.from})`)
    .join('; ')
}
