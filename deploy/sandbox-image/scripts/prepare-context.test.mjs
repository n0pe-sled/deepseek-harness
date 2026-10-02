/**
 * Plugin discovery for the sandbox image context.
 *
 * The image serves two architectures from one payload, so what it discovers is
 * also what it refuses: an attacker or scratch plugin directory sitting in the
 * checkout must never be built into the image, and a checkout that carries no
 * plugin at all must fail the build rather than produce an image that quietly
 * ships none. Both trees are read, because the plugins beside this script hold the
 * ones only the image needs.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { discoverContextPlugins } from './prepare-context.mjs'

const dirs = []

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** Create a scratch harness checkout with both plugin trees. */
function makeCheckout() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-context-'))
  dirs.push(root)
  mkdirSync(join(root, 'plugins'), { recursive: true })
  mkdirSync(join(root, 'deploy', 'sandbox-image'), { recursive: true })
  return root
}

/** The checkout directory holding this script, which owns the second plugin tree. */
function sandboxRootOf(root) {
  return join(root, 'deploy', 'sandbox-image')
}

/** Write one plugin directory into one of the two trees. */
function addPlugin(root, tree, name) {
  const dir = tree === 'sandbox'
    ? join(sandboxRootOf(root), 'plugins', name)
    : join(root, 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-${name}` }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
}

describe('discoverContextPlugins', () => {
  it('merges both plugin trees', () => {
    const root = makeCheckout()
    addPlugin(root, 'harness', 'fork-plugin')
    addPlugin(root, 'sandbox', 'dsh-instance-manager')
    const names = discoverContextPlugins(root, { sandboxRoot: sandboxRootOf(root) }).map((plugin) => plugin.name)
    assert.deepEqual(names, ['dsh-instance-manager', 'fork-plugin'])
  })

  it('refuses an excluded directory that IS present', () => {
    const root = makeCheckout()
    addPlugin(root, 'harness', 'fork-plugin')
    addPlugin(root, 'harness', 'crescendo-attacker')
    addPlugin(root, 'sandbox', 'web-search-searxng')
    const names = discoverContextPlugins(root, { sandboxRoot: sandboxRootOf(root) }).map((plugin) => plugin.name)
    assert.deepEqual(names, ['fork-plugin'])
  })

  it('fails when the checkout carries no plugin', () => {
    const root = makeCheckout()
    assert.throws(() => discoverContextPlugins(root, { sandboxRoot: sandboxRootOf(root) }), /no plugin packages found/)
  })

  it('skips a directory that holds no bundle patch layer', () => {
    const root = makeCheckout()
    const dir = join(root, 'plugins', 'no-patch')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-no-patch' }))
    addPlugin(root, 'harness', 'fork-plugin')
    const names = discoverContextPlugins(root, { sandboxRoot: sandboxRootOf(root) }).map((plugin) => plugin.name)
    assert.deepEqual(names, ['fork-plugin'])
  })
})
