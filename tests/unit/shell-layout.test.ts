/**
 * Shell geometry. The session bar and the content pane both clear the macOS
 * traffic lights, which are drawn over the window's top-left corner under
 * `hiddenInset`. With the bar hidden, the content pane used to start at y 0 and
 * the lights landed on the harness's own header, clipping its logo.
 */
import { describe, expect, it } from 'vitest'
import { TITLEBAR_INSET, TOPBAR_HEIGHT, shellFrames } from '../../src/main/shell-layout.ts'

describe('shellFrames', () => {
  it('gives the content pane the window below the shown bar', () => {
    const frames = shellFrames(1280, 840, true)
    expect(frames.topbar).toEqual({ x: 0, y: 0, width: 1280, height: TOPBAR_HEIGHT })
    expect(frames.content).toEqual({ x: 0, y: TOPBAR_HEIGHT, width: 1280, height: 840 - TOPBAR_HEIGHT })
  })

  it('keeps the traffic-light strip reserved while the bar is hidden', () => {
    const frames = shellFrames(1280, 840, false)
    // The strip stays the bar's frame: main leaves the bar mounted there as the
    // window's drag handle, and the page paints nothing inside it.
    expect(frames.topbar).toEqual({ x: 0, y: 0, width: 1280, height: TITLEBAR_INSET })
    expect(frames.content.y).toBe(TITLEBAR_INSET)
    expect(frames.content.height).toBe(840 - TITLEBAR_INSET)
    // The whole point of the reserve: the content pane starts below the lights
    // instead of at the window's top edge, where they clip its header.
    expect(frames.content.y).toBeGreaterThan(0)
    expect(frames.content.y).toBe(frames.topbar.height)
  })

  it('never hands the content pane a negative height', () => {
    // A window can be dragged smaller than the bar's own height before the
    // minimum size applies; a negative frame would be an invalid layout.
    const frames = shellFrames(400, 10, true)
    expect(frames.content.height).toBe(0)
    expect(shellFrames(400, 10, false).content.height).toBe(0)
  })
})
