/**
 * Local instance supervision: spawn `dsh web --port 0 --no-open`, parse the
 * readiness URL line, and provide graceful stop.
 *
 * Two launch shapes share this module. With `dshPath` set, the child is a
 * user-supplied executable. Otherwise the app spawns the harness closure it
 * ships with, using its own Electron binary as the Node runtime (see
 * bundled.ts) — that is what lets a .dmg copied into /Applications run a local
 * instance with no Node install and no `dsh` on PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { LocalOptions } from '../../shared/instance.ts'
import { parseReadyUrl } from '../../shared/readiness.ts'
import { bundledHarnessArgs, resolveBundledHarness, seedBundledHarnessHome, type BundledHarness } from './bundled.ts'
import { augmentedEnv } from './exec-path.ts'

export interface LocalHandle {
  endpoint: string
  child: ChildProcess
  stop(): Promise<void>
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

const READY_TIMEOUT_MS = 30_000

/**
 * A dsh executable may carry a trailing `web` subcommand the user typed in the
 * executable field (e.g. `/path/dsh web`). The launcher always appends
 * `web --port 0 --no-open`, so strip a standalone trailing `web` token to avoid
 * spawning a binary literally named `dsh web`.
 */
export function normalizeDshPath(value: string): string {
  const trimmed = value.trim()
  const parts = trimmed.split(/\s+/u)
  if (parts.length > 1 && parts[parts.length - 1] === 'web') {
    return parts.slice(0, -1).join(' ')
  }
  return trimmed
}

/** Parsed readiness URL from one `dsh web:` stdout line, or undefined. */
export { parseReadyUrl }

/** The executable, argv, and environment of one local dsh boot. */
export interface LaunchCommand {
  bin: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The bundled closure when this launch uses it; undefined for a custom path. */
  bundled?: BundledHarness
  /** Human-readable launch description for error messages. */
  describe: string
}

/**
 * Decide how one local instance launches. An explicit `dshPath` always wins, so
 * a user who configures their own harness (or a remote-style wrapper script)
 * keeps exactly the old behavior; otherwise the bundled closure is used.
 *
 * Throws when neither exists: a from-source dev run without a staged closure
 * and no configured path has nothing to spawn, and saying so is more useful
 * than a bare ENOENT.
 */
export function resolveLaunchCommand(opts: LocalOptions, resolveBundled: () => BundledHarness | undefined = resolveBundledHarness): LaunchCommand {
  const configured = opts.dshPath?.trim()
  // Both shapes need a usable PATH: the harness spawns bash/rg/ssh helpers, and
  // a LaunchServices-started app inherits a minimal PATH.
  const env = augmentedEnv({ ...process.env, ...(opts.env ?? {}) })

  if (configured !== undefined && configured !== '') {
    const bin = normalizeDshPath(configured)
    return {
      bin,
      args: ['web', '--port', '0', '--no-open', ...(opts.dshArgs ?? [])],
      env,
      describe: bin,
    }
  }

  const harness = resolveBundled()
  if (harness === undefined) {
    throw new Error(
      'no dsh available: this build carries no bundled harness and no dsh executable is configured',
    )
  }
  return {
    // The runtime (Electron binary) is the executable; the CLI path is an argv
    // token after --expose-internals, which the embedded Node must see.
    bin: harness.runtime,
    args: bundledHarnessArgs(harness, opts.dshArgs ?? []),
    env: { ...env, ...harness.env },
    bundled: harness,
    describe: `bundled dsh${harness.meta?.version === undefined ? '' : ` ${harness.meta.version}`}`,
  }
}

export async function startLocalDsh(
  opts: LocalOptions,
  log: (line: string) => void = () => undefined,
  seedBundled: (harness: BundledHarness, log: (line: string) => void) => Promise<boolean> = seedBundledHarnessHome,
): Promise<LocalHandle> {
  const command = resolveLaunchCommand(opts)
  const { bin, args, env } = command
  // A bundled run seeds its home from the closure before the child starts, so
  // the profile it boots names the plugins and skills this build ships. A
  // configured `dshPath` is somebody else's harness with somebody else's home,
  // and a sandboxed run gets a seeded home from its image, so neither is seeded
  // here. The child is not spawned on a seed failure: the home is not the
  // harness's to remove, and an instance that boots without the shipped plugins
  // would say nothing about why.
  if (command.bundled !== undefined) {
    try {
      await seedBundled(command.bundled, log)
    } catch (error) {
      throw new Error(`could not seed the bundled harness home: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const child = spawn(bin, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let settled = false
  let resolveReady: (handle: LocalHandle) => void
  let rejectReady: (reason: Error) => void
  const ready = new Promise<LocalHandle>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      rejectReady(new Error(`dsh web did not report a URL within ${READY_TIMEOUT_MS / 1000}s`))
      void child.kill('SIGTERM')
    }
  }, READY_TIMEOUT_MS)

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
    for (const line of stdout.split(/\r?\n/u).filter((l) => l !== '')) {
      const url = parseReadyUrl(line)
      if (url !== undefined) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolveReady({
            endpoint: url,
            child,
            stop: () => stopChild(child),
            onExit: (cb) => void child.once('exit', cb),
          })
        }
        log(line)
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
    log(chunk)
  })
  child.once('error', (error) => {
    if (!settled) {
      settled = true
      clearTimeout(timer)
      rejectReady(new Error(`failed to launch dsh (${command.describe}): ${error.message}`))
    }
  })
  child.once('exit', (code, signal) => {
    if (!settled) {
      settled = true
      clearTimeout(timer)
      const tail = stderr.trim().split(/\r?\n/u).slice(-4).join('\n')
      rejectReady(new Error(`dsh exited before ready (code ${String(code)}${signal === null ? '' : `, signal ${signal}`})${tail === '' ? '' : `:\n${tail}`}`))
    }
  })

  return ready
}

export function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 3000)
    child.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
