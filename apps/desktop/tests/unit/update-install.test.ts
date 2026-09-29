/**
 * The installer script: the bundle it resolves, the program it generates, and what
 * bash really does when it runs that program against a fake app.
 *
 * The two runs that reach the swap replace the image attach and the mount
 * discovery only, because a real disk image cannot be created without mounting one.
 * The staging copy, the executable check, the swap, the relaunch, and the trap are
 * the shipped program either way.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInstallScript, enclosingBundle, installPlan, launchInstaller } from '../../src/main/update/install.ts'
import type { InstallerPlan } from '../../src/main/update/install.ts'

let dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

/** A temp directory that is removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh update install '))
  dirs.push(dir)
  return dir
}

/** An Info.plist carrying the version the installer logs for the staged copy. */
function infoPlist(version: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>'
    + '<key>CFBundleShortVersionString</key>'
    + `<string>${version}</string>`
    + '</dict></plist>\n'
}

/**
 * A bundle with an executable in Contents/MacOS and a version in its Info.plist,
 * the two things the installer checks before it swaps anything.
 */
async function stageBundle(bundle: string, body: string): Promise<string> {
  const macos = join(bundle, 'Contents', 'MacOS')
  await mkdir(macos, { recursive: true })
  const executable = join(macos, 'Fake')
  await writeFile(executable, body)
  await chmod(executable, 0o755)
  await writeFile(join(bundle, 'Contents', 'Info.plist'), infoPlist('9.9.9'))
  return executable
}

/** Whether a path is there, which is how a test asserts a directory is gone. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // A path that is not there answers the question directly.
    return false
  }
}

/**
 * The generated script with the image attach and the mount discovery replaced by a
 * volume directory the test controls.
 */
function withFakeMount(plan: InstallerPlan, volume: string): string {
  return buildInstallScript(plan)
    .replace(/^ATTACH_OUT=.*$/mu, 'ATTACH_OUT=""')
    .replace(/^MOUNT=.*$/mu, `MOUNT="${volume}"`)
}

/** Run a script the way `launchInstaller` does: bash with the program on stdin. */
function runInstaller(script: string, env?: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync('/bin/bash', [], { input: script, encoding: 'utf8', env })
}

/**
 * A stub `open` on PATH. The real one hands the bundle to LaunchServices, which
 * cannot launch the shell script a fake app carries.
 */
async function stubOpen(root: string): Promise<string> {
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  const open = join(bin, 'open')
  await writeFile(open, '#!/bin/bash\nexit 0\n')
  await chmod(open, 0o755)
  return bin
}

/** The environment a run sees: a stub directory ahead of the real PATH. */
function pathWith(bin: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
}

/** Wait until a PID is gone, which is what shows a detached child was reaped. */
async function waitForGone(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      // The PID is gone, which is the answer being waited for.
      return
    }
    await delay(50)
  }
  throw new Error(`pid ${String(pid)} was still there 10 seconds after the launch`)
}

describe('enclosingBundle', () => {
  it('returns the bundle for an executable in Contents/MacOS', () => {
    expect(enclosingBundle('/Applications/X.app/Contents/MacOS/X')).toBe('/Applications/X.app')
  })

  it('returns the same bundle for any path already inside it', () => {
    expect(enclosingBundle('/Applications/X.app/Contents/Info.plist')).toBe('/Applications/X.app')
    expect(enclosingBundle('/Applications/X.app/Contents/Resources/icon.icns')).toBe('/Applications/X.app')
  })

  it('returns undefined for an executable outside any bundle', () => {
    expect(enclosingBundle('/usr/local/bin/dsh')).toBeUndefined()
  })

  it('returns undefined when a segment only looks like a bundle', () => {
    expect(enclosingBundle('/Applications/X.appdata/Contents/MacOS/X')).toBeUndefined()
    expect(enclosingBundle('/opt/dsh.app-support/bin/dsh')).toBeUndefined()
  })

  it('takes the outermost bundle when the path names a nested one', () => {
    expect(enclosingBundle('/Applications/Outer.app/Contents/Frameworks/Inner.app/Versions/A/Helper'))
      .toBe('/Applications/Outer.app')
    expect(enclosingBundle('X.app/Contents/MacOS/X')).toBe('X.app')
  })
})

describe('installPlan', () => {
  it('throws, naming the path, when the executable is not in a bundle', () => {
    expect(() => installPlan('/usr/local/bin/dsh', '/tmp/dsh.dmg', '/tmp/update.log'))
      .toThrow('cannot update: /usr/local/bin/dsh is not inside a .app bundle')
  })

  it('takes the bundle, the image, the log, and this process', () => {
    expect(installPlan('/Applications/X.app/Contents/MacOS/X', '/tmp/dsh.dmg', '/tmp/update.log')).toEqual({
      appBundle: '/Applications/X.app',
      dmgPath: '/tmp/dsh.dmg',
      logPath: '/tmp/update.log',
      pid: process.pid,
    })
  })

  it('takes an explicit pid for the process the installer waits for', () => {
    const plan = installPlan('/Applications/X.app/Contents/MacOS/X', '/tmp/dsh.dmg', '/tmp/update.log', 4242)
    expect(plan.pid).toBe(4242)
  })
})

describe('buildInstallScript', () => {
  it('drives every step from the plan variables', () => {
    const script = buildInstallScript({
      appBundle: '/Applications/DSH Desktop.app',
      dmgPath: '/tmp/dsh.dmg',
      logPath: '/tmp/update.log',
      pid: 1234,
    })

    for (const expected of [
      '$APP',
      '$DMG',
      '$LOG',
      '$PID',
      'hdiutil attach',
      'ditto --rsrc --extattr',
      'com.apple.quarantine',
      'dsh-backup',
      'dsh-new',
      'open "$APP"',
    ]) {
      expect(script).toContain(expected)
    }

    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
    expect(script).toContain('set -u')
    // Exit codes are checked individually, so an abort here would skip the
    // script's own rollback paths.
    expect(script).not.toContain('set -e')
  })

  it('escapes a quote or a dollar in a path', () => {
    const script = buildInstallScript({
      appBundle: '/Applications/Weird "Name".app',
      dmgPath: '/tmp/weird $HOME.dmg',
      logPath: '/tmp/update.log',
      pid: 1,
    })

    expect(script).toContain('APP="/Applications/Weird \\"Name\\".app"')
    expect(script).toContain('DMG="/tmp/weird \\$HOME.dmg"')
  })
})

describe('running the generated installer', () => {
  it('logs the failed attach and leaves the installed app alone when the image is not one', async () => {
    const root = await tempDir()
    const app = join(root, 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const dmg = join(root, 'not an image.dmg')
    await writeFile(dmg, 'this is not a disk image\n')
    // The log directory does not exist yet: the script creates it.
    const logPath = join(root, 'Logs', 'update.log')

    const result = runInstaller(buildInstallScript(installPlan(executable, dmg, logPath, 999999)))

    expect(result.status).toBe(1)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('could not attach')
    expect(log).toContain(dmg)
    expect(await readFile(executable, 'utf8')).toBe('the installed build\n')
    expect(await pathExists(`${app}.dsh-new`)).toBe(false)
    expect(await pathExists(`${app}.dsh-backup`)).toBe(false)
  })

  it('acts on the attach status rather than on its output naming a mount point', async () => {
    const root = await tempDir()
    const app = join(root, 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const dmg = join(root, 'not an image.dmg')
    await writeFile(dmg, 'this is not a disk image\n')
    const logPath = join(root, 'Logs', 'update.log')

    const result = runInstaller(buildInstallScript(installPlan(executable, dmg, logPath, 999999)))

    // A status read from anywhere but the attach itself would let a failed attach
    // fall through into the mount parse, which is what the log rules out.
    expect(result.status).toBe(1)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('could not attach')
    expect(log).not.toContain('mount point')
    expect(log).not.toContain('dsh-new')
  })

  it('swaps the staged copy into place and keeps its executable bit', async () => {
    const root = await tempDir()
    const app = join(root, 'Applications', 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const volume = join(root, 'volume')
    await stageBundle(join(volume, 'Fake.app'), 'the downloaded build\n')
    const dmg = join(root, 'Fake.dmg')
    await writeFile(dmg, 'never attached: the mount step is replaced below\n')
    const logPath = join(root, 'Logs', 'update.log')
    const plan = installPlan(executable, dmg, logPath, 999999)

    const result = runInstaller(withFakeMount(plan, volume), pathWith(await stubOpen(root)))

    expect(result.status).toBe(0)
    expect(await readFile(executable, 'utf8')).toBe('the downloaded build\n')
    expect((await stat(executable)).mode & 0o111).not.toBe(0)
    expect(await pathExists(`${app}.dsh-new`)).toBe(false)
    expect(await pathExists(`${app}.dsh-backup`)).toBe(false)
    expect(await readFile(logPath, 'utf8')).toContain('version 9.9.9')
  })

  it('puts the previous bundle back when the swap fails', async () => {
    const root = await tempDir()
    const app = join(root, 'Applications', 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const volume = join(root, 'volume')
    await stageBundle(join(volume, 'Fake.app'), 'the downloaded build\n')
    const logPath = join(root, 'Logs', 'update.log')
    const plan = installPlan(executable, join(root, 'Fake.dmg'), logPath, 999999)
    // The move into place is the one step nobody can undo by hand, so failing it
    // has to leave the installed bundle exactly where it was.
    const script = withFakeMount(plan, volume)
      .replace(/^MOVE_ERR=.*dsh-new.*$/mu, 'MOVE_ERR="$(false)"')

    const result = runInstaller(script, pathWith(await stubOpen(root)))

    expect(result.status).toBe(1)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('could not move the staged copy into')
    expect(log).toContain('the previous bundle is back in')
    expect(await readFile(executable, 'utf8')).toBe('the installed build\n')
    expect(await pathExists(`${app}.dsh-new`)).toBe(false)
    expect(await pathExists(`${app}.dsh-backup`)).toBe(false)
  })

  it('removes the staged copy when the script exits before the swap', async () => {
    const root = await tempDir()
    const app = join(root, 'Applications', 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const volume = join(root, 'volume')
    await stageBundle(join(volume, 'Fake.app'), 'the downloaded build\n')
    const logPath = join(root, 'Logs', 'update.log')
    const plan = installPlan(executable, join(root, 'Fake.dmg'), logPath, 999999)
    // The version read is the last step before the swap, so failing there leaves
    // a staged copy on disk for the trap to remove.
    const script = withFakeMount(plan, volume).replace(/^VERSION=.*$/mu, 'exit 7')

    const result = runInstaller(script)

    expect(result.status).toBe(7)
    expect(await readFile(logPath, 'utf8')).toContain('staged')
    expect(await pathExists(`${app}.dsh-new`)).toBe(false)
    expect(await pathExists(`${app}.dsh-backup`)).toBe(false)
    expect(await readFile(executable, 'utf8')).toBe('the installed build\n')
  })

  it('runs the installer detached, leaving a log and no process behind', async () => {
    const root = await tempDir()
    const app = join(root, 'Fake.app')
    const executable = await stageBundle(app, 'the installed build\n')
    const dmg = join(root, 'not an image.dmg')
    await writeFile(dmg, 'this is not a disk image\n')
    const logPath = join(root, 'Logs', 'update.log')

    const pid = launchInstaller(installPlan(executable, dmg, logPath, 999999))

    expect(pid).toBeGreaterThan(0)
    await waitForGone(pid)
    expect(await readFile(logPath, 'utf8')).toContain('could not attach')
  })
})
