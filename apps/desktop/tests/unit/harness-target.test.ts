/**
 * Target parsing and platform matching decide which native build gets shipped
 * to a remote host. A wrong answer here is silent: the closure boots nothing on
 * the remote and looks like corruption, so the rules are pinned with the real
 * package names pnpm resolved during cross-staging.
 */
import { describe, expect, it } from 'vitest'
import {
  formatTarget,
  harnessCacheKey,
  packageMatchesTarget,
  parseTarget,
  prebuildDirMatchesTarget,
  targetMismatches,
  targetsEqual,
} from '../../src/shared/harness-target.ts'

const linux = parseTarget('linux-x64-glibc')
const darwin = parseTarget('darwin-arm64')

describe('parseTarget', () => {
  it('reads a full triple', () => {
    expect(linux).toEqual({ platform: 'linux', arch: 'x64', libc: 'glibc' })
  })

  it('defaults linux to glibc when the libc is omitted', () => {
    expect(parseTarget('linux-arm64')).toEqual({ platform: 'linux', arch: 'arm64', libc: 'glibc' })
  })

  it('leaves libc off non-linux targets', () => {
    expect(darwin).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(parseTarget('win32-x64')).toEqual({ platform: 'win32', arch: 'x64' })
  })

  it('accepts the aliases the other tools use', () => {
    expect(parseTarget('macos-aarch64')).toEqual({ platform: 'darwin', arch: 'arm64' })
    expect(parseTarget('linux-amd64')).toEqual({ platform: 'linux', arch: 'x64', libc: 'glibc' })
    expect(parseTarget('windows-x86_64')).toEqual({ platform: 'win32', arch: 'x64' })
  })

  it('rejects a libc on a platform that has only one', () => {
    expect(() => parseTarget('darwin-arm64-glibc')).toThrow(/libc only applies to linux/)
  })

  it('rejects unparseable and unknown values', () => {
    expect(() => parseTarget('linux')).toThrow(/platform-arch/)
    expect(() => parseTarget('linux-x64-glibc-extra')).toThrow(/platform-arch/)
    expect(() => parseTarget('plan9-x64')).toThrow(/unknown target platform/)
    expect(() => parseTarget('linux-sparc')).toThrow(/unknown target architecture/)
    expect(() => parseTarget('linux-x64-uclibc')).toThrow(/unknown target libc/)
  })

  it('round-trips through formatTarget', () => {
    for (const triple of ['linux-x64-glibc', 'linux-arm64-musl', 'darwin-arm64', 'win32-x64']) {
      expect(formatTarget(parseTarget(triple))).toBe(triple)
    }
  })
})

describe('targetsEqual', () => {
  it('treats an omitted linux libc as glibc', () => {
    expect(targetsEqual({ platform: 'linux', arch: 'x64' }, linux)).toBe(true)
  })

  it('separates musl from glibc, since one closure cannot serve both', () => {
    expect(targetsEqual(parseTarget('linux-x64-musl'), linux)).toBe(false)
  })

  it('separates architectures and platforms', () => {
    expect(targetsEqual(parseTarget('linux-arm64'), linux)).toBe(false)
    expect(targetsEqual(darwin, linux)).toBe(false)
  })
})

describe('harnessCacheKey', () => {
  it('changes when the revision or the target changes', () => {
    const key = harnessCacheKey('0.1.1-rc.2', 'f0d424f65b', linux)
    expect(key).toBe('0.1.1-rc.2-f0d424f65b-linux-x64-glibc')
    expect(harnessCacheKey('0.1.1-rc.2', 'c870675c14', linux)).not.toBe(key)
    expect(harnessCacheKey('0.1.1-rc.2', 'f0d424f65b', parseTarget('linux-x64-musl'))).not.toBe(key)
    expect(harnessCacheKey('0.1.1-rc.2', 'f0d424f65b', darwin)).toBe('0.1.1-rc.2-f0d424f65b-darwin-arm64')
  })
})

describe('packageMatchesTarget', () => {
  it('keeps the target native package and drops its siblings', () => {
    expect(packageMatchesTarget('@koromix/koffi-linux-x64', linux)).toBe(true)
    expect(packageMatchesTarget('@koromix/koffi-linux-arm64', linux)).toBe(false)
    expect(packageMatchesTarget('@koromix/koffi-darwin-arm64', linux)).toBe(false)
  })

  it('reads sharp, whose platform token merges the os and libc', () => {
    expect(packageMatchesTarget('@img/sharp-linux-x64', linux)).toBe(true)
    expect(packageMatchesTarget('@img/sharp-linuxmusl-x64', linux)).toBe(false)
    expect(packageMatchesTarget('@img/sharp-linuxmusl-x64', parseTarget('linux-x64-musl'))).toBe(true)
    expect(packageMatchesTarget('@img/sharp-darwin-arm64', linux)).toBe(false)
  })

  it('reads the libvips packages after the lib name', () => {
    expect(packageMatchesTarget('@img/sharp-libvips-linux-x64', linux)).toBe(true)
    expect(packageMatchesTarget('@img/sharp-libvips-darwin-arm64', linux)).toBe(false)
    expect(packageMatchesTarget('@img/sharp-libvips-linuxmusl-x64', linux)).toBe(false)
  })

  it('reads the -gnu suffix on node-addon-require-builtin', () => {
    expect(packageMatchesTarget('node-addon-require-builtin-linux-x64-gnu', linux)).toBe(true)
    expect(packageMatchesTarget('node-addon-require-builtin-linux-arm64-gnu', linux)).toBe(false)
    expect(packageMatchesTarget('node-addon-require-builtin-darwin-arm64', linux)).toBe(false)
  })

  it('reads the msvc suffix on win32 builds', () => {
    expect(packageMatchesTarget('node-addon-require-builtin-win32-x64-msvc', parseTarget('win32-x64'))).toBe(true)
    expect(packageMatchesTarget('node-addon-require-builtin-win32-x64-msvc', linux)).toBe(false)
  })

  it('reads esbuild and rollup', () => {
    expect(packageMatchesTarget('@esbuild/linux-x64', linux)).toBe(true)
    expect(packageMatchesTarget('@esbuild/darwin-arm64', linux)).toBe(false)
    expect(packageMatchesTarget('@rollup/rollup-linux-x64-gnu', linux)).toBe(true)
    expect(packageMatchesTarget('@rollup/rollup-linux-x64-musl', linux)).toBe(false)
  })

  it('reads the bundled ripgrep binaries', () => {
    expect(packageMatchesTarget('@vscode/ripgrep-linux-x64', linux)).toBe(true)
    expect(packageMatchesTarget('@vscode/ripgrep-darwin-arm64', linux)).toBe(false)
    expect(packageMatchesTarget('@vscode/ripgrep', linux)).toBe(true)
  })

  it('keeps the unsuffixed base package of a platform family', () => {
    expect(packageMatchesTarget('@koromix/koffi', linux)).toBe(true)
    expect(packageMatchesTarget('@img/sharp', linux)).toBe(true)
    expect(packageMatchesTarget('node-addon-require-builtin', linux)).toBe(true)
  })

  it('keeps anything it cannot positively identify as another platform', () => {
    expect(packageMatchesTarget('koffi', linux)).toBe(true)
    expect(packageMatchesTarget('node-pty', linux)).toBe(true)
    expect(packageMatchesTarget('@deepseek-ai/dsh-subprocess-local', linux)).toBe(true)
    expect(packageMatchesTarget('@esbuild/helper', linux)).toBe(true)
  })
})

describe('prebuildDirMatchesTarget', () => {
  it('selects one node-pty prebuild directory', () => {
    expect(prebuildDirMatchesTarget('linux-x64', linux)).toBe(true)
    expect(prebuildDirMatchesTarget('linux-arm64', linux)).toBe(false)
    expect(prebuildDirMatchesTarget('darwin-arm64', linux)).toBe(false)
    expect(prebuildDirMatchesTarget('win32-x64', linux)).toBe(false)
  })

  it('keeps directories that are not platform-shaped', () => {
    expect(prebuildDirMatchesTarget('node-pty', linux)).toBe(true)
  })
})

describe('targetMismatches', () => {
  it('reports nothing for a matching target', () => {
    expect(targetMismatches(linux, parseTarget('linux-x64'))).toEqual([])
  })

  it('names each axis that differs', () => {
    expect(targetMismatches(parseTarget('darwin-arm64'), parseTarget('darwin-x64'))).toEqual([
      'closure is arm64, remote is x64',
    ])
    expect(targetMismatches(parseTarget('linux-arm64'), linux)).toEqual([
      'closure is arm64, remote is x64',
    ])
    expect(targetMismatches(parseTarget('linux-x64-musl'), linux)).toEqual([
      'closure is musl, remote is glibc',
    ])
  })

  it('reports every differing axis at once', () => {
    expect(targetMismatches(parseTarget('darwin-arm64'), parseTarget('linux-x64'))).toEqual([
      'closure is darwin, remote is linux',
      'closure is arm64, remote is x64',
    ])
  })
})
