// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleSettings, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { FALLBACK_LOCALE, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
const make = (host?: StubSettingsScope<LocaleSettings>): {
  ctx: Context
  svc: LocaleRuntime
  events: LocaleSnapshot[]
} => {
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  return { ctx, svc: new LocaleRuntime(ctx, host?.scope), events }
}

/**
 * Pin the browser environment a fresh service reads its initial locale from.
 * This package's own specs stub the globals directly instead of using
 * `usePinnedBrowserLanguages` (dsh-client-test-runtime): they need the shapes
 * that helper deliberately cannot express — a missing `languages` list, a
 * list decoupled from `language`, and a non-browser run with no `window`.
 */
const stubLanguages = (...tags: string[]): void => {
  vi.stubGlobal('navigator', { languages: tags, language: tags[0] ?? '' })
}

describe('LocaleRuntime', () => {
  beforeEach(() => {
    // The only shipped locale is English; the browser sample must not change it.
    stubLanguages('en-US')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('translates through the namespace -> common -> key chain', () => {
    const { svc } = make()
    svc.register('ns', { hello: 'Hello', onlyNs: 'Namespace only' })
    svc.register('common', { retry: 'Retry' })
    const t = svc.bind('ns')
    expect(t('hello')).toBe('Hello')
    expect(t('retry')).toBe('Retry')
    expect(t('missing.key')).toBe('missing.key')
  })

  it('does not recurse inside the common namespace', () => {
    const { svc } = make()
    svc.register('common', { retry: 'Retry' })
    // (Wide-string ns hits the untyped bind overload — the typed one rejects
    // unknown keys at compile time, which is the point of the typed registry contract.)
    expect(svc.bind('common' as string)('nope')).toBe('nope')
  })

  it('interpolates {name} params and leaves unknown placeholders intact', () => {
    const { svc } = make()
    svc.register('ns', { greet: 'Hello, {name}!', partial: '{known} and {unknown}' })
    const t = svc.bind('ns')
    expect(t('greet', { name: 'world' })).toBe('Hello, world!')
    expect(t('partial', { known: 'A' })).toBe('A and {unknown}')
  })

  it('bind returns a stable per-namespace function identity', () => {
    const { svc } = make()
    expect(svc.bind('a')).toBe(svc.bind('a'))
    expect(svc.bind('a')).not.toBe(svc.bind('b'))
  })

  it('rejects a duplicate namespace and the disposer only removes its own dictionary', () => {
    const { svc } = make()
    const dispose = svc.register('ns', { k: 'v1' })
    expect(() => svc.register('ns', { k: 'v2' })).toThrow('already has a dictionary')
    const t = svc.bind('ns')
    dispose()
    expect(t('k')).toBe('k')
    svc.register('ns', { k: 'v2' })
    expect(t('k')).toBe('v2')
    dispose()
    expect(t('k')).toBe('v2')
  })

  it('serves the LocaleFace: revision moves on registration, subscribers fire, unsubscribe stops them', () => {
    const { svc } = make()
    const seen: number[] = []
    const off = svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
    expect(svc.getSnapshot()).toBe(svc.getLocale())
    const r0 = svc.getSnapshot().revision
    svc.register('ns', { k: 'v' })
    expect(svc.getSnapshot().revision).toBe(r0 + 1)
    expect(seen).toEqual([r0 + 1])
    off()
    svc.register('ns2', { k: 'v' })
    expect(seen).toHaveLength(1)
  })

  it('isolates a throwing subscriber: the rest still see the new revision', () => {
    const { svc } = make()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const seen: number[] = []
      svc.subscribe(() => { throw new Error('boom') })
      svc.subscribe(() => { seen.push(svc.getSnapshot().revision) })
      svc.register('ns', { k: 'v' })
      expect(seen).toEqual([1])
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('register disposer republishes (mounted outlets drop the dead dictionary)', () => {
    const { svc } = make()
    const dispose = svc.register('ns', { k: 'v' })
    const before = svc.getSnapshot().revision
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
    // Second run hits the idempotent arm: nothing removed, no republish.
    dispose()
    expect(svc.getSnapshot().revision).toBe(before + 1)
  })

  it('setLocale writes through the scope but republishes nothing when the locale is unchanged', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc, events } = make(host)
    expect(svc.getLocale().active).toBe('en')
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(host.set).toHaveBeenCalledWith('preference', 'en')
    expect(events).toHaveLength(0)
  })

  it('setLocale without a host scope stays process-local', () => {
    const { svc, events } = make()
    svc.setLocale('en')
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(0)
  })

  it('throws on unknown locale ids', () => {
    const { svc } = make()
    expect(() => { svc.setLocale('fr') }).toThrow('not registered')
  })

  it('adopts a Host preference without writing it back', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc, events } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    expect(events).toHaveLength(0)
    expect(host.set).not.toHaveBeenCalled()
    host.publish({ value: { preference: 'en' }, revision: 2 })
    expect(events).toHaveLength(0)
  })

  it('an absent Host preference returns to the default locale', () => {
    const host = stubSettingsScope<LocaleSettings>()
    const { svc } = make(host)
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(svc.getLocale().active).toBe('en')
    host.publish({ value: {}, revision: 2 })
    expect(svc.getLocale().active).toBe('en')
  })

  it('adopts a section already standing at construction and releases its subscription on dispose', async () => {
    const host = stubSettingsScope<LocaleSettings>()
    host.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    const { ctx, svc } = make(host)
    expect(svc.getLocale().active).toBe('en')
    expect(host.listenerCount()).toBe(1)
    await ctx.fiber.dispose()
    expect(host.listenerCount()).toBe(0)
  })

  it('opens in English regardless of the browser language', () => {
    stubLanguages('en-GB')
    expect(make().svc.getLocale().active).toBe('en')
    // Unshipped languages fall through to the product default.
    stubLanguages('fr-FR', 'de')
    expect(make().svc.getLocale().active).toBe('en')
    // Only `language` populated: an empty ordered list, and a host that
    // exposes no `languages` property at all.
    vi.stubGlobal('navigator', { languages: [], language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(make().svc.getLocale().active).toBe('en')
  })

  it('runs outside a browser: the default decides and the machine language does not', () => {
    vi.stubGlobal('window', undefined)
    // Node exposes its own global navigator; without a window it must not
    // reach the resolution at all.
    stubLanguages('zh-CN')
    const { svc } = make()
    expect(svc.getLocale().active).toBe('en')
    expect(() => { svc.setLocale('zh') }).toThrow('not registered')
  })

  it('serves English as the opening locale', () => {
    expect(FALLBACK_LOCALE).toBe('en')
    vi.stubGlobal('window', undefined)
    const { svc } = make()
    expect(svc.getLocale().active).toBe('en')
  })

  it('exposes the one shipped locale with a self-described label', () => {
    const { svc } = make()
    expect(svc.getLocale().locales).toEqual([{ id: 'en', label: 'English' }])
  })
})
