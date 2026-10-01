/** Copy locked, platform-independent plugin runtime dependencies for both image architectures. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function locate(start, name) {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) throw new Error(`Missing locked runtime dependency: ${name}`)
  }
}

function rejectNative(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    if (entry.isDirectory()) rejectNative(join(dir, entry.name))
    else if (entry.name.endsWith('.node')) throw new Error(`Native plugin runtime dependency requires target-specific staging: ${dir}`)
  }
}

/**
 * Copy production dependencies, leaving harness peers to the per-target harness closure.
 * @param {string} source Installed package directory with its locked dependencies.
 * @param {string} destination Output node_modules directory.
 * @param {Set<string>} ancestors Real package directories in the current dependency chain.
 * @returns {void}
 */
export function copyRuntimeDependencies(source, destination, ancestors = new Set()) {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (pkg.os || pkg.cpu) throw new Error(`Platform-specific plugin dependency requires target-specific staging: ${pkg.name}`)
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (name.startsWith('@deepseek-ai/')) continue
    const resolved = locate(source, name)
    if (ancestors.has(resolved)) throw new Error(`Cyclic plugin runtime dependency: ${name}`)
    rejectNative(resolved)
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolved, target, { recursive: true, dereference: true, filter: (path) => basename(path) !== 'node_modules' })
    copyRuntimeDependencies(resolved, join(target, 'node_modules'), new Set([...ancestors, resolved]))
  }
}
