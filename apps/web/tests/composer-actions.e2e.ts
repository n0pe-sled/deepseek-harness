/** Composer actions through the shipped web composition, without a model request. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/composer-actions/actions.expected.md', import.meta.url))

describe('web: composer actions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayProvidersOnly: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 800)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'composer-example.csv'), 'name,value\nexample,42\n')
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('offers workspace references, native image selection, and existing commands', async () => {
    const input = page.locator('textarea').first()
    const launcher = page.getByRole('button', { name: 'Commands' })
    await launcher.click()
    const labels = await page.getByRole('menuitem').allTextContents()
    await page.getByRole('menuitem', { name: 'Add workspace files' }).click()
    expect(await input.inputValue()).toBe('@')
    await input.fill('@composer-example')
    const candidate = page.getByRole('option').filter({ hasText: 'composer-example.csv' }).first()
    await candidate.waitFor()
    await candidate.click()
    expect(await input.inputValue()).toContain('composer-example.csv')
    await input.fill('')
    await launcher.click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: 'Attach images' }).click()
    expect((await fileChooser).isMultiple()).toBe(true)
    await launcher.click()
    await page.getByRole('menuitem', { name: 'Run commands' }).click()
    await page.getByRole('option').filter({ hasText: 'plan' }).first().waitFor()
    await compareOrRefreshGolden(GOLDEN, `${labels.join('\n')}\nWorkspace reference selected: composer-example.csv\nNative image picker: multiple\nRegistered commands: available`, webSnapshotMode())
  })
})
