/** Sandbox image channels follow the desktop release version and checked-out commit. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * Return publish tags without allowing prereleases to replace stable images.
 * @param {string} image Registry image name without a tag.
 * @param {string} version Desktop release version.
 * @param {string} revision Full checked-out Git commit SHA.
 * @returns {string[]} Mutable channel and release tags plus commit-qualified tags.
 */
export function imageTags(image, version, revision) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('Invalid release version')
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('Expected full checked-out commit SHA')
  const prerelease = version.includes('-')
  if (prerelease && !/-beta\.\d+$/u.test(version)) throw new Error('Unsupported prerelease channel')
  return [
    `${image}:${prerelease ? 'beta' : 'latest'}`,
    `${image}:v${version}`,
    `${image}:${version}-${revision}`,
    `${image}:sha-${revision}`,
  ]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const meta = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${meta.releaseVersion}`) {
    throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} does not match desktop version ${meta.releaseVersion}`)
  }
  console.log(`tags=${imageTags(process.env.IMAGE, meta.releaseVersion, meta.revision).join(',')}`)
  console.log(`version=${meta.releaseVersion}`)
  console.log(`revision=${meta.revision}`)
}
