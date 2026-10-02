/**
 * Bundled harness resolution.
 *
 * A packaged build ships a complete `@deepseek-ai/dsh` dependency closure in
 * `<app>/Contents/Resources/harness`, so a user can copy the .dmg to
 * /Applications and run a local instance with no Node install and no `dsh` on
 * PATH. The closure is launched by re-entering the app's own Electron binary
 * in Node mode (`ELECTRON_RUN_AS_NODE=1`), because Electron embeds a Node
 * runtime that already satisfies the harness's `>=22.19` engine range.
 *
 * `--expose-internals` must be passed as a real argv token: the harness's HMR
 * plugin requires it, and Node refuses it through NODE_OPTIONS. In Node mode
 * Electron forwards unrecognized flags to the embedded Node, which is why the
 * launcher prepends it before the CLI path.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLED_CLI_RELATIVE, readHarnessMeta } from './closure-catalog.ts'
import type { HarnessMeta } from './closure-catalog.ts'

/** Directory name under `Resources` (packaged) / repo root (development). */
export const BUNDLED_DIR_NAME = 'harness'
export type { HarnessMeta } from './closure-catalog.ts'

/** A launchable bundled harness: the Electron-as-Node command plus its closure root. */
export interface BundledHarness {
  /** Absolute path to the Electron executable used as the Node runtime. */
  runtime: string
  /** Absolute path to the harness CLI entry (`lib/bin.js`). */
  cli: string
  /** Absolute path to the staged closure root. */
  root: string
  /** Environment entries every spawn of this harness needs. */
  env: Record<string, string>
  /** Metadata, when the closure was staged with a version record. */
  meta?: HarnessMeta
}

/**
 * Root of the staged closure for this run. Packaged builds keep it in
 * `Resources`; a development checkout keeps it in `resources/` so
 * `pnpm stage:harness && pnpm dev` exercises the same code path as the .dmg.
 */
export function bundledHarnessRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, BUNDLED_DIR_NAME)
  return resolve(app.getAppPath(), 'resources', BUNDLED_DIR_NAME)
}

/**
 * Resolve the bundled harness, or undefined when this build carries none
 * (for example a from-source dev run before `pnpm stage:harness`).
 *
 * `existsSync` is the only check: a half-staged closure should surface as a
 * spawn error naming the CLI path rather than silently falling back to PATH.
 */
export function resolveBundledHarness(): BundledHarness | undefined {
  const root = bundledHarnessRoot()
  const cli = join(root, BUNDLED_CLI_RELATIVE)
  if (!existsSync(cli)) return undefined
  return {
    runtime: process.execPath,
    cli,
    root,
    env: bundledHarnessEnv(),
    meta: readHarnessMeta(root),
  }
}

/** The environment every bundled-harness spawn must carry. */
export function bundledHarnessEnv(): Record<string, string> {
  return {
    // Re-enter the Electron binary as a plain Node runtime instead of the GUI.
    ELECTRON_RUN_AS_NODE: '1',
    // Marks the child so it can tell it was booted from a bundled shell.
    DSH_BUNDLED: '1',
    // Electron's Node is a full Node runtime; tell the harness's engine gate so
    // a minor mismatch between Electron's Node and the pinned range is not fatal.
    DSH_SKIP_ENGINE_CHECK: '1',
  }
}

/** Build the argv for one bundled harness boot (`web --port 0 --no-open`). */
export function bundledHarnessArgs(harness: BundledHarness, dshArgs: readonly string[] = []): string[] {
  // --expose-internals first: it is a runtime flag for the embedded Node, and
  // everything after the CLI path belongs to the CLI's own parser.
  return ['--expose-internals', harness.cli, 'web', '--port', '0', '--no-open', ...dshArgs]
}

/**
 * The home a bundled local instance uses.
 *
 * The app never sets `DSH_HOME` for a local instance, so the child inherits the
 * GUI process's own `DSH_HOME`, else `~/.dsh`. This mirrors
 * `resolveDshHome` in `@deepseek-ai/dsh-home-paths`, which the harness applies
 * on the far side: the app cannot import from that package, because it consumes
 * prebuilt closures rather than the harness sources.
 * @returns the absolute harness home the child will use.
 */
export function localHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  const selected = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.dsh')
  return resolve(selected.startsWith('~/') ? join(homedir(), selected.slice(2)) : selected)
}

/**
 * Seed the bundled closure's plugins and skills into the home its instance uses.
 *
 * The closure's own `seed-home.mjs` is the one implementation of the rule, and
 * it is imported rather than reimplemented: it decides whether a profile manifest
 * may be rewritten and whether a skill entry may be replaced, and both answers have
 * to be the same for a local instance, a remote one, and the app.
 *
 * A missing closure, an unseeded one, and a home that refuses the write are all
 * reported rather than thrown: an instance that boots without this app's plugins is
 * still a working harness, and a failed connect names the real cause.
 *
 * @param harness - the resolved bundled closure.
 * @param log - progress sink, wired to the instance's capped log buffer.
 * @returns whether the seed wrote anything.
 */
export async function seedBundledHarnessHome(
  harness: BundledHarness,
  log: (line: string) => void = () => undefined,
): Promise<boolean> {
  const home = localHarnessHome()
  const seedScript = join(harness.root, 'seed-home.mjs')
  if (!existsSync(seedScript)) {
    log(`the staged closure carries no seed-home.mjs; ${home} keeps the profile it has`)
    return false
  }
  try {
    // The module is shipped with the closure and is plain ESM, so neither the
    // app's bundle nor a build step is involved in loading it.
    const seed = (await import(pathToFileURL(seedScript).href)) as {
      seedHome: (home: string, closureRoot: string) => { manifestWritten: boolean; skills: string[] }
    }
    const result = seed.seedHome(home, harness.root)
    log(result.manifestWritten
      ? `seeded the web profile at ${home} with the plugins this build ships`
      : `${home} keeps its own plugin selection; the web profile was left alone`)
    if (result.skills.length > 0) log(`seeded ${String(result.skills.length)} skill(s) into ${join(home, 'skills')}`)
    return result.manifestWritten || result.skills.length > 0
  } catch (error) {
    log(`could not seed ${home}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
