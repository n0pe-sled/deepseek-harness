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
 * - The CLI is found on a PATH widened by `containerPath` and run by absolute
 *   path: started from Finder this process has launchd's PATH, which has no
 *   /usr/local/bin, and a bare `docker` spawn reports a working install as
 *   missing.
 * - Everything the app itself assembles is an argv array passed to spawn;
 *   never a shell string.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { SandboxOptions } from '../../shared/instance.ts'
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_RELAY_PORT } from '../../shared/instance.ts'
import { containerPath, findExecutable } from './exec-path.ts'

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

/**
 * The published host port for the relay, from either `docker port` output
 * shape. With no port argument Docker prints `<port>/tcp -> 127.0.0.1:<host>`;
 * with a port argument it prints the bare `<host>:<port>` for that mapping
 * only (verified against Docker on this machine). Both call sites ask for a
 * specific port, so the bare shape is unambiguous.
 */
export function parseDockerPort(output: string, relayPort: number): number | undefined {
  const prefixed = new RegExp(`^${String(relayPort)}/tcp\\s*->\\s*\\S+:(\\d+)$`, 'u')
  const bare = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d+)$/u
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '') continue
    const match = prefixed.exec(line) ?? bare.exec(line)
    const port = match === null ? undefined : Number.parseInt(match[1] ?? '', 10)
    if (port !== undefined && Number.isSafeInteger(port) && port > 0 && port <= 65535) return port
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
  /** Resolved options; `dshHome` here is the sandbox-private home to bind. */
  sandbox: ResolvedSandbox
  log?: (line: string) => void
}

export interface SandboxHandle {
  endpoint: string
  stop(): Promise<void>
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

const RUNTIME_PROBE_TIMEOUT_MS = 10_000
const READY_TIMEOUT_MS = 120_000

/** Container CLIs in preference order. */
const RUNTIME_CLIS = ['docker', 'podman'] as const

/**
 * The container CLI to drive, plus the environment every one of its spawns
 * runs with. `bin` is an absolute path so a spawn cannot resolve to a
 * different binary than the probe approved, and `env` carries the widened PATH
 * that found it, which the CLI also needs for its own credential helpers.
 */
export interface ContainerRuntime {
  cli: string
  bin: string
  env: NodeJS.ProcessEnv
}

/** One candidate CLI's outcome, kept apart so the error can name the real fault. */
export interface RuntimeCandidate {
  cli: string
  bin?: string
  failure?: string
}

/**
 * Which container CLI answers, docker first. The caller passes an environment
 * whose PATH `containerPath` already widened: a Dock-launched app inherits a
 * PATH with no /usr/local/bin, so a bare spawn would find no CLI that is in
 * fact installed.
 */
export async function detectRuntime(log: (line: string) => void, env: NodeJS.ProcessEnv): Promise<ContainerRuntime> {
  const pathValue = env.PATH ?? ''
  const candidates: RuntimeCandidate[] = []
  for (const cli of RUNTIME_CLIS) {
    const bin = findExecutable(cli, pathValue)
    if (bin === undefined) {
      log(`${cli}: not installed`)
      candidates.push({ cli })
      continue
    }
    const failure = await probeDaemon(bin, env)
    if (failure === undefined) {
      log(`${cli}: ${bin}`)
      return { cli, bin, env }
    }
    log(`${cli}: found at ${bin}, but not usable (${failure})`)
    candidates.push({ cli, bin, failure })
  }
  throw new Error(noRuntimeMessage(candidates, pathValue))
}

/**
 * `version --format ok`, where the success flag means the daemon answered.
 * Returns undefined when it did, or a one-line reason when it did not: a CLI
 * whose daemon is down fails this and would fail `run` too, so it is caught
 * here where the message can say so.
 */
function probeDaemon(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolveProbe) => {
    const child = spawn(bin, ['version', '--format', 'ok'], { stdio: ['ignore', 'ignore', 'pipe'], env })
    let stderr = ''
    let settled = false

    const finish = (failure: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProbe(failure)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(`no answer within ${String(RUNTIME_PROBE_TIMEOUT_MS / 1000)}s`)
    }, RUNTIME_PROBE_TIMEOUT_MS)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(error.message))
    child.once('exit', (code) => {
      finish(code === 0 ? undefined : lastLine(stderr) ?? `exit ${String(code)}`)
    })
  })
}

/** The last non-empty line of CLI stderr, cut to a length an error can carry. */
function lastLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
  const line = lines.at(-1)
  if (line === undefined) return undefined
  return line.length > 240 ? `${line.slice(0, 237)}...` : line
}

/**
 * The failure text for an unusable runtime. An installed CLI that is not
 * answering needs a different fix than a missing one, and one message for both
 * sent users with a stopped Docker Desktop looking for an installer.
 */
export function noRuntimeMessage(candidates: readonly RuntimeCandidate[], pathValue: string): string {
  const installed = candidates.find((candidate) => candidate.bin !== undefined)
  if (installed !== undefined) {
    const start = installed.cli === 'docker' ? 'Start Docker Desktop' : 'Start the podman machine'
    return `${installed.cli} is installed at ${installed.bin} but did not answer: ${installed.failure ?? 'no detail'}. `
      + `${start}, or disable sandboxing for this instance to run dsh directly.`
  }
  const searched = [...new Set(pathValue.split(':').filter((dir) => dir !== ''))]
  return `no container runtime found: looked for docker and podman in ${searched.join(', ')}. `
    + 'Install one to use the sandbox, or disable sandboxing for this instance to run dsh directly.'
}

/** Run one short container CLI command, returning its stdout; throws on nonzero exit. */
async function docker(
  runtime: ContainerRuntime,
  args: readonly string[],
  timeoutMs = RUNTIME_PROBE_TIMEOUT_MS,
): Promise<string> {
  return await new Promise((resolveOut, reject) => {
    const child = spawn(runtime.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: runtime.env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${runtime.cli} ${args[0]} timed out`))
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
      reject(new Error(`could not run ${runtime.cli}: ${error.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveOut(stdout)
      else reject(new Error(`${runtime.cli} ${args[0]} failed (exit ${String(code)})${stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-2).join('; ')}`}`))
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
  // Widen PATH before looking for a container CLI: started from Finder this
  // process has launchd's PATH, which has no /usr/local/bin and so no docker.
  const env = { ...process.env, PATH: containerPath(process.env.PATH ?? '', process.env.HOME) }
  const runtime = await detectRuntime(log, env)
  log(`container runtime: ${runtime.bin}`)

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
  const logs = spawn(runtime.bin, ['logs', '-f', opts.name], { stdio: ['ignore', 'pipe', 'pipe'], env: runtime.env })
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
        const child = spawn(runtime.bin, ['rm', '-f', opts.name], { stdio: 'ignore', env: runtime.env })
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
async function publishedPort(runtime: ContainerRuntime, name: string): Promise<number> {
  const out = await docker(runtime, ['port', name, String(SANDBOX_RELAY_PORT)])
  const port = parseDockerPort(out, SANDBOX_RELAY_PORT)
  if (port === undefined) {
    throw new Error(`could not read the published relay port from ${runtime.cli} port ${name}`)
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
