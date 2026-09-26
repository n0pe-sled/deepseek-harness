/**
 * Host half of dsh-instance-manager: reconciles actual `dsh web` child
 * processes to the saved instance list in the `instance-manager` settings
 * namespace, and writes runtime status back into the same document.
 *
 * Design notes:
 *
 * - The settings document is the single source of truth. Saved instances are
 *   durable because the settings-file provider persists the namespace under
 *   $DSH_HOME; there is no second registry file to drift.
 * - Reconciliation is idempotent: only `instances` and `connect` drive work,
 *   and the runtime status the host itself writes back touches neither, so a
 *   status update cannot re-trigger reconcile into a loop.
 * - Children boot the same harness this plugin runs inside (`harnessCli`
 *   config, default the image path), each with its OWN $DSH_HOME under
 *   /data/instances/<name> so credentials and sessions never cross instances.
 * - Readiness is the harness's own stdout line, parsed with the same
 *   loopback-only regex the desktop app and provisioner use.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
// Type-only imports: they pull in the ctx.settings context merge for typecheck.
import type {} from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { InstanceManagerSection, SavedInstance } from '../shared/types.ts'

export const inject = ['settings']

/** The plugin's own config surface, shown on the Plugins settings page. */
export interface Config {
  basePort: number
  harnessCli: string
}

export const Config = Schema.object({
  basePort: Schema.number().default(13100).description('First port auto-assignment uses'),
  harnessCli: Schema.string().default('/opt/harness/lib/bin.js').description('Harness CLI children boot'),
})

/** The schemastery schema for the namespace document (defaults = fresh state). */
const sectionSchema = Schema.object({
  instances: Schema.array(Schema.object({
    name: Schema.string(),
    workspace: Schema.string(),
    port: Schema.number(),
    env: Schema.dict(Schema.string()),
    autoStart: Schema.boolean(),
  })).default([]),
  connect: Schema.string(),
  runtime: Schema.dict(Schema.object({
    state: Schema.string(),
    url: Schema.string(),
    error: Schema.string(),
  })).default({}),
})

const READY_URL = /dsh web: (http:\/\/(?:127\.0\.0\.1|localhost):(\d+))/u
const STOP_GRACE_MS = 3_000

interface Running {
  child: ChildProcess
  port: number
  state: 'starting' | 'running'
}

/** Port auto-assignment: first free port at or above `base`, up to 100 tries. */
export function pickPort(base: number, taken: Iterable<number>): number {
  const used = new Set(taken)
  for (let port = base; port < base + 100; port += 1) {
    if (!used.has(port)) return port
  }
  throw new Error(`no free port above ${base}`)
}

/** Whether two saved lists name the same work — the reconcile short-circuit. */
function sameInstances(a: readonly SavedInstance[], b: readonly SavedInstance[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function apply(ctx: Context, config: Config): void {
  const scope: SettingsScope<InstanceManagerSection> = ctx.settings.register('instance-manager', sectionSchema)
  const running = new Map<string, Running>()
  const log = (line: string): void => {
    // Container stdout, which is what `docker logs` shows: the supervisor's
    // decisions are otherwise invisible from outside the sandbox.
    process.stdout.write(`[instance-manager] ${line}\n`)
  }

  const status = (name: string, patch: { state: string; url?: string; error?: string }): void => {
    void scope.update({ runtime: { ...currentRuntime(), [name]: patch } }).catch(() => undefined)
  }

  const currentRuntime = (): Record<string, unknown> => scope.get()?.runtime ?? {}

  /** The port one saved instance gets: its own, or the first free after base. */
  const portOf = (instance: SavedInstance, all: readonly SavedInstance[]): number =>
    instance.port ?? pickPort(config.basePort, all.map((i) => i.port ?? 0))

  const start = (instance: SavedInstance, all: readonly SavedInstance[]): void => {
    if (running.has(instance.name)) return
    const port = portOf(instance, all)
    const home = resolve(process.env.DSH_HOME ?? '/data', 'instances', instance.name)
    mkdirSync(home, { recursive: true })
    status(instance.name, { state: 'starting' })
    const child = spawn(process.execPath, [config.harnessCli, 'web', '--port', String(port), '--no-open'], {
      cwd: existsSync(instance.workspace) ? instance.workspace : home,
      env: { ...process.env, DSH_HOME: home, ...(instance.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const handle: Running = { child, port, state: 'starting' }
    running.set(instance.name, handle)
    log(`starting ${instance.name} on port ${port} (home ${home})`)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const match = READY_URL.exec(chunk)
      if (match !== null && handle.state === 'starting') {
        handle.state = 'running'
        status(instance.name, { state: 'running', url: match[1] })
      }
    })
    child.once('exit', (code, signal) => {
      running.delete(instance.name)
      log(`${instance.name} exited (code ${String(code)}${signal === null ? '' : `, signal ${signal}`})`)
      status(instance.name, {
        state: 'stopped',
        ...(code === 0 || signal !== null
          ? {}
          : { error: `exited with code ${String(code)}` }),
      })
    })
  }

  const stop = (name: string): void => {
    const handle = running.get(name)
    if (handle === undefined) return
    running.delete(name)
    log(`stopping ${name}`)
    handle.child.kill('SIGTERM')
    setTimeout(() => {
      if (handle.child.exitCode === null) handle.child.kill('SIGKILL')
    }, STOP_GRACE_MS)
    status(name, { state: 'stopped' })
  }

  /** Make reality match the document. Skips all work when the saved list is
   * unchanged, so the host's own status writes (which fire this again) are a
   * no-op rather than a loop. Auto-started instances are the only implicit
   * work; an explicit Connect click starts on request regardless of autoStart.
   */
  let lastSeen: readonly SavedInstance[] = []
  const reconcile = (): void => {
    const section = scope.get()
    const instances = section?.instances ?? []
    if (!sameInstances(instances, lastSeen)) {
      lastSeen = instances
      const wanted = new Set(instances.map((i) => i.name))
      for (const name of [...running.keys()]) {
        if (!wanted.has(name)) stop(name)
      }
      for (const instance of instances) {
        if (instance.autoStart === true && !running.has(instance.name)) start(instance, instances)
      }
    }
    // A Connect click names one instance and starts it; the URL is what the
    // panel then reads from the runtime map. Stop is its symmetric request;
    // both are consumed (nulled) so a fresh boot never replays an old click.
    if (section?.connect) {
      const instance = instances.find((i) => i.name === section.connect)
      if (instance !== undefined) start(instance, instances)
      void scope.update({ connect: null }).catch(() => undefined)
    }
    if (section?.stop) {
      stop(section.stop)
      void scope.update({ stop: null }).catch(() => undefined)
    }
  }

  log(`ready: ${String(scope.get()?.instances?.length ?? 0)} saved instance(s), cli ${config.harnessCli}`)
  scope.watch(() => reconcile())
  // Reconcile once at activation too: `watch` only fires on later commits, so
  // without this an autoStart instance would sit stopped until some unrelated
  // settings write happened to arrive.
  reconcile()
  ctx.on('dispose', () => {
    for (const name of [...running.keys()]) stop(name)
  })
}
