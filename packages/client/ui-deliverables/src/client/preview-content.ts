/** Local document conversion; frames deny network, scripts, forms, and navigation. */
import mammoth from 'mammoth/mammoth.browser.js'
import ExcelJS from 'exceljs/dist/exceljs.min.js'
import DOMPurify from 'dompurify'
import { Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate/browser'

/** Deployment limits received with the bounded file response. */
export interface PreviewLimits {
  expandedBytes: number
  entries: number
  cells: number
  columns: number
}

/** File content and rendering limits from the local Host. */
export interface PreviewFile {
  bytes: Uint8Array
  limits: PreviewLimits
}

/** Renderable local document content. */
export interface PreviewContent {
  /** Sanitized, self-contained HTML. */
  html: string
  /** Notice when workbook cells were omitted. */
  truncated: boolean
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
}

/**
 * Convert supported files without remote converters or active document content.
 * @param path - file name used to choose the local reader.
 * @param bytes - bounded source bytes.
 * @param limits - validated deployment archive and workbook limits.
 * @returns HTML for a sandboxed, network-denied frame.
 */
export async function convertPreview(path: string, bytes: Uint8Array, limits: PreviewLimits): Promise<PreviewContent> {
  const extension = path.split('.').pop()?.toLowerCase()
  if (extension === 'docx' || extension === 'xlsx') bytes = boundedArchive(bytes, limits)
  let html: string
  let truncated = false
  if (extension === 'docx') {
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer }, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
    })
    html = result.value
  } else if (extension === 'xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes.slice().buffer)
    const sheets: string[] = []
    let remaining = limits.cells
    for (const sheet of workbook.worksheets) {
      const rows: string[] = []
      sheet.eachRow((row) => {
        if (remaining <= 0) { truncated = true; return }
        const cells: string[] = []
        const count = Math.min(row.cellCount, limits.columns, remaining)
        if (count < row.cellCount) truncated = true
        for (let column = 1; column <= count; column++) cells.push(`<td>${escape(row.getCell(column).text)}</td>`)
        remaining -= count
        rows.push(`<tr>${cells.join('')}</tr>`)
      })
      sheets.push(`<h2>${escape(sheet.name)}</h2><table>${rows.join('')}</table>`)
    }
    html = sheets.join('')
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('This binary file format is not supported for preview')
    html = extension === 'html' || extension === 'htm' ? text : `<pre>${escape(text)}</pre>`
  }
  const safe = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'audio', 'video', 'source', 'img', 'svg', 'math'],
    FORBID_ATTR: ['style', 'background', 'poster', 'href', 'src', 'srcset', 'action', 'formaction', 'ping', 'download', 'target'],
  })
  return {
    html: '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; base-uri &apos;none&apos;; form-action &apos;none&apos;;">'
      + '<style>html{color-scheme:light;background:Canvas;color:CanvasText}body{font-family:system-ui,sans-serif;padding:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid;padding:6px}</style>'
      + `</head><body>${safe}</body></html>`,
    truncated,
  }
}


/** Repack bounded, actually inflated bytes so Office readers never trust forged ZIP sizes. */
function boundedArchive(bytes: Uint8Array, limits: PreviewLimits): Uint8Array {
  let declared = 0
  let count = 0
  unzipSync(bytes, { filter: (entry) => {
    declared += entry.originalSize
    if (declared > limits.expandedBytes || ++count > limits.entries) throw new Error('Office document exceeds the preview archive limit')
    return false
  } })
  let actual = 0
  let entries = 0
  const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>
  const unzip = new Unzip((file) => {
    if (++entries > limits.entries) throw new Error('Office document exceeds the preview archive limit')
    const chunks: Uint8Array[] = []
    let size = 0
    file.ondata = (error, chunk, final) => {
      if (error !== null) throw error
      actual += chunk.length
      size += chunk.length
      if (actual > limits.expandedBytes) throw new Error('Office document exceeds the preview archive limit')
      chunks.push(chunk)
      if (final) {
        const content = new Uint8Array(size)
        let offset = 0
        for (const part of chunks) { content.set(part, offset); offset += part.length }
        files[file.name] = content
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // Small compressed chunks bound temporary inflate output before the byte check.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
  }
  return zipSync(files, { level: 0 })
}
