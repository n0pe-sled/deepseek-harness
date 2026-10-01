import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { copyRuntimeDependencies } from './runtime-dependencies.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (dir, pkg) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
    return dir
  }
  return { root, put }
}
test('copies transitive production dependencies without dev dependencies or harness peers', (t) => {
  const { root, put } = fixture(t)
  put(root, { dependencies: { parser: '1.0.0', '@deepseek-ai/dsh-settings': '1' }, devDependencies: { compiler: '1' } })
  put(join(root, 'node_modules/parser'), { name: 'parser', dependencies: { arg: '2' } })
  put(join(root, 'node_modules/arg'), { name: 'arg', version: '2' })
  const out = join(root, 'out')
  copyRuntimeDependencies(root, out)
  assert.ok(existsSync(join(out, 'parser/node_modules/arg/package.json')))
  assert.ok(!existsSync(join(out, 'compiler')))
  assert.ok(!existsSync(join(out, '@deepseek-ai')))
})
test('missing locked runtime dependency aborts staging', (t) => {
  const { root, put } = fixture(t)
  put(root, { dependencies: { 'missing-fixture-dependency': '1' } })
  assert.throws(() => copyRuntimeDependencies(root, join(root, 'out')), /Missing locked/)
})
test('native runtime dependency cannot enter a shared architecture payload', (t) => {
  const { root, put } = fixture(t)
  put(root, { dependencies: { native: '1' } })
  const native = put(join(root, 'node_modules/native'), { name: 'native' })
  writeFileSync(join(native, 'binding.node'), '')
  assert.throws(() => copyRuntimeDependencies(root, join(root, 'out')), /Native plugin/)
})
test('platform-specific runtime packages abort staging', (t) => {
  const { root, put } = fixture(t)
  put(root, { dependencies: { native: '1' } })
  put(join(root, 'node_modules/native'), { name: 'native', os: ['linux'] })
  assert.throws(() => copyRuntimeDependencies(root, join(root, 'out')), /Platform-specific/)
})
