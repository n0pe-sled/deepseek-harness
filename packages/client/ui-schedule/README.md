# @deepseek-ai/dsh-client-ui-schedule

Optional sidebar controls for the [Schedule plugin](../../schedule/schedule/README.md). Mount both plugins before creating or resuming a conversation. The clock button beside the sidebar’s New Session, Settings, and search controls opens a dialog for an instruction and natural-language timing, plus controls to list active schedules or cancel an exact id.

Escape or Close dismisses the dialog and returns focus to the clock. Switching conversations dismisses it. With no selected conversation, the dialog explains how to choose one and disables management actions.

Each action appends an editable request to the selected conversation’s current draft without submitting it or discarding existing text. A changed selection or busy draft refuses the action; it never redirects work to another conversation. Send the request to let the configured model call `schedule_create`, `schedule_list`, or `schedule_delete`. Creation requests explicitly select task execution; reminder-only records remain reminders. Results and tool details appear in the conversation's existing transcript.

## Model Experience

### Management request

#### What the model sees

The submitted draft asks the model to create a task with `mode: "task"`, list schedules, or delete an exact id. Task instructions, timing, and ids are JSON-escaped in the prepared text. Draft preparation itself makes no model request.

#### Token effect

Each submitted management request and its tool results add ordinary conversation tokens. The controls register no model tools or prompt sections.

#### KV Cache effect

A submitted request appends to conversation history without replacing the existing prefix.

## Known Limitations and Deferred Work

- Scheduling is session-local. The host must be running and the original conversation live. Reopening it processes overdue tasks; the UI states this restriction before creation.
- Management requires a configured model and user submission. The form is not an authoritative task catalog; tool results confirm mutations.
- Timing accepts the Schedule plugin's one-shot and fixed-interval rules, with recurring intervals of at least five minutes. Calendar and cron scheduling are unavailable.
