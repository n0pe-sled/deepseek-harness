/**
 * Pure helpers for remote provisioning: parsing what a remote host reports, and
 * building the shell commands that run there.
 *
 * Kept apart from provision.ts so they can be tested without a host. Every
 * parse here reads output that a real command produced, and each corresponds to
 * a failure that would otherwise be silent: an architecture read as the wrong
 * string stages a closure whose native addons cannot load, and that surfaces as
 * a boot crash on the remote rather than as a wrong answer here.
 */
import { parseTarget, type StageTarget } from '../../shared/harness-target.ts'

/** What `uname -sm` and the OS probe reported about a remote host. */
export interface RemoteFacts {
  platform: 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  /** `glibc` or `musl` on linux; undefined elsewhere. */
  libc?: 'glibc' | 'musl'
  /** glibc version when the host reports one, e.g. `2.41`. */
  libcVersion?: string
  osName?: string
  /** `node --version`, or undefined when node is absent. */
  nodeVersion?: string
  /** Free kilobytes on the filesystem that holds the remote root. */
  freeKb?: number
  /** Whether the closure's directory (or its nearest existing parent) is writable. */
  homeWritable?: boolean
  /** The directory writability was judged on, for a precise refusal message. */
  writableTarget?: string
  /** Shell-style `$HOME` as the remote reports it. */
  home?: string
}

/** Translate `uname -m` into the architecture token the registry uses. */
export function parseUnameArch(machine: string): 'x64' | 'arm64' | undefined {
  switch (machine.trim().toLowerCase()) {
    case 'x86_64':
    case 'amd64':
      return 'x64'
    case 'aarch64':
    case 'arm64':
      return 'arm64'
    default:
      return undefined
  }
}

/** Translate `uname -s` into a platform token, or undefined when unsupported. */
export function parseUnamePlatform(system: string): 'linux' | 'darwin' | undefined {
  switch (system.trim().toLowerCase()) {
    case 'linux':
      return 'linux'
    case 'darwin':
      return 'darwin'
    default:
      return undefined
  }
}

/**
 * The stage target a set of remote facts requires.
 *
 * A host without a Node install still has a perfectly good target, so node is
 * not part of this. Musl is: a glibc closure's native addons fail to load there,
 * and choosing musl would require musl builds this app does not stage, so the
 * caller refuses rather than shipping something broken.
 */
export function targetForFacts(facts: RemoteFacts): StageTarget {
  if (facts.platform === 'linux') {
    return { platform: 'linux', arch: facts.arch, libc: facts.libc ?? 'glibc' }
  }
  return { platform: facts.platform, arch: facts.arch }
}

/** The glibc major-minor of an `ldd --version` line, e.g. `2.41`. */
export function parseGlibcVersion(lddOutput: string): string | undefined {
  const match = /(\d+)\.(\d+)/u.exec(lddOutput)
  return match === null ? undefined : `${match[1]}.${match[2]}`
}

/** Quote one value for a POSIX shell, so a path with spaces survives. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * The one-shot probe that gathers {@link RemoteFacts}.
 *
 * A single round trip, because each ssh command costs a handshake and this runs
 * on every connect. Every field is optional in the output: a host with no node,
 * or a `df` that fails, must still produce a usable answer for the fields that
 * did work rather than failing the whole probe.
 */
export function buildDetectCommand(remoteRoot: string): string {
  const parent = shellQuote(posixDirname(remoteRoot))
  return [
    'set +e',
    'echo "platform=$(uname -s)"',
    'echo "arch=$(uname -m)"',
    'echo "home=$HOME"',
    // `ldd --version` is glibc's; alpine's busybox ldd prints a musl banner, and
    // a host with neither is treated as glibc (the common case) rather than
    // guessed at.
    'echo "ldd=$( (ldd --version 2>&1 || true) | head -1)"',
    'echo "musl=$( (ls /lib/ld-musl-* 2>/dev/null | head -1) )"',
    'echo "os=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo unknown )"',
    'echo "node=$( (node --version 2>/dev/null) || echo none )"',
    `echo "free_kb=$( (df -Pk ${parent} 2>/dev/null || df -Pk "$HOME" 2>/dev/null || df -Pk /) | awk 'NR==2{print $4}' )"`,
    // Writability is probed by doing it: `test -w` answers about permissions,
    // not about whether the directory accepts entries, so it says yes for /proc
    // and for anything a root user can see, and an unwritable target then only
    // failed much later as a transfer error. Climb to the nearest directory that
    // exists, try to create the chain there, and clean it up.
    `target=$(dirname ${parent}); while [ ! -d "$target" ] && [ "$target" != / ] && [ "$target" != . ]; do target=$(dirname "$target"); done`,
    'if ( mkdir -p "$target/.__dsh_probe" && rmdir "$target/.__dsh_probe" ) 2>/dev/null; then echo "writable=yes"; else echo "writable=no"; fi',
    'echo "target=$target"',
  ].join('; ')
}

/**
 * Parse the probe's `key=value` lines.
 *
 * Values are taken verbatim to end of line: an OS pretty name contains spaces
 * and parentheses, so splitting on whitespace would truncate it.
 */
export function parseDetectOutput(output: string): RemoteFacts | undefined {
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([a-z_]+)=(.*)$/u.exec(line)
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined) values.set(key, value)
  }
  const platform = parseUnamePlatform(values.get('platform') ?? '')
  const arch = parseUnameArch(values.get('arch') ?? '')
  if (platform === undefined || arch === undefined) return undefined

  const facts: RemoteFacts = { platform, arch }
  if (platform === 'linux') {
    const muslLoader = (values.get('musl') ?? '').trim()
    const ldd = values.get('ldd') ?? ''
    // A musl loader present at the usual path is stronger evidence than an ldd
    // banner, because a glibc distribution can have both installed.
    if (muslLoader !== '' && !/glibc|GNU C Library|Debian GLIBC/iu.test(ldd)) {
      facts.libc = 'musl'
    } else {
      facts.libc = 'glibc'
      const version = parseGlibcVersion(ldd)
      if (version !== undefined) facts.libcVersion = version
    }
  }
  const osName = (values.get('os') ?? '').trim()
  if (osName !== '') facts.osName = osName
  const home = (values.get('home') ?? '').trim()
  if (home !== '') facts.home = home
  const writableTarget = (values.get('target') ?? '').trim()
  if (writableTarget !== '') facts.writableTarget = writableTarget
  const node = (values.get('node') ?? '').trim()
  if (node !== '' && node !== 'none') facts.nodeVersion = node
  const freeKb = Number.parseInt((values.get('free_kb') ?? '').trim(), 10)
  if (Number.isSafeInteger(freeKb)) facts.freeKb = freeKb
  facts.homeWritable = (values.get('writable') ?? '').trim() === 'yes'
  return facts
}

/** POSIX `dirname` for a remote path, without importing node:path semantics. */
export function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : '.'
  return trimmed.slice(0, index)
}

/**
 * The remote directory name for one closure key, under the configured root.
 *
 * The key is the cache identity, so two revisions or two targets never collide
 * and a reconnect finds the same directory it shipped.
 */
export function remoteClosureDir(remoteRoot: string, key: string): string {
  return `${remoteRoot.replace(/\/+$/u, '')}/${key}`
}

/**
 * Extract a streamed tarball into a temporary directory and rename it into
 * place only once extraction succeeded.
 *
 * The temp-then-rename is the whole point: a transfer that dies midway leaves a
 * populated directory, and a populated directory under the final name is
 * indistinguishable from a valid cached closure on the next connect. The
 * failure would then look like a boot crash in the harness rather than a
 * truncated transfer.
 *
 * `--strip-components=1` because the local tarball is rooted at the closure
 * directory's own name.
 */
export function buildExtractCommand(tmpDir: string, finalDir: string): string {
  const tmp = shellQuote(tmpDir)
  const final = shellQuote(finalDir)
  return [
    'set -e',
    `rm -rf ${tmp} ${final}`,
    `mkdir -p ${tmp}`,
    'tar xzf - -C ' + tmp + ' --strip-components=1',
    // Cache entries require the CLI, metadata, and executable runtime.
    `test -f ${tmp}/lib/bin.js || { echo "closure is missing lib/bin.js" >&2; exit 1; }`,
    `test -f ${tmp}/harness-meta.json || { echo "closure is missing harness-meta.json" >&2; exit 1; }`,
    `test -x ${tmp}/bin/node || { echo "closure is missing executable bin/node" >&2; exit 1; }`,
    `mv ${tmp} ${final}`,
    `echo extracted`,
  ].join('; ')
}

/**
 * Launch the harness detached from the ssh session.
 *
 * Detaching is not cosmetic. A plain `nohup cmd &` over ssh leaves a process
 * that dies with the connection: the log shows a readiness line and the process
 * is gone moments later. `setsid` in a subshell with all three streams
 * redirected away is what survives, and the redirect matters because a stream
 * left attached to the ssh channel keeps the channel open, which makes the
 * launch call appear to hang instead of returning.
 */
export function buildLaunchCommand(opts: {
  closureDir: string
  nodePath: string
  logPath: string
  pidPath: string
}): string {
  const dir = shellQuote(opts.closureDir)
  const node = shellQuote(opts.nodePath)
  const log = shellQuote(opts.logPath)
  const pid = shellQuote(opts.pidPath)
  const script = `export PATH=${shellQuote(`${opts.closureDir}/bin`)}:"$PATH"; echo $$ > ${pid}; exec ${node} lib/bin.js web --port 0 --no-open`
  return [
    `cd ${dir} && setsid sh -c ${shellQuote(script)} >${log} 2>&1 </dev/null &`,
    'echo launched',
  ].join('\n')
}

/**
 * Seed the remote home from the closure's own seeder, before the harness runs.
 *
 * The closure carries `seed-home.mjs`, which the app also uses for a local
 * instance, so one implementation decides whether a profile manifest may be
 * rewritten and whether a skill entry may be replaced. It is read from the closure
 * rather than written over ssh because it sits there whatever the shell can do, and
 * the remote Node runtime runs it because a remote needs no Node install of its own.
 *
 * The home is left to the remote's own resolution: `dsh` reads `$DSH_HOME` else
 * `$HOME/.dsh`, so `HOME` is passed to the script and the remote resolves it.
 *
 * @param opts - the closure directory and the executable Node runtime inside it.
 * @returns the command a remote shell runs to seed its own home.
 */
export function buildSeedCommand(opts: { closureDir: string; nodePath: string }): string {
  const node = shellQuote(opts.nodePath)
  const script = shellQuote(`${opts.closureDir}/seed-home.mjs`)
  return [
    'set -e',
    `home=\${DSH_HOME:-$HOME/.dsh}`,
    `DSH_HOME="$home" ${node} ${script} "$home" ${shellQuote(opts.closureDir)}`,
  ].join('; ')
}

/** Read the readiness port out of a remote log, or undefined when not yet up. */
export function parseRemoteLogPort(logText: string): number | undefined {
  const raw = /dsh web: http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/u.exec(logText)?.[1]
  if (raw === undefined) return undefined
  const port = Number.parseInt(raw, 10)
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** Read a PID file's contents, or undefined when absent or not a PID. */
export function parsePidFile(text: string): number | undefined {
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}
