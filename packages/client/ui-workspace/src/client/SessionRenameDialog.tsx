/**
 * The Session rename dialog both sidebar section render sites show: the
 * browsing region and the Active Sessions section above it. Their rows offer the
 * same rename verb, so the two sites share this dialog and each owns the target
 * state behind it — a rename opened from either section is one modal, and the
 * other section's state stays untouched.
 *
 * The browsing region raises its dialog directly and keeps its state local, so a
 * successful rename unmounts the row that raised it without tearing down an
 * in-flight confirmation.
 */
import { useRef } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** One row's rename request: the target plus the title the draft starts from. */
export interface SessionRenameTarget {
  sessionId: SessionId
  currentTitle: string
}

/**
 * Render the Session rename modal.
 * @param props.target - the row being renamed; null closes the dialog.
 * @param props.draft - the edited title (trimmed before the host sees it).
 * @param props.renaming - true while the rename request is in flight; every
 * commit affordance disables, and an unchanged title is a valid commit.
 * @param props.error - host rejection message, shown in the alert region.
 * @param props.t - the owning section's locale seat (the `workspace` namespace).
 * @param props.onDraft - record one keystroke and clear the previous rejection.
 * @param props.onClose - dismiss without renaming.
 * @param props.onConfirm - commit the draft title.
 * @returns the rename modal.
 */
export function SessionRenameDialog({
  target, draft, renaming, error, t, onDraft, onClose, onConfirm,
}: {
  target: SessionRenameTarget | null
  draft: string
  renaming: boolean
  error: string | null
  t: WorkspaceBrowserProps['t']
  onDraft: (draft: string) => void
  onClose: () => void
  onConfirm: () => void
}) {
  // One flag for both render sites: the dialog is the only component that
  // reads an input-method composition.
  const composing = useRef(false)
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('rename.session.title')}
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={renaming || target === null} onClick={onConfirm}>{t('rename')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={t('field.sessionName')}
        autoFocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { onDraft(e.target.value) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(e) => {
          // The composing ref is the dialog's own: an input-method candidate
          // selection commits no rename.
          if (e.key === 'Enter' && !composing.current) {
            e.preventDefault()
            onConfirm()
          }
        }}
      />
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
