/**
 * Container sandboxing for dsh instances: pure argv builders plus the local
 * launcher and the remote-launch command builders.
 *
 * The design's load-bearing facts (verified in the prior session's probes, see
 * the handoff):
 *
 * - The harness only ever binds loopback, and the CLI refuses `0.0.0.0`. A
 *   plain `docker run -p` publish therefore looks ready while every proxied
 *   connection is reset. The image solves this with a relay on 0.0.0.0 inside
 *   the container (port 3081); the port we publish is the relay's.
 * - The container is started detached with a STABLE name derived from the
 *   instance id, so a reconnect adopts the running container instead of
 *   stacking a second one, and stop is `docker rm -f` (never `--rm`: a
 *   removed container takes its crash logs with it).
 * - Readiness comes from `docker logs -f` — a stream the app can follow, not
 *   a fixed sleep — because a cold start under emulation can take far longer
 *   than a host start.
 * - Everything the app itself assembles is an argv array passed to spawn;
 *   never a shell string.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { SandboxOptions } from '../../shared/instance.ts'
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_RELAY_PORT } from '../../shared/instance.ts'

/** A sandbox with its defaults resolved; the launcher's only input. */
export interface ResolvedSandbox {
  enabled: boolean
  image: string
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>
  dshHome?: string
  runArgs: string[]
  outboundNetwork: boolean
}

/**
 * Resolve one sandbox option value against the built-in defaults. Absent
 * fields mean the default; `enabled: false` is the explicit opt-out. A
 * profile/global-default layer slots in ahead of the built-in default when
 * the settings surface arrives — one function, so the order stays testable.
 */
export function resolveSandboxOptions(sandbox: SandboxOptions | undefined): ResolvedSandbox {
  return {
    enabled: sandbox?.enabled !== false,
    image: sandbox?.image === undefined || sandbox.image === '' ? DEFAULT_SANDBOX_IMAGE : sandbox.image,
    mounts: (sandbox?.mounts ?? []).map((m) => ({
      hostPath: m.hostPath,
      containerPath: m.containerPath ?? '/workspace',
      readOnly: m.readOnly === true,
    })),
    dshHome: sandbox?.dshHome === undefined || sandbox.dshHome === '' ? undefined : sandbox.dshHome,
    runArgs: sandbox?.runArgs ?? [],
    outboundNetwork: sandbox?.outboundNetwork !== false,
  }
}

/** The stable container name for one instance id (reconnect adopts it). */
export function containerName(instanceId: string): string {
  return `dsh-sandbox-${instanceId}`
}

/**
 * The `docker run` argv for one sandboxed harness. Ordering rule: the app's
 * own flags first (its mounts and published port cannot be replaced by
 * accident), then the user's runArgs (a later flag wins, which is their
 * choice), then the image, then nothing — everything after the image would
 * silently replace the container command.
 */
export function buildDockerRunArgs(resolved: ResolvedSandbox, name: string, hostPort: number): string[] {
  const args = [
    'run',
    '-d',
    '--name', name,
    '--init',
    '--publish', `127.0.0.1:${String(hostPort)}:${String(SANDBOX_RELAY_PORT)}`,
    '--env', `DSH_HOME=/data`,
  ]
  for (const mount of resolved.mounts) {
    args.push('--volume', `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ':ro' : ''}`)
  }
  if (resolved.dshHome !== undefined) {
    args.push('--volume', `${resolved.dshHome}:/data`)
  }
  if (!resolved.outboundNetwork) {
    args.push('--network', 'none')
  }
  args.push(...resolved.runArgs, resolved.image)
  return args
}

/** Whether one `docker port` output line publishes the relay port. */
export function parseDockerPort(output: string, relayPort: number): number | undefined {
  // One line looks like:  3081/tcp -> 127.0.0.1:64081
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(`${String(relayPort)}/tcp`)) continue
    const match = /:(\d+)\s*$/u.exec(line.trim())
    const port = match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
    if (port !== undefined && port > 0 && port <= 65535) return port
  }
  return undefined
}

/** Probe a free loopback port by binding and releasing it. The usual race
 * applies, but the window is small and the retry path is a plain restart. */
export async function pickFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not probe a free loopback port'))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })
}

export interface SandboxLaunchOptions {
  /** Stable per-instance container name. */
  name: string
  sandbox: ResolvedSandbox
  /** Directory backing the container's DSH_HOME when the config left it open. */
  defaultDshHome: string
  log?: (line: string) => void
}

export interface SandboxHandle {
  endpoint: string
  stop(): Promise<void>
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

const RUNTIME_PROBE_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 120_000

/** Which container CLI answers, docker first. */
async function detectRuntime(log: (line: string) => void): Promise<string> {
  for (const cli of ['docker', 'podman']) {
    if (await commandWorks(cli)) return cli
    log(`${cli}: not available`)
  }
  throw new Error(
    'no container runtime found (tried docker, podman). '
    + 'Install one to use the sandbox, or disable sandboxing for this instance to run dsh directly.',
  )
}

function commandWorks(cli: string): Promise<boolean> {
  return new Promise((resolveWorks) => {
    const child = spawn(cli, ['version', '--format', 'ok'], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveWorks(false)
    }, RUNTIME_PROBE_TIMEOUT_MS)
    child.once('error', () => {
      clearTimeout(timer)
      resolveWorks(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolveWorks(code === 0)
    })
  })
}

/** Run one short docker command, returning its stdout; throws on nonzero exit. */
async function docker(runtime: string, args: readonly string[], timeoutMs = RUNTIME_PROBE_TIMEOUT_MS): Promise<string> {
  return await new Promise((resolveOut, reject) => {
    const child = spawn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${runtime} ${args[0]} timed out`))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`could not run ${runtime}: ${error.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveOut(stdout)
      else reject(new Error(`${runtime} ${args[0]} failed (exit ${String(code)})${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-2).join('; ')}`}`))
    })
  })
}

/**
 * Start one sandboxed local harness: preflight, pull, run detached, follow
 * the logs for the readiness line, and hand back the loopback endpoint on
 * this host.
 */
export async function startSandboxedDsh(opts: SandboxLaunchOptions): Promise<SandboxHandle> {
  const { log = () => undefined } = opts
  const runtime = await detectRuntime(log)
  log(`container runtime: ${runtime}`)

  // Pull only when the image is absent: the common path is offline and instant.
  try {
    await docker(runtime, ['image', 'inspect', opts.sandbox.image])
    log(`image ${opts.sandbox.image} present`)
  } catch {
    log(`pulling ${opts.sandbox.image} (first run can take a while)`)
    await docker(runtime, ['pull', opts.sandbox.image], 10 * 60_000)
  }

  // Adopt a running container of the same name instead of stacking a second.
  const state = await docker(runtime, ['inspect', '--format', '{{.State.Running}}', opts.name])
    .then((out) => out.trim())
    .catch(() => 'absent')
  if (state === 'true') {
    log(`reusing the already-running container ${opts.name}`)
  } else {
    if (state !== 'absent') {
      // Exists but stopped: a previous run's leftover. Remove so run is clean.
      await docker(runtime, ['rm', '-f', opts.name])
    }
    const runArgs = buildDockerRunArgs(opts.sandbox, opts.name, await pickFreePort())
    // The host port is inside runArgs; rebuild with the picked port reported.
    log(`starting container ${opts.name}`)
    await docker(runtime, runArgs)
  }

  const hostPort = await publishedPort(runtime, opts.name)
  const endpoint = `http://127.0.0.1:${String(hostPort)}`

  // Follow the logs for readiness: a stream, not a sleep, so an emulated cold
  // start takes the time it needs (the timeout is generous for that reason).
  const logs = spawn(runtime, ['logs', '-f', opts.name], { stdio: ['ignore', 'pipe', 'pipe'] })
  let settled = false
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      rejectReady(new Error(`the sandbox reported no readiness line within ${String(READY_TIMEOUT_MS / 1000)}s`))
    }, READY_TIMEOUT_MS)
    logs.stdout?.setEncoding('utf8')
    logs.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (/dsh web: http:\/\/(127\.0\.0\.1|localhost):/.test(line) && !settled) {
          settled = true
          clearTimeout(timer)
          resolveReady()
        }
      }
    })
    logs.once('exit', () => {
      if (settled) return
      settled = true
      rejectReady(new Error('the container exited before the harness was ready'))
    })
    logs.once('error', (error) => {
      if (settled) return
      settled = true
      rejectReady(new Error(`could not follow container logs: ${error.message}`))
    })
  })

  await ready
  log(`connected: ${endpoint}`)

  return {
    endpoint,
    stop: async () => {
      logs.kill('SIGTERM')
      await new Promise<void>((resolveStop) => {
        const child = spawn(runtime, ['rm', '-f', opts.name], { stdio: 'ignore' })
        child.once('error', () => resolveStop())
        child.once('exit', () => resolveStop())
      })
    },
    onExit: (cb) => {
      // The log stream ends when the container does; the app learns about the
      // death through it rather than by owning the container process.
      logs.once('exit', (code, signal) => cb(code, signal))
    },
  }
}

/** The host port the relay publishes, read from `docker port`. */
async function publishedPort(runtime: string, name: string): Promise<number> {
  const out = await docker(runtime, ['port', name, String(SANDBOX_RELAY_PORT)])
  const port = parseDockerPort(out, SANDBOX_RELAY_PORT)
  if (port === undefined) {
    throw new Error(`could not read the published relay port from ${runtime} port ${name}`)
  }
  return port
}

/**
 * The remote launch command for a sandboxed provisioned instance: pull, run
 * detached with a stable name, and print the published relay port. Everything
 * ships inside the image, so there is no closure shipping and no Node
 * preflight on the remote — only a working container runtime is required.
 *
 * One shell command, in the provisioner's style: the pieces are joined so the
 * remote shell sees them as separate lines, and the last line echoes the port
 * `docker port` reports, which the caller hands to the tunnel.
 */
export function buildRemoteSandboxCommand(opts: {
  name: string
  image: string
  remoteDshHome: string
  runArgs: readonly string[]
  outboundNetwork: boolean
  mounts?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>
}): string {
  const name = shellQuote(opts.name)
  const image = shellQuote(opts.image)
  const network = opts.outboundNetwork ? '' : ' --network none'
  const volumes = [
    `${shellQuote(opts.remoteDshHome)}:/data`,
    ...(opts.mounts ?? []).map((m) => `${shellQuote(m.hostPath)}:${m.containerPath}${m.readOnly === true ? ':ro' : ''}`),
  ].map((v) => ` --volume ${v}`).join('')
  const userArgs = opts.runArgs.map((a) => ` ${shellQuote(a)}`).join('')
  return [
    `docker pull ${image}`,
    `docker rm -f ${name} >/dev/null 2>&1`,
    `docker run -d --name ${name} --init --publish 127.0.0.1::${String(SANDBOX_RELAY_PORT)} --env DSH_HOME=/data${volumes}${network}${userArgs} ${image}`,
    `docker port ${name} ${String(SANDBOX_RELAY_PORT)}`,
  ].join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}
