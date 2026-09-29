/**
 * The shell's own geometry: the session bar's strip and the dsh content pane's
 * frame inside the window. Pure, so the traffic-light reserve is verifiable
 * without an Electron runtime.
 */

/**
 * Height of the session bar. It clears the macOS traffic lights, which are drawn
 * inset over the window's top-left corner under `titleBarStyle: 'hiddenInset'`.
 */
export const TOPBAR_HEIGHT = 40

/**
 * The traffic-light strip under `hiddenInset`: the standard 28pt macOS title bar.
 *
 * The bar keeps this strip while it is hidden, as a drag handle with no chrome
 * painted in it. Handing the strip to the content pane instead puts the lights
 * over the harness's own header, where they clip its logo.
 */
export const TITLEBAR_INSET = 28

/** One view's frame inside a window, in device-independent pixels. */
export interface ShellFrame {
  x: number
  y: number
  width: number
  height: number
}

/** Frames for one window content size. */
export interface ShellFrames {
  /** The session bar's frame; its height is the traffic-light strip when hidden. */
  topbar: ShellFrame
  /** The dsh content pane's frame. */
  content: ShellFrame
}

/**
 * Frames for one window content size.
 * @param width - window content width.
 * @param height - window content height.
 * @param topbarVisible - whether the session bar is shown.
 * @returns the bar's frame and the content pane's frame.
 */
export function shellFrames(width: number, height: number, topbarVisible: boolean): ShellFrames {
  const top = topbarVisible ? TOPBAR_HEIGHT : TITLEBAR_INSET
  return {
    topbar: { x: 0, y: 0, width, height: top },
    content: { x: 0, y: top, width, height: Math.max(height - top, 0) },
  }
}
