import assert from 'node:assert/strict'
import test from 'node:test'
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
