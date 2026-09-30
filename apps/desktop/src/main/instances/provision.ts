/**
 * Remote provisioning: ship this build's harness closure to a host, run it
 * there, and hand back the port to tunnel to.
 *
 * The rule this module exists to honor: **every remote runs our fork's build,
 * never a registry install.** The fork and upstream both publish as
 * `@deepseek-ai/dsh`, upstream is numerically ahead, and upstream has also
 * published the fork's exact version string, so `latest`, a caret range, and an
 * exact pin all resolve to upstream code. There is no npm specifier that
 * identifies the fork, and correspondingly no fallback here that could reach
 * one: a remote runs a closure this build staged, or the connect fails and says
 * why.
 *
 * Shape: detect, preflight, select, ship, launch; the caller then tunnels to the
 * port this returns. Connect and tunnel are separate ssh commands because the
 * tunnel needs the remote port, and the remote port only exists after the server
 * does.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { formatTarget, harnessCacheKey, parseTarget, targetsEqual } from '../../shared/harness-target.ts'
import type { StageTarget } from '../../shared/harness-target.ts'
import type { ProvisionOptions, SandboxOptions, SshOptions } from '../../shared/instance.ts'
import { SANDBOX_RELAY_PORT } from '../../shared/instance.ts'
import { buildRemoteSandboxCommand, parseDockerPort, resolveSandboxOptions } from './sandbox.ts'
import { ClosureNotFoundError, findClosures, selectClosure, type ClosureEntry } from './closure-catalog.ts'
import {
  buildDetectCommand,
  buildExtractCommand,
  buildLaunchCommand,
  parseDetectOutput,
  parseRemoteLogPort,
  remoteClosureDir,
  shellQuote,
  targetForFacts,
  type RemoteFacts,
} from './provision-parse.ts'
import { buildSshCommandArgs, runSshCommand, type SshCommandResult } from './ssh.ts'

/** Default remote parent directory for shipped closures, relative to `$HOME`. */
export const DEFAULT_REMOTE_ROOT = '.dsh-desktop/harness'
const MIN_FREE_KB = 600 * 1024
/** How long to wait for the remote server's readiness line. */
const READY_TIMEOUT_MS = 60_000
/** How long one file transfer may take before it is abandoned. */
const SHIP_TIMEOUT_MS = 10 * 60_000
/** How long a short probe command may take. */
const PROBE_TIMEOUT_MS = 30_000

/** What a completed sandboxed provisioning run produced. */
export interface SandboxProvisionResult {
  /** Remote loopback port the container's relay publishes. */
  remotePort: number
  /** The image the remote is running. */
  image: string
}

/** How long a sandboxed remote launch (including the image pull) may take. */
const SANDBOX_LAUNCH_TIMEOUT_MS = 20 * 60_000

/** What a completed provisioning run produced. */
export interface ProvisionResult {
  /** Remote loopback port the harness is listening on. */
  remotePort: number
  /** Cache key of the closure that was shipped or reused. */
  closureKey: string
  /** Harness revision now running on the remote. */
  revision: string
  /** Target the closure was built for. */
  target: StageTarget
  /** Remote directory holding the closure. */
  remoteDir: string
  /** True when a server was already running and this run adopted it. */
  reused: boolean
}

/** A refusal that names the real cause, so the UI can show it verbatim. */
export class ProvisionRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionRefusedError'
  }
}

/** Shipping transport, injectable so tests never open an ssh connection. */
export type ShipTransport = (
  opts: SshOptions,
  extractCommand: string,
  source: (stdin: NodeJS.WritableStream) => Promise<void>,
  log: (line: string) => void,
) => Promise<void>

export interface ProvisionerDeps {
  /** Resources directory holding the staged closures. */
  resourcesDir: string
  /** Progress log, wired to the instance's capped log buffer. */
  log: (line: string) => void
  /** Override for tests. */
  runCommand?: typeof runSshCommand
  /** Override for tests. */
  ship?: ShipTransport
}

/**
 * Provision the harness onto one host.
 *
 * Phases are logged as they happen rather than only on failure: the transfer is
 * the long part, and a silent minute reads as a hang.
 */
export class RemoteProvisioner {
  private readonly deps: ProvisionerDeps

  constructor(deps: ProvisionerDeps) {
    this.deps = deps
  }

  private run(opts: SshOptions, command: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<SshCommandResult> {
    const runner = this.deps.runCommand ?? runSshCommand
    return runner(opts, command, { timeoutMs })
  }

  /** Detect the remote target, or explain why it cannot be used. */
  async detect(
    opts: SshOptions,
    provision: ProvisionOptions,
  ): Promise<{ facts: RemoteFacts; target: StageTarget; root: string }> {
    const configuredRoot = provision.remoteRoot !== undefined && provision.remoteRoot !== ''
      ? provision.remoteRoot
      : DEFAULT_REMOTE_ROOT
    // A relative remote root resolves against $HOME on the far side; the probe
    // reports $HOME so the resolved path can be computed here.
    const probeRoot = configuredRoot.startsWith('/') ? configuredRoot : `$HOME/${configuredRoot}`
    this.deps.log('detecting remote host')
    const result = await this.run(opts, buildDetectCommand(probeRoot))

    if (result.code !== 0 && result.stdout.trim() === '') {
      // BatchMode means ssh never prompts, so a missing key arrives as an exit
      // code rather than as a prompt the user cannot see.
      const detail = lastLines(result.stderr, 3)
      throw new ProvisionRefusedError(
        `could not run a command on ${opts.host} over ssh${detail === '' ? '' : `: ${detail}`}. `
        + 'Provisioning needs key-based authentication: ssh runs in BatchMode and cannot prompt for a password.',
      )
    }

    const facts = parseDetectOutput(result.stdout)
    if (facts === undefined) {
      throw new ProvisionRefusedError(
        `could not read the platform of ${opts.host} from \`uname\`. `
        + `Reported: ${JSON.stringify(lastLines(result.stdout, 4))}`,
      )
    }

    const detected = targetForFacts(facts)
    if (facts.platform === 'linux' && facts.libc === 'musl') {
      throw new ProvisionRefusedError(
        `${opts.host} runs musl (${facts.osName ?? 'unknown distribution'}). The native addons in this harness `
        + 'closure are built against glibc and no musl closure is staged, so the harness cannot run there. '
        + 'Use a glibc distribution such as Debian, Ubuntu, or RHEL.',
      )
    }

    let target = detected
    if (provision.target !== undefined && provision.target !== '') {
      try {
        target = parseTarget(provision.target)
      } catch (error) {
        throw new ProvisionRefusedError(error instanceof Error ? error.message : String(error))
      }
      if (!targetsEqual(target, detected)) {
        throw new ProvisionRefusedError(
          `the configured target ${formatTarget(target)} does not match ${opts.host}, which reports ${formatTarget(detected)}.`,
        )
      }
    }

    const root = facts.home !== undefined && !configuredRoot.startsWith('/')
      ? `${facts.home.replace(/\/+$/u, '')}/${configuredRoot}`
      : configuredRoot
    return { facts, target, root }
  }

  /** Every refusal that can be decided before anything is shipped. */
  preflight(facts: RemoteFacts, opts: SshOptions): void {
    if (facts.homeWritable !== true) {
      throw new ProvisionRefusedError(
        `${facts.writableTarget ?? 'the closure directory'} is not writable on ${opts.host}. `
        + 'Set a different remote root in the instance configuration, or fix permissions there.',
      )
    }
    if (facts.freeKb !== undefined && facts.freeKb < MIN_FREE_KB) {
      throw new ProvisionRefusedError(
        `${opts.host} has ${String(Math.round(facts.freeKb / 1024))}MB free, and a harness closure needs about 300MB.`,
      )
    }
  }

  /**
   * The closure this build will ship for one target.
   *
   * The wanted key comes from the closure this build itself runs, so a revision
   * difference between what the app carries and what it has staged shows up as a
   * cache miss rather than as a silent mis-ship.
   */
  selectClosure(target: StageTarget): ClosureEntry {
    const entries = findClosures(this.deps.resourcesDir)
    if (entries.length === 0) {
      throw new ProvisionRefusedError(
        `this build carries no staged harness closure in ${this.deps.resourcesDir}. `
        + 'Run `pnpm stage:harness` to produce one.',
      )
    }
    const reference = entries.find((entry) => entry.meta.platform === process.platform
      && entry.meta.arch === process.arch) ?? entries[0]
    const wanted = {
      key: harnessCacheKey(reference?.meta.version ?? '', reference?.meta.revision ?? '', target, reference?.meta.runtimeVersion),
      target,
    }
    try {
      return selectClosure(entries, wanted)
    } catch (error) {
      if (error instanceof ClosureNotFoundError) {
        throw new ProvisionRefusedError(
          `${error.message}. Available: ${error.available.join(', ') || 'none'}`,
        )
      }
      throw error
    }
  }

  /**
   * Ship a closure unless the remote already holds this exact key.
   *
   * The remote directory is the cache: a directory exists under its key only
   * because a completed extraction renamed it there, so its presence is the hit
   * signal and no separate manifest is needed.
   */
  async ensureShipped(opts: SshOptions, entry: ClosureEntry, remoteDir: string): Promise<boolean> {
    if (entry.meta.runtimeVersion === undefined || !existsSync(`${entry.root}/bin/node`)) {
      throw new ProvisionRefusedError('the staged harness has no bundled Node runtime; rerun pnpm stage:harness for this target')
    }
    if (await this.hasClosure(opts, remoteDir)) {
      this.deps.log(`closure ${entry.key} is already on the host`)
      return false
    }

    const megabytes = Math.round(closureKilobytes(entry.root) / 1024)
    this.deps.log(`shipping ${entry.key} (${String(megabytes)}MB on disk) to ${remoteDir}`)
    const ship = this.deps.ship ?? shipOverSsh
    await ship(
      opts,
      buildExtractCommand(`${remoteDir}.tmp`, remoteDir),
      (stdin) => pipeClosure(entry.root, stdin),
      this.deps.log,
    )

    // Verify rather than assume. A populated directory that is missing its CLI
    // entry is exactly the half-transfer this design must never cache.
    if (!(await this.hasClosure(opts, remoteDir))) {
      throw new ProvisionRefusedError(
        `the closure did not arrive intact on ${opts.host}: ${remoteDir} is missing its CLI, metadata, or executable Node runtime. `
        + 'A partial transfer is never left under the closure key, so the next connect will retry.',
      )
    }
    this.deps.log('closure shipped and verified')
    return true
  }

  /** Whether a complete closure is present at one remote directory. */
  private async hasClosure(opts: SshOptions, remoteDir: string): Promise<boolean> {
    const result = await this.run(
      opts,
      `test -f ${shellQuote(`${remoteDir}/lib/bin.js`)} && test -f ${shellQuote(`${remoteDir}/harness-meta.json`)} && test -x ${shellQuote(`${remoteDir}/bin/node`)} && echo present || echo absent`,
    )
    return result.stdout.includes('present')
  }

  /**
   * Start the harness on the remote, or adopt the one already running.
   *
   * A live server for the same key is reused, because every extra server costs
   * a port and a process the user cannot see. The PID file the launcher writes
   * is what makes "still running" checkable, and the log line is what makes its
   * port knowable.
   */
  async launch(
    opts: SshOptions,
    remoteDir: string,
    nodePath: string,
  ): Promise<{ remotePort: number; reused: boolean }> {
    const logPath = `${remoteDir}/dsh.log`
    const pidPath = `${remoteDir}/dsh.pid`

    const existing = await this.livePort(opts, pidPath, logPath)
    if (existing !== undefined) {
      this.deps.log(`reusing the harness already running on port ${String(existing)}`)
      return { remotePort: existing, reused: true }
    }

    this.deps.log('starting the remote harness')
    const launch = buildLaunchCommand({ closureDir: remoteDir, nodePath, logPath, pidPath })
    // Fire and forget. The remote shell waits on its background child, so this
    // call does not return promptly; readiness is discovered by polling instead,
    // which is the shape the port discovery needs anyway.
    await this.run(opts, launch, 15_000).catch(() => undefined)

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(500)
      const port = await this.livePort(opts, pidPath, logPath)
      if (port !== undefined) return { remotePort: port, reused: false }
      const dead = await this.isDead(opts, pidPath)
      if (dead) {
        const tail = await this.run(opts, `tail -20 ${shellQuote(logPath)} 2>/dev/null || echo "(no log)"`).catch(() => undefined)
        throw new ProvisionRefusedError(
          `the harness exited immediately on ${opts.host}:\n${tail?.stdout ?? '(log unreadable)'}`,
        )
      }
    }
    throw new ProvisionRefusedError(
      `the harness started on ${opts.host} but reported no URL within ${String(READY_TIMEOUT_MS / 1000)}s.`,
    )
  }

  /** The port of a live remote server, or undefined when none is running. */
  private async livePort(opts: SshOptions, pidPath: string, logPath: string): Promise<number | undefined> {
    const probe = await this.run(
      opts,
      `pid=$(cat ${shellQuote(pidPath)} 2>/dev/null); `
      + 'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then '
      + `sed -n 's/.*dsh web: http:\\/\\/\\(127\\.0\\.0\\.1\\|localhost\\):\\([0-9]*\\).*/\\2/p' ${shellQuote(logPath)} 2>/dev/null | head -1; `
      + 'fi',
    ).catch(() => undefined)
    if (probe === undefined) return undefined
    // The port alone comes back; wrap it in the readiness shape to reuse one
    // parser, so the local and remote paths cannot disagree about the format.
    return parseRemoteLogPort(`dsh web: http://127.0.0.1:${probe.stdout.trim()}`)
  }

  /** Whether the recorded PID is gone. Unknown counts as alive, so a flaky
   * probe cannot turn into a false "it crashed" report. */
  private async isDead(opts: SshOptions, pidPath: string): Promise<boolean> {
    const result = await this.run(
      opts,
      `pid=$(cat ${shellQuote(pidPath)} 2>/dev/null); `
      + 'if [ -z "$pid" ]; then echo unknown; '
      + 'elif kill -0 "$pid" 2>/dev/null; then echo alive; else echo dead; fi',
    ).catch(() => undefined)
    return result?.stdout.trim() === 'dead'
  }

  /** Stop (and remove) the remote sandbox container; gone is success. */
  async stopRemoteSandbox(opts: SshOptions, name: string): Promise<void> {
    await this.run(opts, `docker rm -f ${shellQuote(name)} >/dev/null 2>&1; echo stopped`).catch(() => undefined)
    this.deps.log('remote sandbox container removed')
  }

  /** Stop a running remote server and confirm it is gone. */
  async stopRemote(opts: SshOptions, remoteDir: string): Promise<void> {
    const pidPath = `${remoteDir}/dsh.pid`
    const result = await this.run(
      opts,
      `pid=$(cat ${shellQuote(pidPath)} 2>/dev/null); `
      + 'if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; '
      + 'for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done; '
      + 'kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; fi; '
      + `rm -f ${shellQuote(pidPath)}; echo stopped`,
    ).catch(() => undefined)
    if (result?.stdout.includes('stopped') !== true) {
      this.deps.log('stop remote server: could not confirm the remote stopped')
      return
    }
    this.deps.log('remote harness stopped')
  }

  /** Remove the closure from the host, after stopping any server using it. */
  async uninstall(opts: SshOptions, remoteDir: string): Promise<void> {
    await this.stopRemote(opts, remoteDir)
    const result = await this.run(
      opts,
      `rm -rf ${shellQuote(remoteDir)} ${shellQuote(`${remoteDir}.tmp`)}; `
      + `test -e ${shellQuote(remoteDir)} && echo remaining || echo removed`,
    ).catch(() => undefined)
    if (result?.stdout.includes('removed') !== true) {
      throw new ProvisionRefusedError(`could not remove ${remoteDir} from ${opts.host}.`)
    }
    this.deps.log(`removed ${remoteDir} from the host`)
  }

  /** Full run: detect, preflight, select, ship, launch. */
  async prepare(opts: SshOptions, provision: ProvisionOptions): Promise<ProvisionResult> {
    const { facts, target, root } = await this.detect(opts, provision)
    const runtime = [
      formatTarget(target),
      facts.osName,
      facts.nodeVersion === undefined ? undefined : `node ${facts.nodeVersion}`,
      facts.libcVersion === undefined ? undefined : `glibc ${facts.libcVersion}`,
    ].filter((part): part is string => part !== undefined && part !== '')
    this.deps.log(`remote: ${runtime.join(', ')}`)
    this.preflight(facts, opts)

    const entry = this.selectClosure(target)
    const remoteDir = remoteClosureDir(root, entry.key)
    this.deps.log(`closure ${entry.key} (revision ${entry.meta.revision ?? 'unknown'})`)

    await this.ensureShipped(opts, entry, remoteDir)
    const nodePath = provision.nodePath !== undefined && provision.nodePath !== ''
      ? provision.nodePath
      : `${remoteDir}/bin/node`
    const { remotePort, reused } = await this.launch(opts, remoteDir, nodePath)
    this.deps.log(`remote harness listening on 127.0.0.1:${String(remotePort)}`)

    return {
      remotePort,
      closureKey: entry.key,
      revision: entry.meta.revision ?? 'unknown',
      target,
      remoteDir,
      reused,
    }
  }

  /**
   * Sandboxed provisioning: run the harness in a container on the remote.
   *
   * Everything ships inside the image, so the closure stages (detect, select,
   * ship) are all skipped — what remains is a docker preflight and a launch.
   * The relay inside the container publishes to the remote's loopback, and the
   * caller tunnels to that published port exactly as it tunnels to a bare
   * harness port, so the trust fence needs no new work.
   */
  async prepareSandboxed(
    opts: SshOptions,
    sandbox: SandboxOptions,
    identity: { containerName: string; dshHomeRoot: string },
  ): Promise<SandboxProvisionResult> {
    this.deps.log('preflight: checking for docker on the remote')
    const probe = await this.run(opts, 'command -v docker >/dev/null 2>&1 && echo ok || echo missing')
    if (probe.stdout.includes('missing')) {
      throw new ProvisionRefusedError(
        `${opts.host} has no \`docker\` on PATH. A sandboxed remote runs the harness in a container, `
        + 'which needs a working container runtime on the remote itself. '
        + 'Turn off sandboxing for this instance to ship the closure and run it directly instead.',
      )
    }
    const resolved = resolveSandboxOptions(sandbox)
    const remoteDshHome = `${identity.dshHomeRoot}/${identity.containerName}/dsh-home`
    this.deps.log(`launching the sandbox container (${resolved.image}) on the remote`)
    const command = buildRemoteSandboxCommand({
      name: identity.containerName,
      image: resolved.image,
      remoteDshHome,
      runArgs: resolved.runArgs,
      outboundNetwork: resolved.outboundNetwork,
      mounts: resolved.mounts,
    })
    const result = await this.run(opts, command, SANDBOX_LAUNCH_TIMEOUT_MS)
    const remotePort = parseDockerPort(result.stdout, SANDBOX_RELAY_PORT)
    if (remotePort === undefined) {
      throw new ProvisionRefusedError(
        `the sandbox container started on ${opts.host}, but no published relay port came back:\n${lastLines(result.stdout, 4)}`,
      )
    }
    this.deps.log(`remote sandbox listening on 127.0.0.1:${String(remotePort)}`)
    return { remotePort, image: resolved.image }
  }

}

/** Last `count` non-empty lines, joined for one-line error messages. */
function lastLines(text: string, count: number): string {
  return text.trim().split(/\r?\n/u).filter((line) => line !== '').slice(-count).join('; ')
}

/**
 * macOS tar chatter that is not a problem worth showing.
 *
 * A tarball streamed to stdout carries the source files' extended attributes,
 * which a Linux tar has no place to put, so it warns about each one. GNU tar
 * writes those warnings across several small writes, so a reader that splits
 * per chunk sees fragments like a bare `tar:` with no keyword in them; matching
 * on the whole warning text alone lets those fragments through and the log
 * fills with lines that look like errors.
 */
function isTarNoise(line: string): boolean {
  return /unknown extended header keyword/iu.test(line)
    || /LIBARCHIVE\.xattr/iu.test(line)
    || /^tar:\s*$/u.test(line)
}

/**
 * Disk the closure occupies, in kilobytes, counted the way `du` counts it.
 *
 * Logical file sizes understate this badly: the closure is 28k small files, so
 * its 165MB of content occupies 241MB of blocks. `df` on the remote reports
 * blocks too, so comparing the two only makes sense in the same units — the
 * first shipped version of this reported 165MB while `df` saw 241MB consumed.
 */
function closureKilobytes(root: string): number {
  let kilobytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) stack.push(path)
      // `blocks` is in 512-byte units, and st_blocks is the same figure `du`
      // uses, so this matches what the remote's `df` will report as consumed.
      else if (entry.isFile()) kilobytes += (statSync(path).blocks * 512) / 1024
    }
  }
  return kilobytes
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Stream a closure into an ssh stdin as a gzipped tar.
 *
 * The exclusions are load-bearing on macOS: without them tar emits AppleDouble
 * `._*` sidecar files, they land in the remote temp directory, and the rename
 * that proves the temp directory emptied fails. A directory that is populated
 * but is not a valid closure is exactly what must never be cached.
 */
export function pipeClosure(
  root: string,
  stdin: NodeJS.WritableStream,
  log: (line: string) => void = () => undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const separator = root.lastIndexOf('/')
    const parent = separator <= 0 ? '/' : root.slice(0, separator)
    const base = root.slice(separator + 1)
    const tar = spawn('tar', ['-czf', '-', '--exclude=._*', '--exclude=.DS_Store', base], {
      cwd: parent,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    })
    tar.stdout.pipe(stdin)
    tar.stderr?.setEncoding('utf8')
    tar.stderr?.on('data', (chunk: string) => log(chunk))
    tar.once('error', reject)
    tar.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new ProvisionRefusedError(`tar failed with code ${String(code)}`))
    })
  })
}

/**
 * Default transport: `tar cz | ssh host '<extract>'`.
 *
 * Extraction and rename happen in the same remote shell that receives the
 * stream, so a transfer that dies partway leaves nothing under the closure key.
 */
export const shipOverSsh: ShipTransport = async (opts, extractCommand, source, log) => {
  const args = buildSshCommandArgs(opts, extractCommand)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new ProvisionRefusedError(`the transfer to ${opts.host} did not finish within ${String(SHIP_TIMEOUT_MS / 60_000)} minutes`))
    }, SHIP_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') log(line.trimEnd())
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      for (const line of chunk.split('\n')) {
        const text = line.trimEnd()
        if (text === '' || isTarNoise(text)) continue
        log(text)
      }
    })

    void source(child.stdin as NodeJS.WritableStream)
      .catch((error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        // Closing stdin is what lets the remote tar see end-of-stream.
        child.stdin?.end()
      })

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
      if (code === 0 && stdout.includes('extracted')) resolve()
      else reject(new ProvisionRefusedError(
        `the transfer to ${opts.host} failed (ssh exit ${String(code)})${lastLines(stderr, 3) === '' ? '' : `: ${lastLines(stderr, 3)}`}`,
      ))
    })
  })
}
