/**
 * Seed a harness home from the closure this script sits in.
 *
 * A packaged app carries its fork's plugins and skills inside the staged closure,
 * but a profile resolves a bundle by name and the skill provider scans a directory:
 * nothing is loaded until the home names them. This script is the one implementation
 * of that seeding, and it is shipped inside every closure so the same code seeds a
 * local home and a remote one. The app imports {@link seedHome} directly; a
 * provisioned remote runs this file on the far side, where the app has no process.
 *
 * Two rules decide whether a file may be written, and both exist to leave a home a
 * person owns alone:
 *
 *   1. The profile manifest is seeded only when it is absent, or when its bundle
 *      list is EXACTLY the shipped default. A list a person edited is never
 *      rewritten, because the edit is the record of what they chose.
 *   2. A skill entry is placed only where nothing is, or where a broken symlink
 *      from an earlier seed is. A real file or directory is somebody's.
 *
 * Nothing else under the home is read or written: not `settings.yaml`, not
 * `credentials`, not a session, and not the profile's own patch layer.
 *
 * Usage (run by the closure's bundled Node runtime):
 *   node seed-home.mjs <home> [profile]
 *
 * @module apps/desktop/scripts/seed-home
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Version record `scripts/stage-harness.mjs` writes into every closure. */
export const HARNESS_META_FILENAME = 'harness-meta.json'

/** Directory inside a closure holding the fork's skills, one entry per skill. */
export const CLOSURE_SKILLS_DIR = 'skills'

/** Version record whose bundle list counts as the shipped one. */
export const STOCK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
/**
 * The closure root when this file sits in one.
 *
 * `process.argv[1]` names the script Node was asked to run, so the module's own
 * directory is what answers. That is the same directory whether the app imports the
 * module or a remote runs it, so one answer serves both callers.
 * @returns the absolute closure root.
 */
export function defaultClosureRoot() {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * The closure's version record, or undefined when the root holds none.
 * @param closureRoot - the closure root from {@link defaultClosureRoot}.
 * @returns the parsed record, or undefined when absent or unreadable.
 */
export function readHarnessMeta(closureRoot) {
  const path = join(closureRoot, HARNESS_META_FILENAME)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    // A malformed record means "no roster", which is the same as an unseeded
    // closure: the profile keeps whatever it already had.
    return undefined
  }
}

/**
 * The bundle list one home's profile should carry.
 *
 * The shipped list is `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, then
 * the shipped plugin bundle names in closure order, which is the order the layers
 * are applied in.
 * @param meta - the record from {@link readHarnessMeta}.
 * @returns the shipped bundle list.
 */
export function shippedBundles(meta) {
  const plugins = Array.isArray(meta?.plugins) ? meta.plugins.filter((name) => typeof name === 'string') : []
  return [...STOCK_BUNDLES, ...plugins]
}

/** Return whether two bundle lists have the same values in the same order. */
function sameBundles(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Seed one home's web profile from the shipped bundle list.
 *
 * The write is a temp-then-rename in the profile directory, which publishes the
 * new manifest in one step. That is what the archive operation needs for the same
 * reason: a socket waiting on the file. A read-modify-write cycle is safe here
 * without a lock because only a manifest that still lists exactly the shipped
 * default is replaced, so two seeds of the same closure write the same bytes.
 *
 * @param home - the harness home to seed.
 * @param bundles - the shipped bundle list from {@link shippedBundles}.
 * @returns whether the manifest was written.
 */
export function seedProfileManifest(home, bundles) {
  const dir = join(home, 'profiles', 'web')
  const path = join(dir, 'package.json')
  let current
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // An unreadable manifest is a person's file until proven shipped, and
      // there is nothing to compare a shipped default against.
      return false
    }
  }
  const existing = current?.dsh?.profile?.bundles
  const existingList = Array.isArray(existing) ? existing : []
  if (current !== undefined && !sameBundles(existingList, STOCK_BUNDLES)) return false
  const manifest = {
    ...(current ?? {}),
    name: typeof current?.name === 'string' ? current.name : `dsh-profile-${basename(dir)}`,
    private: true,
    // No dependencies: the closure carries every bundle, so the installation
    // anchor resolves all of them and no package manager runs on this machine.
    dependencies: current?.dependencies ?? {},
    dsh: {
      ...(current?.dsh ?? {}),
      profile: { ...(current?.dsh?.profile ?? {}), bundles: [...bundles] },
    },
  }
  mkdirSync(dir, { recursive: true })
  const temp = `${path}.seed-${String(process.pid)}`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`)
  renameSync(temp, path)
  return true
}

/**
 * Whether a skill entry may be replaced: absent, or a symlink whose target is gone.
 *
 * A live symlink is `dsh-manage`'s own link into a dev checkout, and a real
 * file or directory is a person's skill. Both are left alone.
 * @param path - the home skill-root entry.
 * @returns whether nothing would be lost by writing there.
 */
export function skillEntryReplaceable(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return true
  }
  if (!stat.isSymbolicLink()) return false
  try {
    return !existsSync(resolve(dirname(path), readlinkSync(path)))
  } catch {
    // An unreadable link has no target to keep, so it is replaced.
    return true
  }
}

/**
 * Seed the shipped skills into one home's skill root.
 *
 * Each skill's own directory is copied whole, so the skill's supporting files
 * travel with it, and each is named by its frontmatter `name`, which is the entry
 * name the skill-filesystem provider scans.
 *
 * @param home - the harness home to seed.
 * @param closureRoot - the closure root holding `skills/`.
 * @param skills - the shipped skill names from the closure's version record.
 * @returns the skill names that were written.
 */
export function seedSkills(home, closureRoot, skills) {
  const target = join(home, 'skills')
  const written = []
  for (const name of skills) {
    const from = join(closureRoot, CLOSURE_SKILLS_DIR, name)
    if (!existsSync(from)) continue
    const dest = join(target, name)
    if (!skillEntryReplaceable(dest)) continue
    // A replaced entry is a dangling symlink, which `existsSync` does not see:
    // it follows the link, so the removal is driven by the link's own status.
    if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) rmSync(dest, { force: true })
    mkdirSync(target, { recursive: true })
    cpSync(from, dest, { recursive: true, dereference: true })
    written.push(name)
  }
  return written
}

/**
 * Seed one home from one closure.
 *
 * Every path written is decided by {@link seedProfileManifest} and
 * {@link seedSkills}, so a home whose profile list a person edited keeps it and a
 * skill a person wrote is never replaced.
 *
 * @param home - the harness home to seed.
 * @param closureRoot - the closure root holding the version record and skills.
 * @returns what the seed wrote and skipped.
 */
export function seedHome(home, closureRoot) {
  const meta = readHarnessMeta(closureRoot)
  const bundles = shippedBundles(meta)
  const skills = Array.isArray(meta?.skills) ? meta.skills.filter((name) => typeof name === 'string') : []
  const manifestWritten = bundles.length > STOCK_BUNDLES.length
    ? seedProfileManifest(home, bundles)
    : false
  return {
    profile: join(home, 'profiles', 'web'),
    manifestWritten,
    skills: seedSkills(home, closureRoot, skills),
  }
}

/**
 * Seed one home from the closure this script sits in.
 * @param argv - arguments after the script path: `<home>` and optionally the closure root.
 * @returns the process exit code.
 */
export function runCli(argv) {
  const home = argv[0]
  if (home === undefined || home === '') {
    process.stderr.write('usage: node seed-home.mjs <home> [closure-root]\n')
    return 2
  }
  const closureRoot = argv[1] ?? defaultClosureRoot()
  const absoluteHome = resolve(home)
  const result = seedHome(absoluteHome, closureRoot)
  const summary = [
    result.manifestWritten ? `profile manifest -> ${result.profile}` : `profile manifest unchanged at ${result.profile}`,
    `${String(result.skills.length)} skill(s) -> ${join(absoluteHome, 'skills')}`,
  ]
  process.stdout.write(`seed-home: ${summary.join(', ')}\n`)
  return 0
}

// A remote and the app both run this file as a program; an importer gets the
// exports above without a seed happening as a side effect of the import.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2))
}
