/**
 * Shell chrome content registered into the shell's trigger/header seats: the
 * trigger icon and the panel title text. The trigger paints the settings glyph in
 * both column widths and keeps its label visually hidden, because the shell seats
 * it in the icon control row beside the New Session control while the button's
 * accessible name is that label. The shell renders the surrounding chrome
 * (button, nav heading row).
 */
import { IconSettingsOutline14, IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './chrome.module.css'

/** Trigger content props: the sidebar column state + the standard locale seat. */
export type TriggerContentProps = PropsRuntime<'settings.trigger'> & PropsLocale<'settings'>

/** Header content props: the standard locale seat only. */
export type HeaderContentProps = PropsRuntime<'settings.header'> & PropsLocale<'settings'>

/**
 * Render the trigger content: the settings glyph, plus the label that names
 * the button it sits in.
 * @param props - composed slot props.
 * @returns the trigger content element.
 */
export function TriggerContent({ wide, t }: TriggerContentProps) {
  return (
    <>
      {wide ? <IconSettingsOutline16 size={16} /> : <IconSettingsOutline14 size={18} />}
      <span className={css.hiddenLabel}>{t('trigger')}</span>
    </>
  )
}

/**
 * Render the panel title text.
 * @param props - composed slot props.
 * @returns the title text node.
 */
export function HeaderContent({ t }: HeaderContentProps) {
  return <>{t('title')}</>
}

/** Close-button label text props: the standard locale seat only. */
export type CloseLabelProps = PropsRuntime<'settings.close'> & PropsLocale<'settings'>

/**
 * Render the close button's visually-hidden label text.
 * @param props - composed slot props.
 * @returns the label text node.
 */
export function CloseLabel({ t }: CloseLabelProps) {
  return <>{t('close')}</>
}
