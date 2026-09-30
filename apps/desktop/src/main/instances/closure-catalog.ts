/**
 * Which staged harness closures this build carries.
 *
 * A closure is only portable within one platform/arch/libc triple, so a build
 * ships one directory per target and picks by the remote's triple. Discovery is
 * by scanning for the staging script's metadata record rather than by a fixed
 * path list, because the set of shipped targets is exactly the set the staging
 * step produced, and a list that has to be kept in sync is a list that will
 * drift.
 *
 * Nothing here reaches a package registry. The only way a closure exists is
 * that `scripts/stage-harness.mjs` produced it from the fork checkout.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatTarget, harnessCacheKey, parseTarget } from '../../shared/harness-target.ts'
import type { StageTarget } from '../../shared/harness-target.ts'

/** Directory under `Resources` holding the closure this machine runs. */
export const BUNDLED_DIR_NAME = 'harness'
/** The CLI entry inside a staged closure. */
export const BUNDLED_CLI_RELATIVE = join('lib', 'bin.js')
/** Version record written by scripts/stage-harness.mjs. */
export const BUNDLED_META_RELATIVE = 'harness-meta.json'

/** Version record describing a staged closure. */
export interface HarnessMeta {
  /** The pinned `@deepseek-ai/dsh` version this closure was staged from. */
  version?: string
  /** Short git revision of the harness checkout it came from. */
  revision?: string
  /** The harness workspace path it was staged from. */
  workspace?: string
  /** Staged layout revision; a newer value means the tree shape changed. */
  layout?: number
  /** The platform the closure's native addons were built for. */
  platform?: string
  /** The architecture the closure's native addons were built for. */
  arch?: string
  /** The libc the closure's native addons link against (linux targets). */
  libc?: string
  /** Node version of the machine that ran the staging, not a requirement. */
  node?: string
  /** Version of the executable shipped at bin/node. */
  runtimeVersion?: string
  /** Where the closure came from; retained for older records. */
  source?: string
  /** ISO timestamp of the staging run. */
  stagedAt?: string
}

/** One staged closure found on disk. */
export interface ClosureEntry {
  /** `<version>-<revision>-<target>`; the identity a remote caches under. */
  key: string
  root: string
  cli: string
  meta: HarnessMeta
  /** Parsed target, or undefined when the record does not name a usable one. */
  target?: StageTarget
}

/** Read a closure's metadata record, or undefined when absent or unreadable. */
export function readHarnessMeta(root: string): HarnessMeta | undefined {
  const file = join(root, BUNDLED_META_RELATIVE)
  if (!existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as HarnessMeta
  } catch {
    // A malformed record is informational only; never block a boot over it.
    return undefined
  }
}

/** The target a closure record was built for, when it names one. */
export function metaTarget(meta: HarnessMeta): StageTarget | undefined {
  if (typeof meta.platform !== 'string' || typeof meta.arch !== 'string') return undefined
  const parts = [meta.platform, meta.arch]
  if (meta.platform === 'linux' && typeof meta.libc === 'string') parts.push(meta.libc)
  try {
    return parseTarget(parts.join('-'))
  } catch {
    return undefined
  }
}

/**
 * Every staged closure below a resources directory.
 *
 * A directory counts only if it has both the CLI entry and a metadata record
 * naming a version, revision, and target: a directory missing any of those
 * cannot be selected, cached, or reported, so treating it as a closure would
 * only move the failure later.
 */
export function findClosures(resourcesDir: string): ClosureEntry[] {
  if (!existsSync(resourcesDir)) return []
  const entries: ClosureEntry[] = []
  for (const name of readdirSync(resourcesDir)) {
    if (!name.startsWith(BUNDLED_DIR_NAME)) continue
    const root = join(resourcesDir, name)
    if (!statSync(root).isDirectory()) continue
    const cli = join(root, BUNDLED_CLI_RELATIVE)
    if (!existsSync(cli)) continue
    const meta = readHarnessMeta(root)
    if (meta?.version === undefined || meta.revision === undefined) continue
    const target = metaTarget(meta)
    if (target === undefined) continue
    entries.push({ key: harnessCacheKey(meta.version, meta.revision, target, meta.runtimeVersion), root, cli, meta, target })
  }
  return entries
}

/** A closure selection failure that names what was wanted and what exists. */
export class ClosureNotFoundError extends Error {
  readonly available: readonly string[]

  constructor(message: string, available: readonly string[]) {
    super(message)
    this.name = 'ClosureNotFoundError'
    this.available = available
  }
}

/**
 * Pick the closure to ship to a remote target.
 *
 * Prefers the exact cache key (version, revision, and target all match, so the
 * remote's cache entry is reusable), then any closure for the same target. The
 * fallback matters because the remote caches by the closure it was sent, not by
 * what this build happens to contain, so a revision difference is a cache miss
 * rather than an incompatibility — and a revision difference is exactly what a
 * developer has between restages.
 *
 * A miss throws with the available keys listed. There is deliberately no
 * fallback to installing anything: the only correct artifact is one this build
 * staged from the fork.
 */
export function selectClosure(
  entries: readonly ClosureEntry[],
  wanted: { key: string; target: StageTarget },
): ClosureEntry {
  const exact = entries.find((entry) => entry.key === wanted.key)
  if (exact !== undefined) return exact
  const sameTarget = entries.filter((entry) => entry.target !== undefined
    && formatTarget(entry.target) === formatTarget(wanted.target))
  const only = sameTarget[0]
  if (sameTarget.length === 1 && only !== undefined) return only
  if (sameTarget.length > 1) {
    // Several revisions for one target: newest staging wins, which is the one a
    // developer just produced.
    const newest = [...sameTarget].sort((a, b) => (b.meta.stagedAt ?? '').localeCompare(a.meta.stagedAt ?? ''))[0]
    if (newest !== undefined) return newest
  }
  const available = entries.map((entry) => entry.key)
  throw new ClosureNotFoundError(
    `no staged harness for ${formatTarget(wanted.target)} (wanted ${wanted.key}). `
    + `Stage one with: node scripts/stage-harness.mjs --target ${formatTarget(wanted.target)} --out resources/harness-${formatTarget(wanted.target)}`,
    available,
  )
}
