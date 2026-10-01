// Real composed file preview: local host bytes, browser sanitization, and network denial.
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./produced-files.overlay.yml', import.meta.url))
const SEED_ID = 'file-preview-web-e2e'
const DONE = 'PRODUCED_FILES_DONE'

/** A real workspace output selected from its produced-file chip. */
const PRODUCED = ['report.html'] as const

/** Build a settled write turn without calling a model. */
function producedFixture(): string {
  const session = Session.create(SessionId('produced-files-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Create the site files.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Produced files overflow', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  const calls = PRODUCED.map((path, index) => ({
    path,
    callId: CallId(`produced-files-${String(index)}`),
    args: JSON.stringify({ file_path: path, content: `content of ${path}\n` }),
  }))
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: call.callId,
        name: 'write',
        arguments: call.args,
      })),
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  for (const call of calls) {
    const source = session.append('tool/call', {
      turn: 1, step: 1, callId: call.callId, name: 'write', arguments: call.args,
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: call.callId,
        content: [{ type: 'text', text: `Created ${call.path}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
  }
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `Created the site.\n\n${DONE}` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
      createdAt: 0, cwd: '{{cwd}}',
    }),
    ...session.events.map(event => JSON.stringify({
      ...event, time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: workspace file previews', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const bundle = await readFile(new URL('../../../packages/client/ui-deliverables/lib/client.js', import.meta.url), 'utf8')
    expect(bundle).not.toMatch(/require\(["'](?:module|node:module|worker_threads|fs|node:fs)["']\)/)

    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await writeFile(join(scaffold.workspaceCwd, 'report.html'), '<h1>Local preview</h1><style>body{background-image:url(https://example.com/beacon)}</style><img src="https://example.com/image"><script>fetch("https://example.com/script")</script><a href="https://example.com/navigate">External link</a>')
    await seedSession(scaffold, producedFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // Keep the responsive sidebar available while selecting the cold seed;
    // the assertion itself narrows the conversation after navigation.
    await page.setViewportSize({ width: 1280, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 }).catch(async (error: unknown) => {
      throw new Error(`${String(error)}; page: ${await page.locator('body').innerText()}; errors: ${JSON.stringify(tripwire.pageErrors)}`)
    })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('previews a workspace HTML file without network requests or active content', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-preview'))
    const denied = await fetch(`${scaffold.baseUrl}/file-preview/read`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'preview-trust', method: 'read', payload: { sessionId: SEED_ID, path: 'report.html' } }),
    })
    expect(denied.status).toBe(403)
    const external: string[] = []
    page.on('request', (request) => { if (request.url().startsWith('https://example.com/')) external.push(request.url()) })
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText(DONE, { exact: true }).waitFor()
    await page.locator('[data-produced-files-row]').getByRole('button', { name: 'Open report.html', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'report.html', exact: true })
    await dialog.waitFor()
    const iframe = dialog.locator('iframe')
    await iframe.waitFor()
    const frame = page.frameLocator('iframe[title="Preview of report.html"]')
    await frame.getByRole('heading', { name: 'Local preview' }).waitFor()
    expect(await iframe.getAttribute('sandbox')).toBe('')
    expect(await frame.locator('a').getAttribute('href')).toBeNull()
    expect(await frame.locator('script,img').count()).toBe(0)
    expect(await frame.locator('body').innerText()).toMatchInlineSnapshot('"Local preview\nExternal link"')
    expect(external).toEqual([])
    await mkdir('.playwright-mcp', { recursive: true })
    await page.screenshot({ path: '.playwright-mcp/file-preview.png' })
    expect(tripwire.pageErrors).toEqual([])
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    expect(await dialog.count()).toBe(0)
  }, 90_000)
})
