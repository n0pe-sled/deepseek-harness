// @vitest-environment jsdom
/** Preview isolation, local conversion, and visible failure recovery. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilePreview } from '../src/client/FilePreview.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { zipSync, strToU8 } from 'fflate'
import { Workbook } from 'exceljs'
import { convertPreview } from '../src/client/preview-content.ts'

const limits = { expandedBytes: 40 * 1024 * 1024, entries: 10000, cells: 10000, columns: 100 }
const bytes = (value: string) => new TextEncoder().encode(value)
afterEach(cleanup)

describe('file preview', () => {
  it('converts DOCX headings locally and rejects oversized Office archives before conversion', async () => {
    const document = zipSync({
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Local document</w:t></w:r></w:p></w:body></w:document>'),
    })
    expect((await convertPreview('report.docx', document, limits)).html).toContain('<p>Local document</p>')
    await expect(convertPreview('report.docx', document, { ...limits, expandedBytes: 1 })).rejects.toThrow('archive limit')
    await expect(convertPreview('report.docx', document, { ...limits, entries: 1 })).rejects.toThrow('archive limit')
  })
  it('rejects forged ZIP sizes using actual inflated output', async () => {
    const archive = zipSync({ 'word/document.xml': strToU8('x'.repeat(20000)) })
    const view = new DataView(archive.buffer)
    for (let offset = 0; offset <= archive.length - 28; offset++) {
      const signature = view.getUint32(offset, true)
      if (signature === 0x04034b50) view.setUint32(offset + 22, 1, true)
      if (signature === 0x02014b50) view.setUint32(offset + 24, 1, true)
    }
    await expect(convertPreview('forged.docx', archive, { ...limits, expandedBytes: 100 })).rejects.toThrow('archive limit')
  })
  it('renders workbook sheet names and saved values with explicit truncation', async () => {
    const workbook = new Workbook()
    workbook.addWorksheet('Budget').addRows([['Name', 'Total'], ['Lunch', 12]])
    const data = new Uint8Array(await workbook.xlsx.writeBuffer())
    const result = await convertPreview('budget.xlsx', data, { ...limits, cells: 3 })
    expect(result.html).toContain('<h2>Budget</h2>')
    expect(result.html).toContain('<td>Lunch</td>')
    expect(result.truncated).toBe(true)
  })
  it('removes active content and all document network/navigation targets', async () => {
    const content = await convertPreview('report.html', bytes('<h1>Report</h1><style>body{background:url(https://deepseek.com/css)}</style><script>fetch("https://deepseek.com")</script><img src="https://deepseek.com/beacon"><a href="https://deepseek.com">link</a><form action="https://deepseek.com"><input></form>'), limits)
    expect(content.html).toContain('<h1>Report</h1>')
    expect(content.html).not.toContain('https://deepseek.com')
    expect(content.html).not.toContain('<script')
    expect(content.html).toContain('default-src &apos;none&apos;')
  })
  it('renders code as escaped text and rejects binary input', async () => {
    expect((await convertPreview('app.ts', bytes('const x = "<script>"'), limits)).html).toContain('&lt;script&gt;')
    await expect(convertPreview('file.bin', bytes('abc\0def'), limits)).rejects.toThrow('binary file')
  })
  it('opens a sandboxed frame and allows native-open and close', async () => {
    const openFile = vi.fn()
    const close = vi.fn()
    render(<FilePreview t={makeTranslate(en)} path="report.html" load={async () => ({ bytes: bytes('<h1>Report</h1>'), limits })} openFile={openFile} close={close} />)
    expect(screen.getByRole('status').textContent).toBe('Loading preview…')
    await waitFor(() =>{  expect(screen.getByTitle('Preview of report.html')).toBeTruthy() })
    expect(screen.getByTitle('Preview of report.html').getAttribute('sandbox')).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Open in default app' }))
    expect(openFile).toHaveBeenCalledWith('report.html')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalled()
  })
  it('shows read errors and aborts the pending request when unmounted', async () => {
    let signal: AbortSignal | undefined
    const view = render(<FilePreview t={makeTranslate(en)} path="missing.txt" load={async (_path, cancellation) => {
      signal = cancellation
      throw new Error('File missing')
    }} openFile={vi.fn()} close={vi.fn()} />)
    await waitFor(() =>{  expect(screen.getByRole('alert').textContent).toContain('File missing') })
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
