/** Node-half coverage for the model guidance paired with Web file references. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, inject } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-deliverables node plugin', () => {
  it('registers final-response file-reference guidance only while mounted', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'ui:deliverable-file-references')
    expect(section?.text).toMatchInlineSnapshot('"When you successfully create or modify files, mention the primary outputs in your final response. To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn."')

    await mounted.dispose()
    expect((await ctx.systemPrompt.assemble()).sections
      .some(entry => entry.name === 'ui:deliverable-file-references')).toBe(false)
  })
})

it('registers file reads only while its session and connection dependencies are mounted', async () => {
  const { Service } = await import('@deepseek-ai/cordis')
  const { default: Sessions } = await import('@deepseek-ai/dsh-session')
  const routes = new Map<string, unknown>()
  class Connection extends Service {
    constructor(owner: Context) { super(owner, 'connection') }
    get rpc() {
      const owner = this.ctx
      return {
        handle(channel: string, handler: unknown) {
          return owner.effect(() => {
            routes.set(channel, handler)
            return () => { routes.delete(channel) }
          })
        },
      }
    }
  }
  ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' }).await()
  await ctx.plugin(Sessions).await()
  await ctx.plugin(Connection).await()
  const mounted = ctx.plugin({ apply, inject })
  await mounted.await()
  expect(routes.has('/file-preview')).toBe(true)
  await mounted.dispose()
  expect(routes.size).toBe(0)
})
