/**
 * SSH remote transport: `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`.
 * The remote dsh then appears as a loopback endpoint, which passes the dsh /api
 * trust fence and keeps every privileged method functional — the harness's
 * recommended remote posture.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { SshOptions } from '../../shared/instance.ts'

export interface SshTunnelHandle {
  localPort: number
  readonly endpoint: string
  stop(): Promise<void>
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

const READY_TIMEOUT_MS = 20_000

/** Build the ssh argv for one tunnel; exported for tests. */
export function buildSshArgs(opts: SshOptions, localPort: number): string[] {
  const remotePort = opts.remotePort ?? 3000
  const args: string[] = [
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', `StrictHostKeyChecking=${opts.strictHostKeyChecking ?? 'accept-new'}`,
    '-L', `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
  ]
  if (opts.port !== undefined) args.push('-p', String(opts.port))
  if (opts.identityFile !== undefined && opts.identityFile !== '') args.push('-i', opts.identityFile)
  args.push(opts.user !== undefined && opts.user !== '' ? `${opts.user}@${opts.host}` : opts.host)
  return args
}

export async function forwardSshTunnel(
  opts: SshOptions,
  log: (line: string) => void = () => undefined,
): Promise<SshTunnelHandle> {
  const localPort = await findFreePort()
  const args = buildSshArgs(opts, localPort)

  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
    log(chunk)
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => log(chunk))

  // Wait until the forwarded port answers, or the ssh child fails.
  const deadline = Date.now() + READY_TIMEOUT_MS
  const endpoint = `http://127.0.0.1:${String(localPort)}`
  await new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(poll)
        const tail = stderr.trim().split(/\r?\n/u).slice(-6).join('\n')
        reject(new Error(`ssh tunnel exited (code ${String(child.exitCode)})${tail === '' ? '' : `:\n${tail}`}`))
        return
      }
      if (Date.now() > deadline) {
        clearInterval(poll)
        child.kill('SIGTERM')
        reject(new Error('ssh tunnel: forwarded port never became reachable'))
        return
      }
      void fetch(endpoint, { method: 'HEAD' })
        .then(() => {
          clearInterval(poll)
          resolve()
        })
        .catch(() => undefined)
    }, 150)
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
