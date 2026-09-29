/**
 * Child PATH assembly and executable lookup.
 *
 * These carry the regression that made a sandboxed local instance fail on a
 * machine where docker was installed: an app launched from Finder inherits
 * launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which has no
 * /usr/local/bin, so a bare `spawn('docker')` reports a working install as
 * missing.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { augmentPath, containerPath, findExecutable } from '../../src/main/instances/exec-path.ts'

/** launchd's PATH, the one a Dock-launched app starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('augmentPath', () => {
  it('appends standard node directories', () => {
    const result = augmentPath('/usr/bin', '/Users/me')
    expect(result.startsWith('/usr/bin')).toBe(true)
    expect(result).toContain('/Users/me/.local/bin')
    expect(result).toContain('/opt/homebrew/bin')
    expect(result).toContain('/usr/local/bin')
  })

  it('handles an empty PATH', () => {
    const result = augmentPath('')
    expect(result).toContain('/opt/homebrew/bin')
  })

  it('does not add relative user directories without a home', () => {
    const result = augmentPath('', '')
    expect(result).not.toContain('.local/bin')
  })
})

describe('containerPath', () => {
  it('adds the directories a container CLI is installed into', () => {
    const result = containerPath(LAUNCHD_PATH, '/Users/me')
    // The Docker Desktop CLI's own location, since its /usr/local/bin symlink is
    // an install-time option.
    expect(result).toContain('/Applications/Docker.app/Contents/Resources/bin')
    expect(result).toContain('/opt/podman/bin')
    expect(result).toContain('/Users/me/.docker/bin')
    expect(result).toContain('/Users/me/.orbstack/bin')
    expect(result).toContain('/Users/me/.rd/bin')
  })

  it('keeps the inherited PATH first and every directory once', () => {
    const result = containerPath(LAUNCHD_PATH, '/Users/me')
    expect(result.startsWith(LAUNCHD_PATH)).toBe(true)
    const dirs = result.split(':')
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('skips home-relative directories without a home', () => {
    const result = containerPath(LAUNCHD_PATH, '')
    expect(result).not.toContain('.docker/bin')
    expect(result).not.toContain('/.orbstack')
  })
})

describe('findExecutable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exec-path-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds an executable on the PATH and returns its absolute path', () => {
    const bin = join(dir, 'docker')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    expect(findExecutable('docker', `/usr/bin:${dir}:/bin`)).toBe(bin)
  })

  it('returns undefined when no directory has the name', () => {
    expect(findExecutable('definitely-not-installed', `/usr/bin:${dir}`)).toBeUndefined()
  })

  it('ignores a file that is not executable', () => {
    const bin = join(dir, 'podman')
    writeFileSync(bin, 'not a program\n')
    chmodSync(bin, 0o644)
    expect(findExecutable('podman', dir)).toBeUndefined()
  })

  it('ignores a directory that carries the name', () => {
    // A PATH entry holding a *directory* called docker must not be mistaken for
    // the CLI: X_OK is true for directories, so the file check is load-bearing.
    const parent = join(dir, 'nested')
    mkdirSync(join(parent, 'docker'), { recursive: true })
    expect(findExecutable('docker', parent)).toBeUndefined()
  })
})
