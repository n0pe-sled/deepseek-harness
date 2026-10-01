// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TestRoot, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { ScheduleControls, type ScheduleActions } from '../src/client/ScheduleControls.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

function mount(draft = '', selected: SessionId | undefined = 's1' as SessionId) {
  let current: SessionId | undefined = selected
  const setDraft = vi.fn()
  const prepare = vi.fn((_sessionId: SessionId | undefined, request: string) => {
    setDraft(draft ? `${draft}\n\n${request}` : request)
    return true
  })
  const useSessions: Parameters<typeof ScheduleControls>[0]['useSessions'] = selector => selector({
    ids: [], byId: {}, current, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const component = () => <ScheduleControls useSessions={useSessions} prepare={prepare} t={makeTranslate(en, commonEn)} />
  const view = render(component())
  fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
  return { setDraft, prepare, switchSession: (id: SessionId | undefined) => { current = id; view.rerender(component()) } }
}

describe('scheduled task draft controls', () => {
  it('prepares explicit task instructions while preserving an existing draft and requiring Send', () => {
    const actions = mount('Keep my draft')
    expect(screen.getByText(/only while this conversation is live/)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Prepare task' }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Task instruction'), { target: { value: 'Read logs' } })
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'Every hour' } })
    fireEvent.click(screen.getByRole('button', { name: 'Prepare task' }))
    expect(actions.setDraft).toHaveBeenCalledWith(expect.stringContaining('Keep my draft\n\nCreate a scheduled task using schedule_create with mode "task".'))
    expect(actions.setDraft).toHaveBeenCalledWith(expect.stringContaining('Timing: "Every hour"'))

  })

  it('prepares listing and cancellation requests without submitting them', () => {
    const actions = mount()
    fireEvent.click(screen.getByRole('button', { name: 'List tasks' }))
    expect(actions.setDraft).toHaveBeenCalledWith(expect.stringContaining('Use schedule_list'))
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Prepare cancellation' }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Task id'), { target: { value: 'schedule-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Prepare cancellation' }))
    expect(actions.setDraft).toHaveBeenLastCalledWith('Use schedule_delete to cancel the schedule with exact id "schedule-1" in this conversation.')

  })

  it('disables management without a conversation and returns focus on Escape', () => {
    const actions = mount()
    actions.switchSession(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Scheduled tasks' }))
    expect(screen.getByRole('status').textContent).toContain('Choose a workspace')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'List tasks' }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Scheduled tasks' }))
  })

  it('dismisses on selection changes and does not reopen when returning', () => {
    const actions = mount()
    actions.switchSession('s2' as SessionId)
    expect(screen.queryByRole('dialog')).toBeNull()
    actions.switchSession('s1' as SessionId)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.prepare).not.toHaveBeenCalled()
  })

  it('traps focus including the modal close button and reports rejected draft writes', () => {
    const actions = mount()
    const close = screen.getByRole('button', { name: 'Close scheduled tasks' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Task id'))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    actions.prepare.mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'List tasks' }))
    expect(screen.getByRole('alert').textContent).toContain('draft is busy')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('appends the latest draft only to the still-selected editable conversation', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const sessionId = 's1' as SessionId
    let phase = 'plain'
    const setDraft = vi.fn()
    ctx.provide('sessions', { list: { getSnapshot: () => ({ current: sessionId }) }, scope: () => ctx } as never)
    ctx.provide('conversation', { input: { for: () => ({
      state: { getSnapshot: () => ({ draft: 'Latest draft', phase }) }, setDraft,
    }) } } as never)
    const root = new TestRoot(ctx.slots, async (action) => { await action() })
    await root.declare({ 'sidebar.header.action': { kind: 'list', scope: 'root' } }, () => null)
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    const injection = ctx.slots.entries('sidebar.header.action')[0]?.inject as unknown as (() => ScheduleActions)
    const actions = injection()
    expect(actions.prepare(undefined, 'list')).toBe(false)
    expect(actions.prepare('s2' as SessionId, 'list')).toBe(false)
    phase = 'submitting'
    expect(actions.prepare(sessionId, 'list')).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    phase = 'plain'
    expect(actions.prepare(sessionId, 'list')).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('Latest draft\n\nlist')
    await ctx.fiber.dispose()
  })

  it('removes its sidebar registration on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('sessions', {} as never)
    ctx.provide('conversation', {} as never)
    const root = new TestRoot(ctx.slots, async (action) => { await action() })
    await root.declare({ 'sidebar.header.action': { kind: 'list', scope: 'root' } }, () => null)
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.header.action')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.header.action')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
