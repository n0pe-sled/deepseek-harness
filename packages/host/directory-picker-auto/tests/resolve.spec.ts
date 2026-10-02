import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canExecute, hasLinuxChooserBinary } from '../src/probe.ts'
import { resolveDirectoryPickerBackend } from '../src/resolve.ts'
import type { DirectoryPickerHostFacts, DirectoryPickerInteraction } from '../src/resolve.ts'

/** Baseline facts of an attended loopback host; each case overrides one signal (darwin never consults `linuxChooser`). */
const attended: DirectoryPickerHostFacts = {
  bindHost: '127.0.0.1',
  platform: 'darwin',
  env: {},
  linuxChooser: false,
}

/** Resolve one sample against the requested interaction. */
const resolve = (interaction: DirectoryPickerInteraction, facts: DirectoryPickerHostFacts = attended) =>
  resolveDirectoryPickerBackend(interaction, facts)

describe('resolveDirectoryPickerBackend', () => {
  it('resolves browse for a browse request whatever the host could serve', () => {
    expect(resolve('browse')).toBe('browse')
    expect(resolve('browse', { ...attended, platform: 'win32' })).toBe('browse')
    expect(resolve('browse', { ...attended, platform: 'linux', linuxChooser: true, env: { DISPLAY: ':0' } })).toBe('browse')
  })

  it('resolves native for a native request on a loopback bind with a display platform', () => {
    expect(resolve('native')).toBe('native')
    expect(resolve('native', { ...attended, platform: 'win32' })).toBe('native')
  })

  it('falls back to browse for a native request on an all-interfaces bind', () => {
    expect(resolve('native', { ...attended, bindHost: '0.0.0.0' })).toBe('browse')
  })

  it('falls back to browse for a native request under an SSH launch (either env marker)', () => {
    expect(resolve('native', { ...attended, env: { SSH_CONNECTION: '10.0.0.2 55 10.0.0.9 22' } })).toBe('browse')
    expect(resolve('native', { ...attended, env: { SSH_TTY: '/dev/pts/3' } })).toBe('browse')
  })

  it('falls back to browse for a native request when a proxy serves the GUI at a loopback-equivalent remote origin', () => {
    expect(resolve('native', { ...attended, env: { DSH_WEB_LOOPBACK_ORIGINS: 'dsh.example.ts.net' } })).toBe('browse')
    expect(resolve('native', {
      ...attended, platform: 'linux', linuxChooser: true, env: { DISPLAY: ':0', DSH_WEB_LOOPBACK_ORIGINS: 'dsh.example.ts.net' },
    })).toBe('browse')
  })

  it('requires a display session and a chooser binary for a native request on linux', () => {
    const linux: DirectoryPickerHostFacts = { ...attended, platform: 'linux', linuxChooser: true }
    expect(resolve('native', linux)).toBe('browse')
    expect(resolve('native', { ...linux, env: { DISPLAY: ':0' } })).toBe('native')
    expect(resolve('native', { ...linux, env: { WAYLAND_DISPLAY: 'wayland-1' } })).toBe('native')
    expect(resolve('native', { ...linux, env: { DISPLAY: ':0' }, linuxChooser: false })).toBe('browse')
  })

  it('falls back to browse for a native request on platforms the native backend cannot serve, display or not', () => {
    expect(resolve('native', { ...attended, platform: 'freebsd', env: { DISPLAY: ':0' }, linuxChooser: true })).toBe('browse')
    expect(resolve('native', { ...attended, platform: 'openbsd', env: { WAYLAND_DISPLAY: 'wayland-1' } })).toBe('browse')
  })

  it('treats blank env exports as unset', () => {
    expect(resolve('native', { ...attended, env: { SSH_CONNECTION: '', SSH_TTY: '', DSH_WEB_LOOPBACK_ORIGINS: '' } })).toBe('native')
    expect(resolve('native', {
      ...attended, platform: 'linux', linuxChooser: true, env: { DISPLAY: '', WAYLAND_DISPLAY: '' },
    })).toBe('browse')
  })
})

let probeRoot: string | undefined

afterEach(() => {
  if (probeRoot !== undefined) rmSync(probeRoot, { recursive: true, force: true })
  probeRoot = undefined
})

describe('hasLinuxChooserBinary', () => {
  it('finds a chooser binary in any PATH segment, skipping empty segments', () => {
    const seen: string[] = []
    const path = ['', '/opt/none', '/usr/local/bin'].join(delimiter)
    const found = hasLinuxChooserBinary(path, (candidate) => {
      seen.push(candidate)
      return candidate === join('/usr/local/bin', 'kdialog')
    })
    expect(found).toBe(true)
    expect(seen).toEqual([
      join('/opt/none', 'zenity'), join('/opt/none', 'kdialog'),
      join('/usr/local/bin', 'zenity'), join('/usr/local/bin', 'kdialog'),
    ])
  })

  it('reports absence when no segment holds a chooser binary', () => {
    expect(hasLinuxChooserBinary(['/a', '/b'].join(delimiter), () => false)).toBe(false)
    expect(hasLinuxChooserBinary('', () => true)).toBe(false)
    expect(hasLinuxChooserBinary(undefined, () => true)).toBe(false)
  })
})

describe('canExecute', () => {
  it('accepts an executable file and rejects an absent one', () => {
    probeRoot = mkdtempSync(join(tmpdir(), 'dsh-picker-probe-'))
    const binary = join(probeRoot, 'zenity')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)
    expect(canExecute(binary)).toBe(true)
    expect(canExecute(join(probeRoot, 'kdialog'))).toBe(false)
  })
})
