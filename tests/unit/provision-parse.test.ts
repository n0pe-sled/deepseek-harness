/**
 * Remote-provisioning parsers and command builders.
 *
 * Every case here is output a real host produced or a shape that would fail
 * silently: an architecture read as the wrong token stages a closure whose
 * native addons cannot load, and a launch command that forgets to detach leaves
 * a server that dies with the ssh session while the log still shows a readiness
 * line. Both look like success and are not.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDetectCommand,
  buildExtractCommand,
  buildLaunchCommand,
  nodeSatisfiesHarness,
  parseDetectOutput,
  parseGlibcVersion,
  parsePidFile,
  parseRemoteLogPort,
  parseUnameArch,
  parseUnamePlatform,
  posixDirname,
  remoteClosureDir,
  shellQuote,
  targetForFacts,
} from '../../src/main/instances/provision-parse.ts'

describe('parseUnameArch', () => {
  it('reads the spellings uname uses', () => {
    expect(parseUnameArch('x86_64')).toBe('x64')
    expect(parseUnameArch('aarch64')).toBe('arm64')
    expect(parseUnameArch('arm64')).toBe('arm64')
  })

  it('reports undefined rather than guessing at an unknown machine', () => {
    expect(parseUnameArch('i686')).toBeUndefined()
    expect(parseUnameArch('riscv64')).toBeUndefined()
    expect(parseUnameArch('')).toBeUndefined()
  })
})

describe('parseUnamePlatform', () => {
  it('accepts the platforms this app can provision', () => {
    expect(parseUnamePlatform('Linux')).toBe('linux')
    expect(parseUnamePlatform('Darwin')).toBe('darwin')
  })

  it('rejects anything else, including a BSD that would look close', () => {
    expect(parseUnamePlatform('FreeBSD')).toBeUndefined()
    expect(parseUnamePlatform('MINGW64_NT-10.0')).toBeUndefined()
  })
})

describe('targetForFacts', () => {
  it('defaults linux to glibc when the probe could not tell', () => {
    expect(targetForFacts({ platform: 'linux', arch: 'x64' })).toEqual({
      platform: 'linux', arch: 'x64', libc: 'glibc',
    })
  })

  it('carries musl through, so the caller can refuse it', () => {
    expect(targetForFacts({ platform: 'linux', arch: 'arm64', libc: 'musl' })).toEqual({
      platform: 'linux', arch: 'arm64', libc: 'musl',
    })
  })

  it('leaves libc off a non-linux target', () => {
    expect(targetForFacts({ platform: 'darwin', arch: 'arm64' })).toEqual({ platform: 'darwin', arch: 'arm64' })
  })
})

describe('parseGlibcVersion', () => {
  it('reads the Debian ldd banner', () => {
    expect(parseGlibcVersion('ldd (Debian GLIBC 2.41-12+deb13u4) 2.41')).toBe('2.41')
  })

  it('reads the upstream banner', () => {
    expect(parseGlibcVersion('ldd (GNU libc) 2.31')).toBe('2.31')
  })

  it('is undefined when there is no version to read', () => {
    expect(parseGlibcVersion('ldd: command not found')).toBeUndefined()
  })
})

describe('nodeSatisfiesHarness', () => {
  it('accepts the harness range ^22.19.0 || >=24.0.0', () => {
    expect(nodeSatisfiesHarness('v22.19.0')).toBe(true)
    expect(nodeSatisfiesHarness('v22.20.1')).toBe(true)
    expect(nodeSatisfiesHarness('v24.21.0')).toBe(true)
    expect(nodeSatisfiesHarness('v26.10.0')).toBe(true)
  })

  it('rejects what the range excludes', () => {
    expect(nodeSatisfiesHarness('v22.18.0')).toBe(false)
    expect(nodeSatisfiesHarness('v20.11.0')).toBe(false)
    expect(nodeSatisfiesHarness('v23.5.0')).toBe(false)
  })

  it('rejects an unparseable version instead of assuming it is fine', () => {
    expect(nodeSatisfiesHarness('none')).toBe(false)
    expect(nodeSatisfiesHarness('')).toBe(false)
  })
})

describe('shellQuote', () => {
  it('survives spaces', () => {
    expect(shellQuote('/home/my user/.dsh-desktop')).toBe("'/home/my user/.dsh-desktop'")
  })

  it('escapes an embedded single quote rather than breaking out of the quote', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})

describe('parseDetectOutput', () => {
  // Captured from the propagation probe host: Debian 13 on x86_64.
  const debian = [
    'platform=Linux',
    'arch=x86_64',
    'home=/root',
    'ldd=ldd (Debian GLIBC 2.41-12+deb13u4) 2.41',
    'musl=',
    'os=Debian GNU/Linux 13 (trixie)',
    'node=v24.21.0',
    'free_kb=212992000',
    'writable=yes',
  ].join('\n')

  it('reads a full Debian probe', () => {
    expect(parseDetectOutput(debian)).toEqual({
      platform: 'linux',
      arch: 'x64',
      libc: 'glibc',
      libcVersion: '2.41',
      osName: 'Debian GNU/Linux 13 (trixie)',
      nodeVersion: 'v24.21.0',
      freeKb: 212992000,
      home: '/root',
      homeWritable: true,
    })
  })

  it('keeps a pretty name containing spaces and parentheses intact', () => {
    expect(parseDetectOutput(debian)?.osName).toBe('Debian GNU/Linux 13 (trixie)')
  })

  it('detects musl from the loader even when ldd gives no glibc banner', () => {
    const alpine = [
      'platform=Linux',
      'arch=x86_64',
      'ldd=musl libc (x86_64)',
      'musl=/lib/ld-musl-x86_64.so.1',
      'os=Alpine Linux v3.20',
      'node=v22.20.0',
      'writable=yes',
    ].join('\n')
    const facts = parseDetectOutput(alpine)
    expect(facts?.libc).toBe('musl')
    // A musl host has no glibc version to report.
    expect(facts?.libcVersion).toBeUndefined()
  })

  it('treats a host with both a musl loader and glibc as glibc', () => {
    const both = [
      'platform=Linux',
      'arch=x86_64',
      'ldd=ldd (Debian GLIBC 2.41-12+deb13u4) 2.41',
      'musl=/lib/ld-musl-x86_64.so.1',
    ].join('\n')
    expect(parseDetectOutput(both)?.libc).toBe('glibc')
  })

  it('reports a host with no node as having none, rather than failing the probe', () => {
    const bare = ['platform=Linux', 'arch=aarch64', 'node=none', 'writable=no'].join('\n')
    const facts = parseDetectOutput(bare)
    expect(facts?.nodeVersion).toBeUndefined()
    expect(facts?.arch).toBe('arm64')
    expect(facts?.homeWritable).toBe(false)
  })

  it('ignores lines it does not understand', () => {
    const noisy = ['warning: something', 'platform=Linux', 'arch=x86_64', 'free_kb=notanumber'].join('\n')
    const facts = parseDetectOutput(noisy)
    expect(facts?.platform).toBe('linux')
    expect(facts?.freeKb).toBeUndefined()
  })

  it('is undefined when the platform or arch could not be read', () => {
    expect(parseDetectOutput('platform=FreeBSD\narch=x86_64')).toBeUndefined()
    expect(parseDetectOutput('platform=Linux\narch=i686')).toBeUndefined()
    expect(parseDetectOutput('')).toBeUndefined()
  })
})

describe('posixDirname', () => {
  it('handles the shapes a remote path takes', () => {
    expect(posixDirname('/home/me/.dsh-desktop/harness')).toBe('/home/me/.dsh-desktop')
    expect(posixDirname('/root/.dsh-desktop/harness/')).toBe('/root/.dsh-desktop')
    expect(posixDirname('/home')).toBe('/')
    expect(posixDirname('relative/path')).toBe('relative')
  })
})

describe('remoteClosureDir', () => {
  it('nests the cache key under the root and tolerates a trailing slash', () => {
    expect(remoteClosureDir('/home/me/.dsh-desktop/harness', 'k'))
      .toBe('/home/me/.dsh-desktop/harness/k')
    expect(remoteClosureDir('/tmp/h/', 'k')).toBe('/tmp/h/k')
  })
})

describe('buildDetectCommand', () => {
  it('is one command, so one handshake covers the whole probe', () => {
    expect(buildDetectCommand('$HOME/.dsh-desktop/harness')).not.toContain('\n')
  })

  it('never ends the probe on a failing subcommand', () => {
    // Every field is optional; a host without node or df must still report the
    // fields that worked rather than aborting the script.
    expect(buildDetectCommand('/tmp/x')).toContain('set +e')
  })

  it('probes writability by creating a directory, not by inspecting permissions', () => {
    // `test -w` says yes for /proc and for anything a root user can see, so an
    // unwritable target slipped through preflight and only failed later as a
    // transfer error. The probe has to do the real operation.
    const command = buildDetectCommand('/proc/nope/harness')
    expect(command).toContain('mkdir -p')
    expect(command).toContain('rmdir')
    expect(command).not.toMatch(/\[ -w /u)
  })

  it('climbs to the nearest existing directory before probing', () => {
    expect(buildDetectCommand('/a/b/c/d')).toContain('while [ ! -d "$target" ]')
  })
})

describe('parseDetectOutput writability', () => {
  it('reads the probed writability and the directory it was judged on', () => {
    const facts = parseDetectOutput([
      'platform=Linux',
      'arch=x86_64',
      'writable=no',
      'target=/proc',
    ].join('\n'))
    expect(facts?.homeWritable).toBe(false)
    expect(facts?.writableTarget).toBe('/proc')
  })
})

describe('buildExtractCommand', () => {
  const command = buildExtractCommand('/remote/key.tmp', '/remote/key')

  it('extracts into the temp directory, not the final one', () => {
    expect(command).toContain("mkdir -p '/remote/key.tmp'")
    expect(command).toContain("tar xzf - -C '/remote/key.tmp'")
  })

  it('verifies the closure before renaming it into place', () => {
    // A populated directory under the final name is indistinguishable from a
    // valid cache, so the completeness check has to precede the rename.
    const checkIndex = command.indexOf('lib/bin.js')
    const renameIndex = command.indexOf("mv '/remote/key.tmp' '/remote/key'")
    expect(checkIndex).toBeGreaterThan(-1)
    expect(renameIndex).toBeGreaterThan(checkIndex)
    expect(command).toContain('harness-meta.json')
  })

  it('fails the command when the extraction is incomplete', () => {
    expect(command).toContain('exit 1')
  })
})

describe('buildLaunchCommand', () => {
  const command = buildLaunchCommand({
    closureDir: '/remote/key',
    nodePath: 'node',
    logPath: '/remote/key/dsh.log',
    pidPath: '/remote/key/dsh.pid',
  })

  it('detaches with setsid, so the server outlives the ssh session', () => {
    expect(command).toContain('setsid')
  })

  it('redirects all three streams, so the launch returns instead of hanging', () => {
    expect(command).toContain(">'/remote/key/dsh.log' 2>&1 </dev/null")
  })

  it('records the PID and execs, so the recorded PID is the server', () => {
    expect(command).toContain('dsh.pid')
    expect(command).toContain('exec')
    expect(command).toContain('lib/bin.js web --port 0 --no-open')
  })

  it('never puts a semicolon after an ampersand, which is a shell syntax error', () => {
    // `&` already separates commands. A `&;` sequence makes the remote shell
    // reject the whole line before the launcher runs, which showed up as an
    // empty PID file and an empty log rather than as an error.
    expect(command).not.toContain('&;')
    expect(command).toContain('&')
  })
})

describe('parseRemoteLogPort', () => {
  it('reads the readiness line a remote log holds', () => {
    expect(parseRemoteLogPort('dsh web: http://127.0.0.1:46077')).toBe(46077)
    expect(parseRemoteLogPort('noise\ndsh web: http://localhost:3080\nmore')).toBe(3080)
  })

  it('returns undefined while the server has not reported yet', () => {
    expect(parseRemoteLogPort('')).toBeUndefined()
    expect(parseRemoteLogPort('booting profile web...')).toBeUndefined()
  })

  it('rejects a non-loopback address, which is not a tunnelable terminus', () => {
    expect(parseRemoteLogPort('dsh web: (LAN: http://10.0.0.5:8080)')).toBeUndefined()
  })
})

describe('parsePidFile', () => {
  it('reads a PID and tolerates surrounding whitespace', () => {
    expect(parsePidFile('  1234\n')).toBe(1234)
  })

  it('is undefined for an empty or malformed file', () => {
    expect(parsePidFile('')).toBeUndefined()
    expect(parsePidFile('not-a-pid')).toBeUndefined()
    expect(parsePidFile('-1')).toBeUndefined()
  })
})
