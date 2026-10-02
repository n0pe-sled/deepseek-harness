/**
 * Backend resolution for the adaptive directory-picker composition: one pure
 * decision from the deployment's requested interaction plus sampled host facts to
 * a concrete backend kind. The caller samples exactly once per boot, so the
 * mounted capability stays stable for the service lifetime as the seam requires.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import type { Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** The interaction a deployment asks for: the in-app browser, or the host display's OS chooser. */
export type DirectoryPickerInteraction = DirectoryPickerBackendKind

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<Record<'SSH_CONNECTION' | 'SSH_TTY' | 'DISPLAY' | 'WAYLAND_DISPLAY' | 'DSH_WEB_LOOPBACK_ORIGINS', string>>
>

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /** Effective webserver bind host (the schema's closed loopback/all-interfaces union). */
  bindHost: HttpServerConfig['host']
  /** Host process platform. */
  platform: NodeJS.Platform
  /**
   * Environment sample; SSH marks a remote operator, DISPLAY/WAYLAND_DISPLAY a
   * Linux display, DSH_WEB_LOOPBACK_ORIGINS a proxied remote browser.
   */
  env: DirectoryPickerEnv
  /** Whether a Linux chooser binary the native backend can drive (zenity/kdialog) is on PATH; consulted only when `platform` is linux. */
  linuxChooser: boolean
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. The requested interaction decides the
 * answer unless it asks for `native` on a host that cannot serve it: `native`
 * requires every signal that the operator can see the host display — a
 * loopback-only bind (an all-interfaces bind admits remote browsers no OS
 * chooser can reach), no remote operator reaching the GUI through a
 * loopback-supplying proxy (`DSH_WEB_LOOPBACK_ORIGINS`, the same declaration
 * that grants a proxied page loopback privilege; such a page is served to an
 * operator who is not at the host screen) and no SSH launch (under SSH
 * port-forwarding the chooser would open on the unattended server), and a
 * servable display session — assumed on darwin/win32, requiring
 * `DISPLAY`/`WAYLAND_DISPLAY` plus a chooser binary on linux, and never true
 * elsewhere (the native backend drives exactly darwin/win32/linux). A host that
 * fails any of them falls back to `browse`, which works everywhere: a
 * deployment that pins `native` therefore still gets a chooser instead of a
 * broken one.
 * @param interaction - the interaction the deployment requested.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(
  interaction: DirectoryPickerInteraction,
  facts: DirectoryPickerHostFacts,
): DirectoryPickerBackendKind {
  if (interaction === 'browse') return 'browse'
  if (facts.bindHost !== '127.0.0.1') return 'browse'
  if (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return 'browse'
  if (present(facts.env.DSH_WEB_LOOPBACK_ORIGINS)) return 'browse'
  if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
