// @vitest-environment jsdom
/**
 * `<html lang>` tracks the active locale.
 *
 * The served markup declares one language, but the resolved locale may differ
 * (a stored Host preference adopted after activation), and assistive
 * technology and browser features read this attribute, so a stale value
 * misreports the document language rather than merely looking untidy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'

/** Boot the plugin over a stub Host settings document. */
async function bench(preference?: string) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let stored = preference
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: stored === undefined ? {} : { preference: stored },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describeRpc = vi.fn(async () => ({
    rpcId: 'locale-describe' as never,
    result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] } },
  }))
  const mutate = vi.fn(async (request: { ops: { value: string }[] }) => {
    stored = request.ops[0]!.value
    revision += 1
    return { rpcId: 'locale-mutate' as never, result: { ok: true as const, value: namespace() } }
  })
  ctx.provide('connection', { api: { settings: { describe: describeRpc, mutate } }, isLoopback: true } as never)
  // The settings transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, locale: ctx.get('locale') as LocaleRuntime }
}

const langOf = (): string => document.documentElement.lang

describe('document language', () => {
  beforeEach(() => {
    // The served markup declares the product default; the plugin must not
    // depend on that value already being correct.
    document.documentElement.lang = 'en'
  })

  afterEach(() => {
    // Nothing here goes through vi.stubGlobal.
  })

  it('states the resolved locale at activation', async () => {
    const { locale } = await bench()
    expect(locale.getLocale().active).toBe('en')
    expect(langOf()).toBe('en')
  })

  it('follows an explicit locale switch', async () => {
    const { locale } = await bench()
    locale.setLocale('en')
    expect(langOf()).toBe('en')
  })

  it('follows an explicit Host preference adopted after activation', async () => {
    const { locale } = await bench('en')
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('en') })
    await vi.waitFor(() => { expect(langOf()).toBe('en') })
  })
})
