/** `command` namespace dictionaries (the popupSelect shell's copy). */

/** The command namespace key union. */
export type CommandKey = keyof typeof en

/** The complete English dictionary. */
export const en = {
  'search.placeholder': 'Search…',
  'search.aria': 'Filter options',
  'status.loading': 'Loading options…',
  'status.applying': 'Applying…',
  'status.empty': 'No options',
  'overlay.aria': '/{command} options',
  'listbox.aria': '/{command} matches',
  'notice.imagesUnsupported': '/{command} does not accept image attachments; remove them first',
} satisfies Record<string, string>
