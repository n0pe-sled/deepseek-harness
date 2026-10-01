/** Local file preview with cancellation and an explicit native-open action. */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { convertPreview, type PreviewContent, type PreviewFile } from './preview-content.ts'
import css from './ProducedFiles.module.css'

/** File preview dependencies owned by the deliverables registration. */
export interface FilePreviewProps extends PropsLocale<typeof NS> {
  /** Workspace path to fetch. */
  path: string
  /** Read bytes through the current browser or desktop Connection. */
  load: (path: string, signal: AbortSignal) => Promise<PreviewFile>
  /** Close this preview. */
  close: () => void
  /** Open with the Host operating system. */
  openFile: (path: string) => void
}

/**
 * Display an isolated document preview and recoverable read/conversion errors.
 * @param props - selected file and host callbacks.
 * @returns A modal with read-only content.
 */
export function FilePreview({ path, load, close, openFile, t }: FilePreviewProps) {
  const [content, setContent] = useState<PreviewContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setContent(null)
    setError(null)
    void load(path, controller.signal).then(file => convertPreview(path, file.bytes, file.limits)).then((result) => {
      if (!controller.signal.aborted) setContent(result)
    }, (failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => { controller.abort() }
  }, [path, load])
  return <Modal open title={path} onClose={close} closeLabel={t('preview.close')} className={css.previewDialog ?? ''}
    footer={<button type="button" onClick={() => { openFile(path) }}>{t('preview.openNative')}</button>}>
    {error !== null ? <p role="alert">{t('preview.error', { message: error })}</p>
      : content === null ? <p role="status">{t('preview.loading')}</p>
        : <>
          {content.truncated && <p role="status">{t('preview.truncated')}</p>}
          <iframe title={t('preview.title', { path })} sandbox="" referrerPolicy="no-referrer" srcDoc={content.html} className={css.previewFrame} />
        </>}
  </Modal>
}
