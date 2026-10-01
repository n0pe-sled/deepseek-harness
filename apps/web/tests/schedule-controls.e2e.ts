/** Scheduled-task composer controls through the real optional Web composition. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./snapshots/plan-narrow-viewport/session.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./snapshots/schedule-controls/sidebar.expected.md', import.meta.url))
const OVERLAY = fileURLToPath(new URL('../../../examples/web-schedule/cordis.yml', import.meta.url))

describe('web: optional scheduled-task controls', () => {
  it.each([false, true])('mounts controls only with the Schedule overlay: %s', async (enabled) => {
    const scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      ...(enabled ? { extraOverlayPath: OVERLAY } : {}),
    })
    const browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    page.setDefaultTimeout(15_000)
    const consoleErrors = watchConsole(page)
    try {
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      const clock = page.getByRole('button', { name: 'Scheduled tasks', exact: true })
      if (enabled) {
        await clock.click()
        await page.getByRole('status').filter({ hasText: 'Choose a workspace' }).waitFor()
        expect(await page.getByRole('button', { name: 'List tasks', exact: true }).isDisabled()).toBe(true)
        await page.keyboard.press('Escape')
        expect(await clock.evaluate(node => document.activeElement === node)).toBe(true)
      }
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const input = page.locator('textarea:enabled').last()
      await input.waitFor()
      const launcher = page.getByRole('button', { name: 'Scheduled tasks', exact: true })
      if (!enabled) {
        expect(await launcher.count()).toBe(0)
        return
      }
      expect(await page.locator('[class*=headerActions]').getByRole('button', { name: 'Scheduled tasks', exact: true }).count()).toBe(1)
      expect(await launcher.locator('svg').count()).toBe(1)
      expect(await page.locator('[class*=inputDock]').getByRole('button', { name: 'Scheduled tasks', exact: true }).count()).toBe(0)
      await input.fill('Preserve this draft')
      await launcher.click()
      await page.getByText(/Tasks run only while this conversation is live and the host is running/).waitFor()
      await page.getByLabel('Task instruction', { exact: true }).fill('Summarize project files')
      await page.getByLabel('When', { exact: true }).fill('Every hour')
      await saveFailureShot(page, 'schedule-controls-sidebar')
      const panel = page.getByRole('dialog', { name: 'Scheduled tasks', exact: true })
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      await compareOrRefreshGolden(GOLDEN, `Sidebar toolbar: clock button\n${await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)}`, webSnapshotMode())
      await page.getByRole('button', { name: 'Prepare task', exact: true }).click()
      expect(await input.inputValue()).toContain('Preserve this draft\n\nCreate a scheduled task using schedule_create with mode "task".')
      expect(await input.inputValue()).toContain('Timing: "Every hour"')
      await input.fill('')
      await launcher.click()
      await page.getByRole('button', { name: 'List tasks', exact: true }).click()
      expect(await input.inputValue()).toContain('Use schedule_list')
      await input.fill('')
      await launcher.click()
      await page.getByLabel('Task id', { exact: true }).fill('schedule-1')
      await page.getByRole('button', { name: 'Prepare cancellation', exact: true }).click()
      expect(await input.inputValue()).toBe('Use schedule_delete to cancel the schedule with exact id "schedule-1" in this conversation.')
      expect(scaffold.ctx.agents.roots().some(agent => agent.session.events.some(event => event.type === 'user/message' || event.type === 'schedule/change'))).toBe(false)
      expect(consoleErrors.pageErrors).toEqual([])
    } catch (error: unknown) {
      await saveFailureShot(page, `schedule-controls-failure-${String(enabled)}`)
      throw error
    } finally {
      await browser.close()
      await scaffold.close()
    }
  }, 60_000)
})
