/** Conversational schedule management; every action prepares a draft for user review. */
import { useEffect, useRef, useState } from 'react'
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './ScheduleControls.module.css'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Injected draft mutation; false leaves the panel open without changing another conversation. */
export interface ScheduleActions {
  /** Append only when the selected conversation still matches and its draft is editable. */
  prepare: (sessionId: SessionId | undefined, request: string) => boolean
}

/**
 * Open scheduled-task management from the sidebar toolbar.
 * @param props - Sidebar hooks, locale, and selected-conversation draft mutation.
 * @returns Clock button and an accessible task dialog.
 */
export function ScheduleControls({ useSessions, prepare, t }: Pick<PropsRuntime<'sidebar.header.action'>, 'useSessions'> & ScheduleActions & PropsLocale<'schedule'>) {
  const current = useSessions(state => state.current)
  const [opened, setOpened] = useState<{ sessionId: SessionId | undefined }>()
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => { setOpened(undefined) }, [current])
  const close = () => {
    setOpened(undefined)
    trigger.current?.focus()
  }
  return <>
    <Tooltip label={t('title')} side="bottom" delayMs={500}>
      <button ref={trigger} type="button" className={css['trigger']} aria-label={t('title')}
        aria-haspopup="dialog" aria-expanded={opened !== undefined && opened.sessionId === current}
        onClick={() => { setOpened({ sessionId: current }) }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
    {opened !== undefined && opened.sessionId === current &&
      <SchedulePanel sessionId={current} prepare={prepare} close={close} t={t} />}
  </>
}

/** Local dialog fields are discarded on close or conversation selection changes. */
function SchedulePanel({ sessionId, prepare: append, close, t }: ScheduleActions & PropsLocale<'schedule'> & {
  sessionId: SessionId | undefined
  close: () => void
}) {
  const firstInput = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    firstInput.current?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const controls = panel.current?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')
      if (controls === undefined || controls.length === 0) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap) }
  }, [])
  const [instruction, setInstruction] = useState('')
  const [timing, setTiming] = useState('')
  const [taskId, setTaskId] = useState('')
  const prepare = (request: string) => {
    if (append(sessionId, request)) close()
    else setError(true)
  }
  return <Modal open onClose={close} title={t('title')} closeLabel={t('close')} className={css['dialog'] ?? ''}>
    <div ref={panel} className={css['form']}>
      {sessionId === undefined && <p role="status">{t('noSession')}</p>}
      {error && <p role="alert">{t('draftUnavailable')}</p>}
      <p>{t('limitation')}</p>
      <label>{t('instruction')} <input ref={firstInput} value={instruction} onChange={(event) => { setInstruction(event.target.value) }} placeholder={t('instructionPlaceholder')} /></label>
      <label>{t('when')} <input value={timing} onChange={(event) => { setTiming(event.target.value) }} placeholder={t('whenPlaceholder')} /></label>
      <button type="button" disabled={sessionId === undefined || !instruction.trim() || !timing.trim()} onClick={() => {
        prepare(`Create a scheduled task using schedule_create with mode "task". Execute this instruction: ${JSON.stringify(instruction.trim())}. Timing: ${JSON.stringify(timing.trim())}. Ask me if the timing is ambiguous. Confirm the saved schedule and its session-local delivery limitation.`)
      }}>{t('prepare')}</button>
      <button type="button" disabled={sessionId === undefined} onClick={() => { prepare('Use schedule_list to show the active reminders and scheduled tasks in this conversation, including ids and next run times.') }}>{t('list')}</button>
      <label>{t('id')} <input value={taskId} onChange={(event) => { setTaskId(event.target.value) }} placeholder={t('idPlaceholder')} /></label>
      <button type="button" disabled={sessionId === undefined || !taskId.trim()} onClick={() => {
        prepare(`Use schedule_delete to cancel the schedule with exact id ${JSON.stringify(taskId.trim())} in this conversation.`)
      }}>{t('cancel')}</button>
      <p>{t('review')}</p>
    </div>
  </Modal>
}
