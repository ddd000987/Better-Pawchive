/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixStash src/content/pressGesture.ts (MIT, ddd000987)
 * changes: none beyond formatting and the import path.
 */

import { MOVE_THRESHOLD, type Point } from './radialGeometry'

export interface PressGestureOptions {
  holdMs: () => number
  onTap: (ev: { shiftKey: boolean }) => void
  onOpen: (point: Point) => void
  onMove: (point: Point) => void
  onRelease: (point: Point | null) => void
}

/**
 * Tap / press-hold / press-drag on a button. A tap (or Enter / Space) calls
 * onTap; holding still for holdMs or dragging past MOVE_THRESHOLD calls
 * onOpen, then onMove / onRelease follow the pointer. Returns a detach
 * function.
 */
export function attachPressGesture(
  button: HTMLElement,
  opts: PressGestureOptions
): () => void {
  let activePointerId: number | null = null
  let startPoint: Point = { x: 0, y: 0 }
  let startShiftKey = false
  let opened = false
  let holdTimer = 0

  const clearTimer = () => {
    if (holdTimer) {
      window.clearTimeout(holdTimer)
      holdTimer = 0
    }
  }

  const reset = () => {
    clearTimer()
    activePointerId = null
    opened = false
  }

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    clearTimer()

    activePointerId = ev.pointerId
    startPoint = { x: ev.clientX, y: ev.clientY }
    startShiftKey = ev.shiftKey
    opened = false

    try {
      button.setPointerCapture?.(ev.pointerId)
    } catch {
      // Synthetic events or no pointer capture support
    }

    holdTimer = window.setTimeout(
      () => {
        holdTimer = 0
        if (activePointerId === null || opened) return
        opened = true
        opts.onOpen(startPoint)
      },
      Math.max(0, opts.holdMs())
    )
  }

  const onPointerMove = (ev: PointerEvent) => {
    if (ev.pointerId !== activePointerId) return
    const pt: Point = { x: ev.clientX, y: ev.clientY }
    if (!opened) {
      if (
        Math.hypot(pt.x - startPoint.x, pt.y - startPoint.y) > MOVE_THRESHOLD
      ) {
        clearTimer()
        opened = true
        opts.onOpen(startPoint)
        opts.onMove(pt)
      }
      return
    }
    opts.onMove(pt)
  }

  const onPointerUp = (ev: PointerEvent) => {
    if (ev.pointerId !== activePointerId) return
    const wasOpened = opened
    const shiftKey = ev.shiftKey || startShiftKey
    reset()
    try {
      button.releasePointerCapture?.(ev.pointerId)
    } catch {
      // Already released
    }
    if (!wasOpened) {
      opts.onTap({ shiftKey })
    } else {
      opts.onRelease({ x: ev.clientX, y: ev.clientY })
    }
  }

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId !== activePointerId) return
    const wasOpened = opened
    reset()
    if (wasOpened) opts.onRelease(null)
  }

  const onClick = (ev: MouseEvent) => {
    // Keep the click from following the card link under the button
    ev.preventDefault()
    ev.stopPropagation()
    // Keyboard activation (Enter / Space) fires click with detail === 0
    if (ev.detail === 0) opts.onTap({ shiftKey: ev.shiftKey })
  }

  const onDragStart = (ev: DragEvent) => ev.preventDefault()

  button.addEventListener('pointerdown', onPointerDown)
  button.addEventListener('pointermove', onPointerMove)
  button.addEventListener('pointerup', onPointerUp)
  button.addEventListener('pointercancel', onCancel)
  button.addEventListener('lostpointercapture', onCancel)
  button.addEventListener('click', onClick)
  button.addEventListener('dragstart', onDragStart)

  return () => {
    reset()
    button.removeEventListener('pointerdown', onPointerDown)
    button.removeEventListener('pointermove', onPointerMove)
    button.removeEventListener('pointerup', onPointerUp)
    button.removeEventListener('pointercancel', onCancel)
    button.removeEventListener('lostpointercapture', onCancel)
    button.removeEventListener('click', onClick)
    button.removeEventListener('dragstart', onDragStart)
  }
}
