import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageTags } from './image-tags.mjs'
const image = 'ghcr.io/n0pe-sled/dsh-sandbox'
const revision = 'a'.repeat(40)

test('beta publication cannot move stable tags', () => {
  const tags = imageTags(image, '0.1.6-beta.1', revision)
  assert.deepEqual(tags, [`${image}:beta`, `${image}:v0.1.6-beta.1`, `${image}:0.1.6-beta.1-${revision}`, `${image}:sha-${revision}`])
  assert.ok(!tags.includes(`${image}:latest`))
  assert.ok(!tags.includes(`${image}:v0.1.1-rc.2`))
})
test('stable publication retains latest and version tags', () => {
  assert.equal(imageTags(image, '0.1.6', revision)[0], `${image}:latest`)
  assert.equal(imageTags(image, '0.1.6', revision)[1], `${image}:v0.1.6`)
})
test('invalid release identity fails before publication', () => {
  assert.throws(() => imageTags(image, '0.1.6-rc.1', revision))
  assert.throws(() => imageTags(image, '0.1.6-beta.1', 'abc123'))
  assert.throws(() => imageTags(image, 'bad\nlatest', revision))
})

test('tagged CLI rejects a stale desktop version before emitting publish tags', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-image-tags-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const meta = join(directory, 'meta.json')
  writeFileSync(meta, JSON.stringify({ releaseVersion: '0.1.6', revision }))
  const run = (tag) => spawnSync(process.execPath, [fileURLToPath(new URL('./image-tags.mjs', import.meta.url)), meta], {
    encoding: 'utf8',
    env: { ...process.env, IMAGE: image, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag },
  })
  const mismatch = run('v0.1.6-beta.1')
  assert.notEqual(mismatch.status, 0)
  assert.equal(mismatch.stdout, '')
  assert.match(mismatch.stderr, /does not match desktop version/)
  const matching = run('v0.1.6')
  assert.equal(matching.status, 0)
  assert.match(matching.stdout, /:latest,/)
})
