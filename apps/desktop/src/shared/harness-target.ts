/**
 * Target platforms a harness closure can be staged for and shipped to.
 *
 * A closure is only portable within one platform/arch/libc triple: koffi, sharp
 * and node-addon-require-builtin each publish per-platform native packages, and
 * a closure that carries the wrong one fails at native load on the remote. So
 * the triple is a first-class value here rather than a string built at each call
 * site, and it feeds three things that must agree: what `pnpm` resolves, what
 * `harness-meta.json` records, and the cache key the provisioner looks up.
 *
 * Pure functions only — this module is imported by both the Electron main
 * process and `scripts/stage-harness.mjs`, so it must not touch the filesystem.
 */

import { arch as hostArch, platform as hostPlatform } from 'node:process'

export type LibcFlavor = 'glibc' | 'musl'
export type TargetPlatform = 'darwin' | 'linux' | 'win32'
export type TargetArch = 'arm64' | 'x64'

export interface StageTarget {
  platform: TargetPlatform
  arch: TargetArch
  /**
   * Which C library the target's native addons link against. Only meaningful on
   * linux; `undefined` everywhere else, because darwin and win32 have exactly
   * one answer and pretending otherwise invites a bogus third axis.
   */
  libc?: LibcFlavor
}

const PLATFORMS: readonly string[] = ['darwin', 'linux', 'win32']
const ARCHES: readonly string[] = ['arm64', 'x64']
const LIBCS: readonly string[] = ['glibc', 'musl']

/** Accepts the spellings pnpm, uname and Node each use for the same target. */
function normalizePlatform(raw: string): TargetPlatform {
  const value = raw.toLowerCase()
  if (value === 'macos' || value === 'mac' || value === 'osx' || value === 'darwin') return 'darwin'
  if (value === 'windows' || value === 'win32' || value === 'win') return 'win32'
  if (value === 'linux') return 'linux'
  throw new Error(`unknown target platform: ${raw}`)
}

function normalizeArch(raw: string): TargetArch {
  const value = raw.toLowerCase()
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'x64'
  throw new Error(`unknown target architecture: ${raw}`)
}

function normalizeLibc(raw: string): LibcFlavor {
  const value = raw.toLowerCase()
  if (value === 'glibc' || value === 'gnu' || value === 'libc') return 'glibc'
  if (value === 'musl') return 'musl'
  throw new Error(`unknown target libc: ${raw}`)
}

/**
 * Parse `platform-arch[-libc]`, the spelling used on the command line and in
 * cache keys. `linux-x64-glibc` is the common remote; `darwin-arm64` is this
 * machine. Omitted libc on linux means glibc, which is the honest default for
 * Debian/Ubuntu/RHEL targets.
 */
export function parseTarget(triple: string): StageTarget {
  const parts = triple.split('-').filter((p) => p !== '')
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`target must look like platform-arch[-libc], got: ${triple}`)
  }
  const [platformPart, archPart, libcPart] = parts
  if (platformPart === undefined || archPart === undefined) {
    throw new Error(`target must look like platform-arch[-libc], got: ${triple}`)
  }
  const platform = normalizePlatform(platformPart)
  const arch = normalizeArch(archPart)
  if (libcPart !== undefined) {
    const libc = normalizeLibc(libcPart)
    if (platform !== 'linux') {
      throw new Error(`libc only applies to linux targets, got: ${triple}`)
    }
    return { platform, arch, libc }
  }
  return platform === 'linux' ? { platform, arch, libc: 'glibc' } : { platform, arch }
}

/** The canonical, round-trippable spelling of a target. */
export function formatTarget(target: StageTarget): string {
  const base = `${target.platform}-${target.arch}`
  return target.platform === 'linux' ? `${base}-${target.libc ?? 'glibc'}` : base
}

/** The machine this app is running on, as a stage target. */
export function hostTarget(): StageTarget {
  return parseTarget(`${hostPlatform}-${hostArch}`)
}

export function targetsEqual(a: StageTarget, b: StageTarget): boolean {
  if (a.platform !== b.platform || a.arch !== b.arch) return false
  if (a.platform !== 'linux') return true
  return (a.libc ?? 'glibc') === (b.libc ?? 'glibc')
}

/**
 * Identity of one staged closure. The provisioner ships and caches by this key,
 * so it must change whenever the bytes would: a new harness revision, or a
 * different native build.
 */
export function harnessCacheKey(version: string, revision: string, target: StageTarget, runtimeVersion?: string): string {
  return `${version}-${revision}-${formatTarget(target)}${runtimeVersion === undefined ? '' : `-node-${runtimeVersion}`}`
}

/** Native packages whose platform is spelled into the package name itself. */
const PLATFORM_PACKAGE_FAMILIES: readonly string[] = [
  '@koromix/koffi-',
  '@img/sharp-',
  '@img/sharp-libvips-',
  'node-addon-require-builtin-',
  '@vscode/ripgrep-',
  '@esbuild/',
  'lefthook-',
  '@rollup/rollup-',
]

/** node-pty names its prebuild directories the same way, as one flat token. */
const PLATFORM_DIRECTORY_FAMILIES: readonly string[] = ['darwin-', 'linux-', 'win32-']

interface PlatformTokens {
  platform: TargetPlatform
  arch: TargetArch
  libc?: LibcFlavor
}

/**
 * Read a platform suffix such as `linux-x64-gnu`, `linuxmusl-x64`,
 * `darwin-arm64` or `win32-x64-msvc`. Returns undefined when the string is not
 * platform-shaped, which is the signal that a package is not platform-specific
 * and must be left alone.
 */
function parsePlatformSuffix(raw: string): PlatformTokens | undefined {
  const tokens = raw.toLowerCase().split('-').filter((t) => t !== '')
  const head = tokens[0]
  if (head === undefined || tokens.length < 2) return undefined

  const platform = PLATFORMS.includes(head) ? (head as TargetPlatform) : undefined
  // `win32-x64-msvc` puts an ABI tag after the arch; only the first two tokens
  // identify the platform.
  if (platform !== undefined && platform !== 'darwin') {
    const archToken = tokens[1]
    const arch = archToken !== undefined && ARCHES.includes(archToken) ? (archToken as TargetArch) : undefined
    if (arch !== undefined) {
      const libcToken = tokens[2]
      const libc = libcToken !== undefined && LIBCS.includes(libcToken) ? (libcToken as LibcFlavor) : undefined
      return { platform, arch, ...(libc === undefined ? {} : { libc }) }
    }
  }

  // `<os><libc>` merged into one token, as sharp and koffi spell it.
  const merged = /^(darwin|linux|win32)(musl|gnu|glibc)?$/u.exec(head)
  if (merged === null) return undefined
  const mergedPlatformToken = merged[1]
  if (mergedPlatformToken === undefined) return undefined
  const mergedPlatform = mergedPlatformToken as TargetPlatform
  const mergedLibcToken = merged[2]
  const mergedLibc = mergedLibcToken === undefined ? undefined : normalizeLibc(mergedLibcToken)
  for (const candidate of tokens.slice(1)) {
    const arch = ARCHES.includes(candidate) ? (candidate as TargetArch) : undefined
    if (arch !== undefined) {
      return { platform: mergedPlatform, arch, ...(mergedLibc === undefined ? {} : { libc: mergedLibc }) }
    }
  }
  return undefined
}

/**
 * Whether a package (or prebuild directory) name is built for `target`.
 *
 * Unknown names answer `true`: the prune step only ever removes what it can
 * positively identify as built for a different platform, because deleting a
 * package the closure needs turns into a boot crash on the remote.
 */
export function packageMatchesTarget(name: string, target: StageTarget): boolean {
  const family = PLATFORM_PACKAGE_FAMILIES.find((f) => name.startsWith(f))
  if (family === undefined) return true
  let suffix = name.slice(family.length)
  // `@img/sharp-libvips-linux-x64` carries the lib name before the platform.
  const libvips = /^libvips-/.exec(suffix)
  if (libvips !== null) suffix = suffix.slice(libvips[0].length)
  const tokens = parsePlatformSuffix(suffix)
  if (tokens === undefined) return true
  if (tokens.platform !== target.platform) return false
  if (tokens.arch !== target.arch) return false
  if (target.platform !== 'linux') return true
  return (tokens.libc ?? 'glibc') === (target.libc ?? 'glibc')
}

/** Same question for `node-pty`'s `prebuilds/<dir>` entries. */
export function prebuildDirMatchesTarget(dirName: string, target: StageTarget): boolean {
  if (!PLATFORM_DIRECTORY_FAMILIES.some((f) => dirName.startsWith(f))) return true
  const tokens = parsePlatformSuffix(dirName)
  if (tokens === undefined) return true
  if (tokens.platform !== target.platform) return false
  if (tokens.arch !== target.arch) return false
  if (target.platform !== 'linux') return true
  return (tokens.libc ?? 'glibc') === (target.libc ?? 'glibc')
}

/**
 * Why a closure staged for `staged` cannot run on `actual`, or an empty array
 * when it can. Each string names the cause, because "incompatible" alone tells
 * the user nothing about which of the three axes differed.
 */
export function targetMismatches(staged: StageTarget, actual: StageTarget): string[] {
  const reasons: string[] = []
  if (staged.platform !== actual.platform) {
    reasons.push(`closure is ${staged.platform}, remote is ${actual.platform}`)
  }
  if (staged.arch !== actual.arch) {
    reasons.push(`closure is ${staged.arch}, remote is ${actual.arch}`)
  }
  if (staged.platform === 'linux' && actual.platform === 'linux') {
    const stagedLibc = staged.libc ?? 'glibc'
    const actualLibc = actual.libc ?? 'glibc'
    if (stagedLibc !== actualLibc) {
      reasons.push(`closure is ${stagedLibc}, remote is ${actualLibc}`)
    }
  }
  return reasons
}
