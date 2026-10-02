/** Keyless scheduled-task delivery through the runnable Web Schedule composition. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { launchWebScaffold } from './scaffold.ts'

class TaskAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Scheduled task result: the requested report is ready.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Web scheduled task transcript', () => {
  it('delivers saved instructions as a later task turn with ordinary assistant output', async () => {
    const scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../../../examples/web-schedule/cordis.yml', import.meta.url)),
    })
    const adapter = new TaskAdapter()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['scheduled-task-test'], adapter))
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('scheduled-task-snapshot'),
      meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'scheduled-task-test', model: 'local-fixture' },
    })
    try {
      const result = await scaffold.ctx.tools.execute({
        signal: AbortSignal.timeout(10_000),
        callId: CallId('create-scheduled-task'),
        name: 'schedule_create',
        arguments: { prompt: 'Prepare the requested report.', after_seconds: 1, mode: 'task' },
        agent: handle.agent,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ mode: 'task', deliveryMode: 'session-local' })
      await expect.poll(() => adapter.requests.length, { timeout: 15_000 }).toBe(1)
      await handle.agent.whenIdle()
      const requestText = adapter.requests[0]?.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(requestText).toContain('[SCHEDULED TASK]\nExecute the saved user task')
      expect(requestText).toContain('Follow current permissions and approval requirements.')
      expect(requestText).toContain('task_prompt_json: "Prepare the requested report."')
      const transcript = handle.agent.session.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content)
      expect(transcript).toMatchInlineSnapshot(`
        [
          {
            "text": "Scheduled task result: the requested report is ready.",
            "type": "text",
          },
        ]
      `)
      expect(handle.agent.session.events.filter(event => event.type === 'schedule/change' && event.data.operation === 'dispatch')).toHaveLength(1)
    } finally {
      await handle.dispose()
      await scaffold.close()
    }
  }, 60_000)
})
