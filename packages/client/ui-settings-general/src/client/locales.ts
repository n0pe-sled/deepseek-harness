/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** The settings namespace key union. */
export type SettingsKey = keyof typeof en

/** The complete English dictionary. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
} satisfies Record<string, string>
