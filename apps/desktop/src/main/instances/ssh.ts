/**
 * SSH transport.
 *
 * Two shapes share one connection recipe. A plain instance forwards a port the
 * user already knows (`ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>`), and
 * a provisioned instance forwards a port it discovered after starting the
 * harness itself. Either way the remote dsh appears as a loopback endpoint,
 * which passes the dsh /api trust fence and keeps every privileged method
 * functional — the harness's recommended remote posture.
 *
 * Every call carries `BatchMode=yes`, so ssh never prompts: a missing key is a
 * bare failure rather than a hang inside a GUI process with no terminal.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { SshOptions } from '../../shared/instance.ts'
import { augmentedEnv } from './exec-path.ts'

export interface SshTunnelHandle {
  localPort: number
  readonly endpoint: string
  stop(): Promise<void>
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

const READY_TIMEOUT_MS = 20_000
/** How often the forwarded port is probed while a tunnel comes up. */
const POLL_INTERVAL_MS = 300
/** Bound on one probe, so a hung forward cannot stall the loop. */
const PROBE_TIMEOUT_MS = 2_000

/**
 * Options every ssh invocation for one host must carry, in argv order.
 *
 * Exported because the provisioner runs its own commands (detect, ship,
 * launch, poll) and they have to agree with the tunnel about host keys,
 * identity, and never prompting. A host accepted by one call and rejected by
 * the next would be a confusing failure mode.
 */
export function buildSshBaseArgs(opts: SshOptions): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${opts.strictHostKeyChecking ?? 'accept-new'}`,
  ]
  if (opts.port !== undefined) args.push('-p', String(opts.port))
  if (opts.identityFile !== undefined && opts.identityFile !== '') args.push('-i', opts.identityFile)
  return args
}

/**
 * The environment every ssh child runs with.
 *
 * Exported for the same reason as {@link buildSshBaseArgs}: the provisioner
 * spawns its own ssh children, and an ssh invocation that resolves
 * `ProxyCommand` helpers differently from the tunnel's would fail where the other
 * succeeds. `ProxyCommand` runs through the user's shell with the PATH here, and
 * an app started from Finder inherits launchd's PATH, which holds no directory a
 * package manager installs into.
 *
 * @returns a copy of this process's environment with the PATH widened.
 */
export function sshSpawnEnv(): NodeJS.ProcessEnv {
  return augmentedEnv(process.env)
}

/** Build `[user@]host` for one option set. */
export function sshDestination(opts: SshOptions): string {
  return opts.user !== undefined && opts.user !== '' ? `${opts.user}@${opts.host}` : opts.host
}

/**
 * Turn ssh's stderr into something a user can act on.
 *
 * ssh reports the interesting cases in prose on stderr and then exits, so the
 * raw text is the only diagnosis available; without this the sidebar says
 * "process exited" and the user has nothing to go on. Each branch names the
 * cause and what to change.
 *
 * The proxy path is checked first. A `ProxyCommand` that cannot run, and a proxy
 * that refuses it, both end with ssh reporting the connection closed by an
 * unknown peer, which reads like a remote failure and is not one: the cause is on
 * this machine. The same text is what a failed provision command reports, so both
 * callers share this one classifier.
 *
 * The refused-forward case deserves its own words: ssh with
 * `ExitOnForwardFailure=yes` treats a refused *connection* through an
 * established forward as a channel error rather than a startup failure, so the
 * process keeps running and the app only sees the port never answering. That is
 * what a remote port with nothing behind it looks like, and it is the single
 * most confusing failure this path has. It needs `remotePort`, so a caller without
 * one (a provision command) reads the same stderr as a transport failure instead.
 *
 * @param stderr - ssh's stderr text.
 * @param opts - the options the call ran with, for the destination and host.
 * @param remotePort - the forwarded remote port, when one call was forwarding.
 * @returns guidance naming the cause, or undefined when the text names none.
 */
export function describeSshFailure(stderr: string, opts: SshOptions, remotePort?: number): string | undefined {
  const text = stderr.trim()
  if (text === '') return undefined
  const destination = sshDestination(opts)
  if (/Ncat:|ProxyCommand|ProxyJump|Connection closed by UNKNOWN/iu.test(text)) {
    return `ssh could not reach ${opts.host}: the command it runs to reach the host failed on this machine. `
      + 'The app hands ssh the standard installation directories on PATH, so a helper named by a ProxyCommand '
      + '(such as ncat from the nmap package) has to be installed in one of them, and any proxy it routes through has to be running.'
  }
  if (remotePort !== undefined && /Connection refused/iu.test(text)) {
    return `Nothing is listening on 127.0.0.1:${String(remotePort)} on ${opts.host}. `
      + 'Either start dsh there, or turn on "Ship this app\'s harness to the host" so the app runs it for you.'
  }
  if (/Permission denied|publickey/iu.test(text)) {
    return `ssh to ${destination} was refused. The app runs ssh in BatchMode, so it cannot prompt for a password: `
      + 'key-based authentication is required. Set an identity file on the instance, or load the key into ssh-agent.'
  }
  if (/No route to host|Network is unreachable/iu.test(text)) {
    return `${opts.host} is not reachable from this machine.`
  }
  if (/Could not resolve hostname/iu.test(text)) {
    return `The host name ${opts.host} does not resolve.`
  }
  if (/Connection timed out|Operation timed out/iu.test(text)) {
    return `The connection to ${opts.host} timed out.`
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text)) {
    return `The host key for ${opts.host} does not match the one on record. `
      + 'If the host was rebuilt, remove its old entry from ~/.ssh/known_hosts.'
  }
  return undefined
}

/** The last few non-empty stderr lines, for pasting into an error message. */
export function sshErrorTail(stderr: string, lines = 4): string {
  return stderr.trim().split(/\r?\n/u).filter((line) => line.trim() !== '').slice(-lines).join('\n')
}

/** Build the ssh argv for one tunnel; exported for tests. */
export function buildSshArgs(opts: SshOptions, localPort: number): string[] {
  return buildTunnelArgs(opts, localPort, opts.remotePort ?? 3000)
}

/** Build a tunnel argv for an explicit remote port (the provisioned path). */
export function buildTunnelArgs(opts: SshOptions, localPort: number, remotePort: number): string[] {
  return [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    ...buildSshBaseArgs(opts),
    '-L', `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    sshDestination(opts),
  ]
}

/** Build the argv for one non-interactive remote command. */
export function buildSshCommandArgs(opts: SshOptions, command: string): string[] {
  return [...buildSshBaseArgs(opts), sshDestination(opts), command]
}

export interface SshCommandResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run one remote command and collect its output.
 *
 * The command is passed as a single argv token, so the remote login shell
 * interprets it; callers that interpolate values must quote them. Nothing is
 * inherited from stdin, because a GUI process has no terminal to read from and
 * a command that unexpectedly waits on stdin would look like a hang.
 */
export function runSshCommand(
  opts: SshOptions,
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SshCommandResult> {
  const args = buildSshCommandArgs(opts, command)
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: sshSpawnEnv() })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`ssh command timed out after ${String(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)}ms`))
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    options.signal?.addEventListener('abort', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new Error('ssh command aborted'))
    }, { once: true })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`could not run ssh: ${error.message}`))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export async function forwardSshTunnel(
  opts: SshOptions,
  log: (line: string) => void = () => undefined,
): Promise<SshTunnelHandle> {
  return forwardSshTunnelTo(opts, opts.remotePort ?? 3000, log)
}

/**
 * Forward a local loopback port to an explicit remote loopback port.
 *
 * Split from {@link forwardSshTunnel} because a provisioned instance only
 * learns the remote port after the harness has started, so the caller has it
 * before the tunnel exists rather than in configuration.
 */
export async function forwardSshTunnelTo(
  opts: SshOptions,
  remotePort: number,
  log: (line: string) => void = () => undefined,
): Promise<SshTunnelHandle> {
  const localPort = await findFreePort()
  const args = buildTunnelArgs(opts, localPort, remotePort)

  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: sshSpawnEnv() })
  let stderr = ''
  let refused = false
  log(`ssh ${args.join(' ')}`)
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
    for (const line of chunk.split('\n')) {
      const text = line.trimEnd()
      if (text === '') continue
      // A refused forward is refused per connection, so each retry adds another
      // identical line. Keep the first and drop the repeats: sixty copies of one
      // message is noise, and it buries everything else in the log.
      if (/Connection refused/iu.test(text)) {
        if (refused) continue
        refused = true
      }
      log(text)
    }
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => log(chunk))

  // Wait until the forwarded port answers, or the ssh child fails.
  const deadline = Date.now() + READY_TIMEOUT_MS
  const endpoint = `http://127.0.0.1:${String(localPort)}`
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let inFlight = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      fn()
    }
    const fail = (): void => {
      // A forward that bound successfully but cannot reach its target fails per
      // connection, not at startup, so ssh is still alive here and its stderr is
      // the only place the reason appears.
      const described = describeSshFailure(stderr, opts, remotePort)
      finish(() => {
        child.kill('SIGTERM')
        reject(new Error(described
          ?? `ssh tunnel: the forwarded port never became reachable on ${opts.host}. ssh stayed connected, `
            + `which usually means nothing is listening on 127.0.0.1:${String(remotePort)} there.`))
      })
    }

    const poll = setInterval(() => {
      if (settled) return
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = sshErrorTail(stderr)
        const described = describeSshFailure(stderr, opts, remotePort)
        finish(() => reject(new Error(described
          ?? `ssh tunnel exited (code ${String(child.exitCode)})${tail === '' ? '' : `:\n${tail}`}`)))
        return
      }
      // A refused forward will never become reachable, so waiting out the full
      // timeout only delays a message that is already in hand.
      if (refused || Date.now() > deadline) {
        fail()
        return
      }
      // One probe at a time, each individually bounded. Firing a fetch every tick
      // left several in flight against a dead forward, and every one of them
      // opened a new ssh channel.
      if (inFlight) return
      inFlight = true
      void fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        .then(() => finish(resolve))
        .catch(() => undefined)
        .finally(() => { inFlight = false })
    }, POLL_INTERVAL_MS)
  })

  return {
    localPort,
    endpoint,
    stop: () => stopChild(child),
    onExit: (cb) => void child.once('exit', cb),
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not determine a free loopback port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function stopChild(child: ChildProcess): Promise<void> {
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
