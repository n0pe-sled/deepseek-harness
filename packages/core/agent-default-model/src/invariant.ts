/**
 * Package-owned invariant companion for the default Agent model selection.
 *
 * The service owns no independent event relationship: settings registration
 * already validates every mutable value before `currentSelection()` can observe it,
 * and an unselected section is a value its schema accepts rather than a state
 * another event could contradict. The empty installer keeps that absence explicit
 * in composed invariant sets.
 *
 * @module @deepseek-ai/dsh-agent-default-model/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-default-model'

/** Cordis companion plugin name. */
export const name = 'agent-default-model-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: settings validation owns the only mutable-value relationship, and "no selection" is a valid resolved value. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
