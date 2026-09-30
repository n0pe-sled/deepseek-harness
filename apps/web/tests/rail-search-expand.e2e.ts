// Web e2e scenario: the collapsed rail's search control in the real event
// order. The rail click opens the shared search store state and requests the
// sidebar expansion in one gesture; once the column slides wide, the shell
// renders the box under its control row and the box focuses itself. The
// outside-click dismissal the rail entry once needed is gone on purpose — the
// wide trigger is an ordinary disclosure and the box's clear control is the
// only closer (packages/client/ui-workspace, the search seats of
// 2026-09-25-sidebar-header-controls-and-pinned-sessions) — so this scenario
// pins that an outside click leaves the box open.
//
// Zero model calls: collapsing the sidebar and expanding the search are pure
// client layout gestures; the scenario needs no session content at all.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** WorkspaceBrowser's search-box focus delay (EXPAND_SLIDE_MS) plus flush headroom. */
const FOCUS_SETTLE_MS = 600

describe('web e2e: one rail search click lands the focused box and stays open', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the sidebar into the focused search box from one rail click', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rail-search-expand'))
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    const railSearch = page.getByRole('button', { name: 'Search sessions' })
    // The wide chrome stays mounted through the 150ms collapse crossfade; the
    // rail control (no aria-expanded) replaces it at settle.
    await expect.poll(async () => railSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBeNull()

    // The one real click under test: it must expand the sidebar AND leave the
    // search open through the flip.
    await railSearch.click()

    const wideToggle = page.getByRole('button', { name: 'Close session search' })
    await expect.poll(async () => wideToggle.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    const input = page.getByPlaceholder('Search sessions...')
    await expect.poll(
      async () => input.evaluate(el => document.activeElement === el),
      { timeout: FOCUS_SETTLE_MS + 10_000 },
    ).toBe(true)

    // The box is not an outside-click popover: a genuine outside click on an
    // empty query keeps it open, and the wide toggle still reads expanded.
    await page.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(async () => wideToggle.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    await input.waitFor({ timeout: 10_000 })

    // The box's clear control is the only closer: it resets the query and
    // collapses the box in one gesture, renaming the toggle back to its
    // closed label.
    await page.getByRole('button', { name: 'Clear search' }).click()
    const reopenedToggle = page.getByRole('button', { name: 'Open session search' })
    await expect.poll(async () => reopenedToggle.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => input.count(), { timeout: 10_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
