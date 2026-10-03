/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-agent-plugin-host`.
 * @module @deepseek-ai/dsh-agent-plugin-host/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-plugin-host'

/** Cordis companion plugin name. */
export const name = 'agent-plugin-host-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the installed bundle contributes through the skill
 * registry and a bounded set of delegation rows, and this host exposes no
 * independent bundle-to-registration snapshot after a re-read.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
