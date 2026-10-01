/** Optional sidebar controls for scheduling work through the current model. */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, type ScheduleKey } from './locales.ts'
import { ScheduleControls } from './ScheduleControls.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Scheduled-task sidebar copy. */
    schedule: ScheduleKey
  }
}

/** The sidebar owns the toolbar slot; the conversation service owns draft mutations. */
export const inject = ['slots', 'locale', 'sessions', 'conversation']

/**
 * Register the task dialog in the sidebar while this optional plugin is mounted.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('schedule', en), 'ui-schedule: dictionaries')
  ctx.slots.inject('sidebar.header.action', () => ctx.slots.register({
    name: 'sidebar.header.action',
    id: 'schedule',
    locale: 'schedule',
    order: 20,
    inject: () => ({
      prepare: (sessionId: SessionId | undefined, request: string): boolean => {
        if (sessionId === undefined || ctx.sessions.list.getSnapshot().current !== sessionId) return false
        const scope = ctx.sessions.scope(sessionId)
        if (scope === undefined) return false
        const input = ctx.conversation.input.for(scope)
        const state = input.state.getSnapshot()
        if (state.phase !== 'plain') return false
        input.setDraft(state.draft.length === 0 ? request : `${state.draft}\n\n${request}`)
        return true
      },
    }),
  }, ScheduleControls))
}
