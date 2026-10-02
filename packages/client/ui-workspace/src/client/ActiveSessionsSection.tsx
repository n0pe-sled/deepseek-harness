/**
 * The sidebar shell's Active Sessions region: the live sessions as rows above
 * the Workspace browsing region. The section renders every Session the runtime
 * reports as running or as blocked on a user interaction, so a long run stays in
 * reach however far down its Workspace group has scrolled, and it renders
 * nothing at all while no session is active.
 *
 * Its rows are the ordinary Session row (status dots, hover card, menu) with no
 * drag wiring, because the section is a live view rather than an order
 * authority: a drag there would move a row against the recency order the section
 * renders in. A session listed here keeps its Workspace membership and its
 * position in the Host's order, so it renders both here and inside its group.
 */
import { useMemo, useState } from 'react'
import type { ActiveSessionsSectionProps } from './contract/slots.ts'
import { deriveActive, type SessionNode } from './tree.ts'
import { SessionNodeItem } from './rows/Rows.tsx'
import { SessionRenameDialog, type SessionRenameTarget } from './SessionRenameDialog.tsx'
import css from './WorkspaceBrowser.module.css'

/**
 * Render the Active Sessions section.
 * @param props - shell owner share, viewing store, injected actions, and the locale seat.
 * @returns the section, or nothing while no session is active.
 */
export function ActiveSessionsSection({
  wide, useSessions, useWorkspaces, useStore, actions, open, forkSession,
  renameSession, archiveSession, t,
}: ActiveSessionsSectionProps) {
  const sessionList = useSessions(s => s)
  const archivedSessionIds = useWorkspaces(s => s.archivedSessionIds)
  // The pin list is viewing state, so it rides the browser's own store rather
  // than the Workspace list snapshot.
  const pinnedSessionIds = useStore(s => s.pinnedSessionIds)
  const activeNodes = useMemo(
    () => deriveActive(sessionList, archivedSessionIds),
    [sessionList, archivedSessionIds],
  )
  // Every row here offers the same pin verb as its grouped row; the stored-id
  // list is the one both read for the label either one shows.
  const pinnedIdSet = useMemo(() => new Set(pinnedSessionIds), [pinnedSessionIds])
  // Rename state is local to this section, the same block the browsing region
  // keeps: the shared dialog serves whichever section raised it.
  const [renameTarget, setRenameTarget] = useState<SessionRenameTarget | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameBlocked = renaming || renameDraft.trim() === '' || renameTarget === null
  const closeRename = (): void => {
    if (renaming) return
    setRenameTarget(null)
    setRenameError(null)
  }
  const confirmRename = (): void => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    renameSession(renameTarget.sessionId, renameDraft.trim()).then(() => {
      setRenaming(false)
      setRenameTarget(null)
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  const onSessionRename = (sessionId: SessionNode['id'], currentTitle: string): void => {
    setRenameTarget({ sessionId, currentTitle })
    setRenameDraft(currentTitle)
    setRenameError(null)
  }
  // Archive is dialog-free: not destructive (the log and the accounting slot
  // remain), so the menu action commits directly and the row disappears when
  // the archive-set echo lands.
  const onSessionArchive = (sessionId: SessionNode['id']): void => {
    archiveSession(sessionId).catch((reason: unknown) => {
      console.warn('session archive rejected:', reason)
    })
  }
  const onPinToggle = (sessionId: SessionNode['id']): void => {
    if (pinnedIdSet.has(sessionId)) actions.unpinSession(sessionId)
    else actions.pinSession(sessionId)
  }
  // The dialog renders as part of this component rather than beside the
  // section's own markup, so it survives the frames where the section itself
  // renders nothing.
  const dialog = (
    <SessionRenameDialog
      target={renameTarget}
      draft={renameDraft}
      renaming={renaming}
      error={renameError}
      t={t}
      onDraft={(next) => { setRenameDraft(next); setRenameError(null) }}
      onClose={closeRename}
      onConfirm={confirmRename}
    />
  )
  if (!wide || activeNodes.length === 0) return dialog
  const now = Date.now()
  return (
    <>
      <section className={css.activeSection} aria-label={t('section.active')}>
        <div className={css.activeLabel}>{t('section.active')}</div>
        {activeNodes.map(node => (
          <SessionNodeItem
            key={`active-${node.id}`}
            node={node}
            currentId={sessionList.current}
            now={now}
            onOpen={open}
            onRename={onSessionRename}
            onFork={forkSession}
            onArchive={onSessionArchive}
            onPinToggle={onPinToggle}
            pinned={pinnedIdSet.has(node.id)}
            t={t}
          />
        ))}
      </section>
      {dialog}
    </>
  )
}
