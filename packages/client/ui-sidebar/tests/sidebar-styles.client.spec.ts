/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

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

describe('SidebarRoot.module.css', () => {
  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('12px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
    expect(declarations('.collapsed .regionArea')?.get('margin-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('padding-left')).toBe('0')
    expect(declarations('.collapsed .regionArea')?.get('margin-right')).toBe('0')
  })

  it('moves the four upper controls while the settings seat only fades', () => {
    const animation = 'rail-in 150ms var(--ds-ease-in-out) backwards'
    for (const selector of [
      '.railIn .iconButton',
      '.railIn .newSession',
      '.railIn .regionArea',
    ]) {
      expect(declarations(selector)?.get('animation')).toBe(animation)
    }
    expect(declarations('.railIn .footArea')?.get('animation')).toBe(
      'rail-fade-in 150ms var(--ds-ease-in-out) backwards',
    )
    expect(css).toMatch(
      /@keyframes rail-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(49px\);\s*}\s*}/,
    )
    expect(css).toMatch(/@keyframes rail-fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*}\s*}/)
  })

  it('gives shell rail controls the same base anchor for their shared translation', () => {
    expect(declarations('.collapsed .logoRow')?.get('justify-content')).toBe('flex-start')
    expect(declarations('.newSession')?.get('width')).toBe('36px')
    expect(declarations('.newSession')?.get('border-radius')).toBe('12px')
  })

  it('keeps the slotted brand row at the full artwork height, centered', () => {
    expect(declarations('.brandMark')?.get('flex')).toBe('none')
    expect(declarations('.brandName')?.get('flex')).toBe('1')
    expect(declarations('.brandName')?.get('justify-content')).toBe('center')
    expect(declarations('.brandName')?.get('height')).toBe('24px')
    expect(declarations('.brandName')?.get('line-height')).toBe('24px')
    expect(declarations('.brandName')?.get('font-size')).toBe('18px')
    expect(declarations('.fallbackBrandName')?.get('font-size')).toBe('17px')
    expect(declarations('.fallbackBrandName')?.get('white-space')).toBe('nowrap')
  })

  it('pairs the New Session icon control with its header-action occupants', () => {
    expect(declarations('.controlRow')?.get('display')).toBe('flex')
    expect(declarations('.headerActions')?.get('display')).toBe('flex')
    expect(declarations('.newSession')?.get('height')).toBe('36px')
    expect(declarations('.newSession')?.get('border-radius')).toBe('12px')
    // The rail has no header-action occupants: the row collapses to the shell's
    // own icon control.
    expect(css).not.toContain('.collapsed .headerActions')
  })

  it('seats the settings trigger in the control row and the search box under it', () => {
    // The seat places the occupant beside New Session without owning its box.
    expect(declarations('.settingsSeat')?.get('flex')).toBe('none')
    expect(declarations('.settingsSeat')?.get('display')).toBe('flex')
    expect(declarations('.settingsSeat')?.get('align-items')).toBe('center')
    // The search region spans the column's content width, wide only.
    expect(declarations('.headerSearch')?.get('flex')).toBe('none')
    expect(declarations('.headerSearch')?.get('display')).toBe('flex')
    expect(declarations('.headerSearch')?.get('width')).toBe('100%')
    expect(css).not.toContain('.collapsed .headerSearch')
  })

  it('spans both foot seats across the column and centers them in the rail', () => {
    expect(declarations('.footArea')?.get('flex-direction')).toBe('column')
    expect(declarations('.settingsArea')?.get('flex')).toBe('none')
    expect(declarations('.settingsArea')?.get('width')).toBe('100%')
    expect(declarations('.footerActions')?.get('flex')).toBe('none')
    expect(declarations('.footerActions')?.get('width')).toBe('100%')
    expect(declarations('.collapsed .footArea')?.get('align-items')).toBe('center')
    expect(declarations('.collapsed .settingsArea')?.get('display')).toBe('flex')
    expect(declarations('.collapsed .settingsArea')?.get('width')).toBe('auto')
    expect(declarations('.collapsed .footerActions')?.get('justify-content')).toBe('center')
    expect(declarations('.collapsed .footerActions')?.get('width')).toBe('auto')
  })
})
