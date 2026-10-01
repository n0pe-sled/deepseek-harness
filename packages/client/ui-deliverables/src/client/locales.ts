/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** English dictionary (same key set). */
export const en = {
  'preview.close': 'Close',
  'preview.openNative': 'Open in default app',
  'preview.loading': 'Loading preview…',
  'preview.error': 'Preview unavailable: {message}',
  'preview.truncated': 'Preview truncated at the configured row/column limits. Open the workbook to see all data.',
  'preview.title': 'Preview of {path}',
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.showInFolder': 'Show in folder',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof en
