/** Scheduled-task sidebar dictionary. */
export const en = {
  title: 'Scheduled tasks',
  close: 'Close scheduled tasks',
  noSession: 'Choose a workspace or open a conversation to prepare a scheduled task.',
  draftUnavailable: 'This conversation changed or its draft is busy. Close this panel and try again.',
  limitation: 'Tasks run only while this conversation is live and the host is running. Reopen the conversation to process overdue tasks. Results and tool details appear in this conversation.',
  instruction: 'Task instruction',
  instructionPlaceholder: 'Summarize files in my project',
  when: 'When',
  whenPlaceholder: 'In 10 minutes, or every hour',
  prepare: 'Prepare task',
  list: 'List tasks',
  id: 'Task id',
  idPlaceholder: 'Id from List tasks',
  cancel: 'Prepare cancellation',
  review: 'These buttons add an editable request to your draft. Send it to apply the change. Recurring intervals must be at least five minutes.',
} satisfies Record<string, string>

/** Dictionary keys for the scheduled-task controls. */
export type ScheduleKey = keyof typeof en
