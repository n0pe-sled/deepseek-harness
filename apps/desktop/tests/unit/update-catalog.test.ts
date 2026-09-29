/**
 * The release request and where its token comes from.
 *
 * The repository is private, so a request without a token cannot read it. The two
 * cases that matter are the ones that must not look alike: a missing token, and a
 * token the host refuses.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findGh, listReleases, readGhToken } from '../../src/main/update/catalog.ts'

/** A response carrying a JSON body, for a fetch that never leaves this process. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('readGhToken', () => {
  it('prefers GH_TOKEN over GITHUB_TOKEN', async () => {
    const token = await readGhToken(
      { GH_TOKEN: 'first', GITHUB_TOKEN: 'second' },
      '',
      () => Promise.resolve('from-gh'),
      [],
    )
    expect(token).toBe('first')
  })

  it('falls back to GITHUB_TOKEN, then to the gh CLI', async () => {
    const fromEnv = await readGhToken({ GITHUB_TOKEN: 'second' }, '', () => Promise.resolve('from-gh'), [])
    expect(fromEnv).toBe('second')

    // The fake stands in for the CLI, because whether this machine has gh is not
    // something these cases may depend on.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gh-'))
    const fake = join(dir, 'gh')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    const fromGh = await readGhToken({}, dir, () => Promise.resolve('from-gh'), [])
    expect(fromGh).toBe('from-gh')
  })

  it('ignores a blank variable rather than authenticating with nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gh-'))
    const fake = join(dir, 'gh')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    const token = await readGhToken({ GH_TOKEN: '   ' }, dir, () => Promise.resolve('from-gh'), [])
    expect(token).toBe('from-gh')
  })

  it('answers undefined when no gh is on PATH', async () => {
    const token = await readGhToken({}, '/nonexistent', () => Promise.resolve('from-gh'), [])
    expect(token).toBeUndefined()
  })

  it('answers undefined when gh is installed but signed out', async () => {
    // A signed-out gh is the common case on a machine that has the CLI, and it
    // must read as "no token" rather than as a failed check.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gh-'))
    const fake = join(dir, 'gh')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    const token = await readGhToken({}, dir, () => Promise.resolve(undefined), [])
    expect(token).toBeUndefined()
  })

  it('reads the token through a gh it found outside PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gh-'))
    const fake = join(dir, 'gh')
    writeFileSync(fake, '#!/bin/sh\necho token-from-fake-gh\n', { mode: 0o755 })
    expect(findGh('/nonexistent', [dir])).toBe(fake)

    // The fake stands in for the CLI a Finder launch cannot see on PATH.
    const token = await readGhToken({}, '/nonexistent', undefined, [dir])
    expect(token).toBe('token-from-fake-gh')
  })
})

describe('findGh', () => {
  it('searches PATH before the install directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gh-path-'))
    const fake = join(dir, 'gh')
    writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
    expect(findGh(dir, ['/opt/homebrew/bin'])).toBe(fake)
  })

  it('answers undefined when gh is nowhere it searches', () => {
    expect(findGh('/nonexistent', ['/also-nonexistent'])).toBeUndefined()
  })

  it('skips an empty PATH entry rather than searching the current directory', () => {
    expect(findGh(':/nonexistent', [])).toBeUndefined()
  })
})

describe('listReleases', () => {
  it('keeps the fields the check reads and drops the rest', async () => {
    const catalog = await listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.resolve(jsonResponse([{
        tag_name: 'v0.1.5',
        name: 'DSH Desktop 0.1.5',
        body: 'notes',
        draft: false,
        prerelease: false,
        html_url: 'https://example.test/release',
        published_at: '2026-09-29T00:00:00Z',
        junk: 'dropped',
        assets: [{ name: 'a.dmg', browser_download_url: 'https://example.test/a.dmg', size: 12, junk: 1 }],
      }])),
    })
    expect(catalog.repo).toBe('owner/repo')
    expect(catalog.releases).toHaveLength(1)
    expect(catalog.releases[0]).toEqual({
      tag: 'v0.1.5',
      name: 'DSH Desktop 0.1.5',
      body: 'notes',
      draft: false,
      prerelease: false,
      htmlUrl: 'https://example.test/release',
      publishedAt: '2026-09-29T00:00:00Z',
      assets: [{ name: 'a.dmg', url: 'https://example.test/a.dmg', size: 12 }],
    })
  })

  it('sends the token as an authorization header and nothing else', async () => {
    let seen: RequestInit | undefined
    await listReleases({
      repo: 'owner/repo',
      token: 'secret-token',
      fetchImpl: (_url, init) => {
        seen = init
        return Promise.resolve(jsonResponse([]))
      },
    })
    const headers = seen?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(seen?.body).toBeUndefined()
    expect(JSON.stringify(seen)).not.toContain('Bearer token')
  })

  it('sends no authorization header when there is no token', async () => {
    let seen: RequestInit | undefined
    await listReleases({
      repo: 'owner/repo',
      fetchImpl: (_url, init) => {
        seen = init
        return Promise.resolve(jsonResponse([]))
      },
    })
    const headers = seen?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('names a missing token when a private repository answers 404', async () => {
    // GitHub answers 404 for a private repository rather than 403, so this is the
    // common failure and it has to say what is actually wrong.
    await expect(listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.resolve(jsonResponse({ message: 'Not Found' }, 404)),
    })).rejects.toThrow(/no token was found/u)
  })

  it('names the status when a credentialed request is refused', async () => {
    await expect(listReleases({
      repo: 'owner/repo',
      token: 'expired',
      fetchImpl: () => Promise.resolve(jsonResponse({ message: 'Bad credentials' }, 401)),
    })).rejects.toThrow('GitHub returned HTTP 401 reading owner/repo releases')
  })

  it('never puts the token in an error message', async () => {
    const failure = await listReleases({
      repo: 'owner/repo',
      token: 'super-secret',
      fetchImpl: () => Promise.resolve(jsonResponse({}, 500)),
    }).catch((error: unknown) => String(error))
    expect(String(failure)).not.toContain('super-secret')
  })

  it('names the network cause when the request never lands', async () => {
    await expect(listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    })).rejects.toThrow('could not reach GitHub (https://api.github.com): getaddrinfo ENOTFOUND')
  })

  it('refuses a response that is not a list of releases', async () => {
    await expect(listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.resolve(jsonResponse({ message: 'rate limited' })),
    })).rejects.toThrow('GitHub returned an unexpected releases response')
  })

  it('drops an entry with no tag rather than offering an empty version', async () => {
    const catalog = await listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.resolve(jsonResponse([
        { name: 'no tag' },
        { tag_name: '   ' },
        { tag_name: 'v0.1.5' },
      ])),
    })
    expect(catalog.releases.map((release) => release.tag)).toEqual(['v0.1.5'])
  })

  it('drops an asset with no download URL', async () => {
    const catalog = await listReleases({
      repo: 'owner/repo',
      fetchImpl: () => Promise.resolve(jsonResponse([{
        tag_name: 'v0.1.5',
        assets: [{ name: 'a.dmg' }, { browser_download_url: 'https://example.test/a.dmg' }, 'junk'],
      }])),
    })
    expect(catalog.releases[0]?.assets).toEqual([])
  })
})
