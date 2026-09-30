/**
 * Settings chrome style contracts. The trigger is seated in the sidebar's icon
 * control row, so the label that names its button has to stay out of the layout:
 * a label the reader could see would restore the text the row replaced.
 *
 * jsdom loads no stylesheet here, so the rule is read from its own source, the
 * way the sidebar shell's style spec reads the sidebar sheet.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/chrome.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('settings chrome styles', () => {
  it('takes the trigger label out of the layout and keeps it clip-sized', () => {
    const label = declarations('.hiddenLabel')
    expect(label?.get('position')).toBe('absolute')
    expect(label?.get('width')).toBe('1px')
    expect(label?.get('height')).toBe('1px')
    expect(label?.get('overflow')).toBe('hidden')
    expect(label?.get('white-space')).toBe('nowrap')
  })
})
