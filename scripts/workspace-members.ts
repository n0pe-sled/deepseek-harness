/**
 * Workspace member declarations from `pnpm-workspace.yaml`.
 *
 * A reader that hardcodes its own member globs drifts from the workspace file the
 * moment that file changes. `apps/desktop` is the case: the workspace file
 * excludes it with a negated declaration, and every reader that walked `apps/*`
 * itself kept treating the private Electron shell as a release member.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'

const root = join(import.meta.dirname, '..')

/**
 * The `packages:` members exactly as `pnpm-workspace.yaml` declares them,
 * negations included.
 * @param rel - Workspace file path relative to the repository root.
 * @returns every declared member, in file order.
 */
export function workspaceMembers(rel: string): string[] {
  const declared = (yaml.load(readFileSync(join(root, rel), 'utf8')) as { packages?: unknown }).packages
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`${rel} declares no workspace members; the manifest set cannot be derived.`)
  }
  return declared.map(member => String(member))
}

/**
 * The members a negated declaration excludes, without the `!` and any trailing
 * slash, as repository-relative directory paths.
 *
 * Read through the same YAML loader the workspace file itself uses, so a comment or
 * quoting inside the `packages:` list cannot truncate the declaration.
 * @param members - Declarations from {@link workspaceMembers}.
 * @returns each excluded directory path.
 */
export function workspaceExclusions(members: readonly string[]): string[] {
  return members
    .filter(member => member.startsWith('!'))
    .map(member => member.slice(1).replace(/\/$/, ''))
}

/**
 * Glob form of the negated declarations, for `globSync`'s `exclude` option.
 *
 * A negation cannot be handed to `globSync` directly: that API reads a leading
 * `!` as part of the name rather than as a negation, so a negated member's
 * manifests would be read straight back in.
 * @param members - Declarations from {@link workspaceMembers}.
 * @returns one `exclude` glob per excluded member.
 */
export function workspaceExcludeGlobs(members: readonly string[]): string[] {
  return workspaceExclusions(members).map(directory => `${directory}/**`)
}
