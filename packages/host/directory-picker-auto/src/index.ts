/**
 * Adaptive chooser of the directory-picker seam: the deployment's requested
 * interaction decides between the in-app browser (`browse`, the default) and the
 * OS chooser on the host display (`native`), and one boot-time sample of the
 * host's situation (bind host, SSH launch, remote-browser origins, display
 * session, Linux chooser binary) can still downgrade a requested `native` to
 * `browse`. The matching interaction — `native` or `browse` — is mounted as
 * real Loader entries in the in-memory root tree. Each interaction is a pair:
 * the Host backend serving the seam capability and the client surface occupying
 * ui-workspace's directory-flow holes. Both arrive as ordinary entries, so the
 * surface is discovered exactly as a config-row's would be and one resolved
 * choice still swaps both faces.
 * @module @deepseek-ai/dsh-host-directory-picker-auto
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `loader` and `webServer` Context merges for the reads below.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { canExecute, hasLinuxChooserBinary } from './probe.ts'
import type { DirectoryPickerBackendKind, DirectoryPickerInteraction } from './resolve.ts'
import { resolveDirectoryPickerBackend } from './resolve.ts'

export { canExecute, hasLinuxChooserBinary } from './probe.ts'
export type {
  DirectoryPickerBackendKind, DirectoryPickerEnv, DirectoryPickerHostFacts, DirectoryPickerInteraction,
} from './resolve.ts'
export { resolveDirectoryPickerBackend } from './resolve.ts'

/** Cordis plugin name. */
export const name = 'directory-picker-auto'
/** Required services: the effective bind host (`webServer`) and the entry tree the backend mounts into (`loader`). */
export const inject = ['webServer', 'loader']

/** Plugin config: the interaction this deployment's operators pick directories with. */
export interface Config {
  /**
   * `browse` serves the in-app browser whose own path field and folder
   * creation reach a host display nobody is sitting at — every client of this
   * deployment is then served the same way, including a local one. `native`
   * opens the OS chooser on the host display instead, and is downgraded to
   * `browse` on a host that cannot serve it (see
   * {@link resolveDirectoryPickerBackend}). Default: `browse`.
   */
  interaction: DirectoryPickerInteraction
}

export const Config: z<Config> = z.object({
  interaction: z.union([z.const('browse'), z.const('native')]).default('browse'),
})

/**
 * Host backend package per resolved kind — fixed composition vocabulary, not a
 * tunable. Exported because the reference is a runtime string the static
 * config gate cannot see in a yml row: `verify-cordis-config` requires every
 * app composing this chooser to declare both values as dependencies.
 */
export const BACKEND_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-host-directory-picker-native',
  browse: '@deepseek-ai/dsh-host-directory-picker-browse',
}

/**
 * Client surface package per resolved kind, mounted with its backend so one
 * resolved interaction still composes both faces. Declared as dependencies by
 * every composing app for the same reason as {@link BACKEND_PACKAGES}. Only the
 * specifier is referenced here — the packages belong to the Client program, so
 * no import of them exists on this side and knip needs them ignored for this
 * workspace.
 */
export const SURFACE_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-client-ui-directory-picker-native',
  browse: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
}

/**
 * Resolve the interaction from the requested one plus one boot-time sample of the
 * host facts, and mount its backend and surface as Loader entries; the effect's
 * disposer removes both entries and joins their fibers' teardown, so unloading
 * this plugin returns only after both faces of the mounted interaction (and their
 * dependents) quiesced.
 * @param ctx - cordis context carrying the injected `webServer` and `loader`.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const backend = resolveDirectoryPickerBackend(config?.interaction ?? 'browse', {
    bindHost: ctx.webServer.host,
    platform: process.platform,
    env: process.env,
    linuxChooser: hasLinuxChooserBinary(process.env.PATH, canExecute),
  })
  await ctx.effect(async () => {
    // Root-tree create: the Loader root is in-memory (write() is a no-op), so
    // the mounted rows can never be persisted back into a config file. The
    // backend lands first: the surface's browser half drives the capability
    // the backend registers.
    const ids: string[] = []
    const unmount = async () => {
      for (const id of [...ids].reverse()) {
        // Tree teardown (group.stop) can have removed the entry already;
        // nothing is left to unmount or await then.
        if (ctx.loader.store[id] === undefined) continue
        // remove() disposes the entry transactionally, so the chooser's unload
        // signals completion only after that face quiesced.
        await ctx.loader.remove(id)
      }
    }
    try {
      for (const name of [BACKEND_PACKAGES[backend], SURFACE_PACKAGES[backend]]) {
        ids.push(await ctx.loader.create({ name }))
      }
    } catch (cause) {
      // Setup owns the entries it created until it returns the disposer: leaving
      // the backend mounted would make a retry collide with its own
      // directoryPicker registration.
      await unmount()
      throw cause
    }
    return unmount
  }, 'directory-picker-auto: interaction entries')
}
