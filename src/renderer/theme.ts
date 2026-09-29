/**
 * Shell theming. Both shell pages (the top bar and the instance manager) paint
 * from the active dsh theme, so the mapping from theme tokens to CSS variables
 * lives here rather than in either page.
 */
import type { AppTheme } from '../shared/ipc.ts'

/** Paint a shell page to match the active dsh theme. */
export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement
  root.style.colorScheme = theme.colorScheme
  root.style.setProperty('--bg', theme.background)
  root.style.setProperty('--panel', theme.panel)
  root.style.setProperty('--border', theme.border)
  root.style.setProperty('--text', theme.text)
  root.style.setProperty('--muted', theme.subtext)
  root.style.setProperty('--accent', theme.accent)
  root.style.setProperty('--on-accent', contrastForeground(theme.accent))
}

/**
 * Pick a readable foreground for a hex background: dark text on a light accent,
 * white on a dark one.
 * @param hex - the accent color, `#rrggbb`.
 * @returns the foreground color.
 */
export function contrastForeground(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}/u.test(hex)) return '#ffffff'
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#1a1d23' : '#ffffff'
}
