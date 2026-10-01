/**
 * Deliverables plugin, node half. Registers the response-format guidance that
 * lets the browser half recognize final-response file references. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { readPreviewFile } from './preview-file.ts'

/** Services required for the model guidance paired with the browser renderer. */
export const inject = ['systemPrompt']

/** Local file preview limits. */
export interface Config {
  /** Maximum compressed/source bytes loaded per preview. */
  maxPreviewBytes: number
  /** Maximum total declared bytes in an Office ZIP archive. */
  maxPreviewExpandedBytes: number
  /** Maximum ZIP members in one Office document. */
  maxPreviewEntries: number
  /** Maximum rendered workbook cells. */
  maxPreviewCells: number
  /** Maximum rendered columns per workbook row. */
  maxPreviewColumns: number
}

/** Validated deployment limit; previews never upload content to a converter. */
export const Config: z<Config> = z.object({
  maxPreviewExpandedBytes: z.number().min(1).step(1).default(40 * 1024 * 1024),
  maxPreviewEntries: z.number().min(1).step(1).default(10000),
  maxPreviewCells: z.number().min(1).step(1).default(10000),
  maxPreviewColumns: z.number().min(1).step(1).default(100),
  maxPreviewBytes: z.number().min(1).max(100 * 1024 * 1024).step(1).default(10 * 1024 * 1024),
})

const previewRequest = schema.object({ sessionId: schema.string().min(1), path: schema.string().min(1).max(4096) }).strict()

/** Stable final-response guidance owned by the matching renderer. */
const FILE_REFERENCE_PROMPT = 'When you successfully create or modify files, mention the primary outputs in your final response. '
  + 'To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn.'

/**
 * Register model guidance for the file-reference renderer shipped by this package.
 * @param ctx - host context carrying the system-prompt registry.
 * @param config - deployment file-size limit.
 */
export function apply(ctx: Context, config: Config = {
  maxPreviewBytes: 10 * 1024 * 1024,
  maxPreviewExpandedBytes: 40 * 1024 * 1024,
  maxPreviewEntries: 10000,
  maxPreviewCells: 10000,
  maxPreviewColumns: 100,
}): void {
  ctx.inject(['sessions', 'connection'], (scope) => {
    const connection = scope.get('connection') as unknown as HostConnectionHandle
    connection.rpc.handle('/file-preview', async (endpoint, payload, signal) => {
      if (endpoint !== 'read') return { ok: false, error: { code: 'bad-request', message: 'Unknown preview operation', details: { issues: [] } } }
      const parsed = previewRequest.safeParse(payload)
      if (!parsed.success) return { ok: false, error: { code: 'bad-request', message: 'Invalid file preview request', details: { issues: [] } } }
      const session = scope.sessions.get(SessionId(parsed.data.sessionId))
      const cwd = session?.header.cwd
      if (cwd === undefined) return { ok: false, error: { code: 'bad-request', message: 'Open a session with a workspace to preview files', details: { issues: [] } } }
      try {
        const base64 = await readPreviewFile(cwd, parsed.data.path, config.maxPreviewBytes, signal)
        return { ok: true, value: { base64, limits: {
          expandedBytes: config.maxPreviewExpandedBytes,
          entries: config.maxPreviewEntries,
          cells: config.maxPreviewCells,
          columns: config.maxPreviewColumns,
        } } }
      } catch (error: unknown) {
        return { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error), details: { issues: [] } } }
      }
    }, { authority: 'trusted-host' })
  })
  ctx.systemPrompt.section({
    name: 'ui:deliverable-file-references',
    order: 190,
    text: FILE_REFERENCE_PROMPT,
  })
}
