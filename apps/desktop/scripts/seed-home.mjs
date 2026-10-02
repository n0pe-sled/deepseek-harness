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
 *   2. A skill entry or a plugin link is placed only where nothing is, or where a
 *      broken symlink from an earlier seed is. A real file or directory is
 *      somebody's.
 *
 * A shipped plugin needs both halves of rule 1: the manifest entry names the bundle
 * AND {@link linkShippedBundles} points the profile's `node_modules` at the
 * closure, because the stock pair is the only one the installation resolves.
 *
 * Nothing else under the home is read or written: not `settings.yaml`, not
 * `credentials`, not a session, and not the profile's own patch layer.
 *
 * Usage (run by the closure's bundled Node runtime):
 *   node seed-home.mjs <home> [closure-root]
 *
 * @module apps/desktop/scripts/seed-home
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
 * The bundle names a profile must resolve for itself rather than from the
 * installation: every shipped plugin. The stock pair resolves through the install
 * anchor, while a fork plugin exists only in the closure, so a profile that names one
 * without a link to it fails to boot with "Cannot find package".
 * @param bundles - the shipped bundle list from {@link shippedBundles}.
 * @returns the bundle names that need a profile-local link.
 */
export function closureBundles(bundles) {
  return bundles.filter((name) => !STOCK_BUNDLES.includes(name))
}

/**
 * Link every shipped plugin bundle into one home's profile.
 *
 * The link lives at `<profile>/node_modules/<name>` and points into the closure,
 * which is the shape `dsh plugin --profile web add <dir>` writes and the shape the
 * sandbox image seeds. Node resolves the Loader's bare entry import through it, and
 * the plugin's own `@deepseek-ai/*` peers then resolve from the closure the link
 * points into, because Node resolves a linked module's realpath.
 *
 * A link whose target is gone is replaced, which is what a home seeded from a
 * development closure needs once a packaged app seeds the same home: the recorded
 * path is the staging machine's. A real file or directory there is somebody's, and a
 * bundle whose closure carries nothing is reported rather than linked.
 *
 * @param home - the harness home to seed.
 * @param bundles - the shipped bundle list from {@link shippedBundles}.
 * @param closureRoot - the closure root holding `node_modules/<name>`.
 * @returns what the linking wrote and skipped.
 */
export function linkShippedBundles(home, bundles, closureRoot) {
  const linked = []
  const missing = []
  for (const name of closureBundles(bundles)) {
    const from = join(closureRoot, 'node_modules', ...name.split('/'))
    if (!existsSync(from)) {
      missing.push(name)
      continue
    }
    const dest = join(home, 'profiles', 'web', 'node_modules', ...name.split('/'))
    if (!skillEntryReplaceable(dest)) continue
    if (lstatSync(dest, { throwIfNoEntry: false }) !== undefined) rmSync(dest, { force: true })
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(from, dest)
    linked.push(name)
  }
  return { linked, missing }
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
 * A shipped plugin is also declared as a `link:` dependency on its own closure path,
 * which is what {@link linkShippedBundles} points the profile's node_modules at. The
 * stock pair is not declared: the install anchor already resolves it, and a
 * dependency no installation provides would be an unresolvable specifier.
 *
 * @param home - the harness home to seed.
 * @param bundles - the shipped bundle list from {@link shippedBundles}.
 * @param closureRoot - the closure root the profile's links point into.
 * @returns whether the manifest was written.
 */
export function seedProfileManifest(home, bundles, closureRoot) {
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
    dependencies: {
      ...(current?.dependencies ?? {}),
      ...Object.fromEntries(closureBundles(bundles).map(
        name => [name, `link:${join(closureRoot, 'node_modules', ...name.split('/'))}`],
      )),
    },
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
  // Both halves of the seed record the closure path in the home: the manifest as a
  // `link:` specifier and each plugin link as its target. A relative path would
  // resolve against the profile directory instead of the caller's, so the closure root
  // is absolute here rather than at each write.
  const root = resolve(closureRoot)
  const meta = readHarnessMeta(root)
  const bundles = shippedBundles(meta)
  const skills = Array.isArray(meta?.skills) ? meta.skills.filter((name) => typeof name === 'string') : []
  const manifestWritten = bundles.length > STOCK_BUNDLES.length
    ? seedProfileManifest(home, bundles, root)
    : false
  // The links are written whether or not this run wrote the manifest: a home whose
  // manifest a person edited keeps its own list, and the links for the shipped
  // plugins are harmless beside it.
  const { linked, missing } = linkShippedBundles(home, bundles, root)
  if (missing.length > 0) {
    process.stderr.write(`seed-home: the closure carries no package for ${missing.join(', ')}\n`)
  }
  return {
    profile: join(home, 'profiles', 'web'),
    manifestWritten,
    linked,
    skills: seedSkills(home, root, skills),
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
    `${String(result.linked.length)} plugin link(s) -> ${join(result.profile, 'node_modules')}`,
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
