/** `sidebar` namespace dictionaries: shell controls (brand row, New Session, fold toggle). */

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof en

/** The complete English dictionary. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
} satisfies Record<string, string>
