import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

function fixture(): Map<string, Buffer> {
  const base = '2026-07-26-example'
  const source = Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n')
  return new Map([
    [`process/${base}.md`, source],
  ])
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one complete implemented English note', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it('rejects invalid archive headers and removed bilingual sidecars', () => {
    const artifacts = fixture()
    artifacts.set(
      'process/2026-07-26-example.md',
      Buffer.from('# Agent Note: Example\n\nStatus: proposed\nArchived: yesterday\n'),
    )
    artifacts.set('process/2026-07-26-example.zh.md', Buffer.from('# Agent Note: Example\n'))
    artifacts.set('process/2026-07-26-example.i18n.yaml', Buffer.from('example.md: abc\n'))
    const errors = validateArchiveArtifacts(artifacts).join('\n')
    expect(errors).toMatch(/line 3 must be `Status: implemented`/)
    expect(errors).toMatch(/bilingual sidecars are removed/)
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(1)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.md')
    expect(extendArchiveManifest(sealed, changed).errors).toContain(
      'process/2026-07-26-example.md: sealed artifact is missing',
    )
  })

  it('retains sealed bilingual sidecar entries without requiring their files', () => {
    const artifacts = fixture()
    const first = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const sealed: ArchiveManifest = {
      version: 1,
      files: {
        ...first.files,
        'process/2026-07-26-example.zh.md': `sha256:${'b'.repeat(64)}`,
        'process/2026-07-26-example.i18n.yaml': `sha256:${'c'.repeat(64)}`,
      },
    }
    const extension = extendArchiveManifest(sealed, artifacts)
    expect(extension.errors).toEqual([])
    expect(extension.files['process/2026-07-26-example.zh.md']).toBe(`sha256:${'b'.repeat(64)}`)
    expect(validateArchiveManifestExtension(sealed, sealed)).toEqual([])
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(extendArchiveManifest(current, changedArtifacts).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([
      `${path}: sealed manifest hash changed`,
    ])
    const removed: ArchiveManifest = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    }
    expect(validateArchiveManifestExtension(baseline, removed)).toContain(
      `${path}: sealed manifest entry is missing`,
    )
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
