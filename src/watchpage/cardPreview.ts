/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure preview-list & placement helpers and floating hover-preview panel for creator cards. */

import { MAX_PREVIEWS } from '../watch/labels'
import { thumbUrl } from '../watch/watchKey'
import type { WatchCover, WatchedCreator } from '../watch/watchTypes'
import { coverStore } from './coverStore'
import { el } from './dom'

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export type PreviewPlacement = 'right' | 'left' | 'below' | 'above'

export interface PlacedPanel {
  left: number
  top: number
  placement: PreviewPlacement
}

const HOVER_DELAY_MS = 500
const DEFAULT_GAP = 10
const DEFAULT_MARGIN = 8

/** Grid column count for a preview panel: 1 -> 1 (large), 2-4 -> 2, 5-6 -> 3. */
export function previewGridColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1
  if (count <= 4) return 2
  return 3
}

function clamp(val: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(val, min), max)
}

/**
 * Compute viewport-safe floating panel coordinates next to an anchor card.
 * Prefers right, flips to left, then below, then above, and always clamps inside the viewport.
 */
export function placePreviewPanel(
  anchor: Rect,
  panel: Size,
  viewport: Size,
  gap = DEFAULT_GAP,
  margin = DEFAULT_MARGIN
): PlacedPanel {
  const maxLeft = Math.max(margin, viewport.width - margin - panel.width)
  const maxTop = Math.max(margin, viewport.height - margin - panel.height)

  // Prefer right side
  const rightLeft = anchor.right + gap
  if (rightLeft + panel.width <= viewport.width - margin) {
    return {
      left: clamp(rightLeft, margin, maxLeft),
      top: clamp(anchor.top, margin, maxTop),
      placement: 'right',
    }
  }

  // Flip to left side
  const leftLeft = anchor.left - gap - panel.width
  if (leftLeft >= margin) {
    return {
      left: clamp(leftLeft, margin, maxLeft),
      top: clamp(anchor.top, margin, maxTop),
      placement: 'left',
    }
  }

  // Place below
  const belowTop = anchor.bottom + gap
  if (belowTop + panel.height <= viewport.height - margin) {
    return {
      left: clamp(anchor.left, margin, maxLeft),
      top: clamp(belowTop, margin, maxTop),
      placement: 'below',
    }
  }

  // Place above
  const aboveTop = anchor.top - gap - panel.height
  if (aboveTop >= margin) {
    return {
      left: clamp(anchor.left, margin, maxLeft),
      top: clamp(aboveTop, margin, maxTop),
      placement: 'above',
    }
  }

  // Fallback: clamp inside viewport (never off-screen)
  return {
    left: clamp(anchor.left, margin, maxLeft),
    top: clamp(belowTop, margin, maxTop),
    placement: 'below',
  }
}

export function previewKey(cover: WatchCover): string {
  return cover.kind === 'post' ? `p:${cover.path}` : `u:${cover.id}`
}

export function sameWatchCover(a: WatchCover, b: WatchCover): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'post' && b.kind === 'post'
    ? a.path === b.path
    : a.kind === 'upload' && b.kind === 'upload' && a.id === b.id
}

export function movePreview(
  list: readonly WatchCover[],
  fromIndex: number,
  toIndex: number
): WatchCover[] {
  const len = list.length
  if (
    fromIndex < 0 ||
    fromIndex >= len ||
    toIndex < 0 ||
    toIndex >= len ||
    fromIndex === toIndex
  ) {
    return [...list]
  }
  const next = [...list]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

export function removePreview(
  list: readonly WatchCover[],
  index: number
): WatchCover[] {
  if (index < 0 || index >= list.length) return [...list]
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

/** Toggle an item in a preview selection, preserving selection order and capping at `max`. */
export function togglePreviewItem(
  list: readonly WatchCover[],
  item: WatchCover,
  max = MAX_PREVIEWS
): WatchCover[] {
  const idx = list.findIndex((x) => sameWatchCover(x, item))
  if (idx !== -1) {
    return removePreview(list, idx)
  }
  if (list.length >= max) return [...list]
  return [...list, item]
}

/** Append non-duplicate items up to `max`. */
export function appendPreviews(
  list: readonly WatchCover[],
  additions: readonly WatchCover[],
  max = MAX_PREVIEWS
): WatchCover[] {
  const seen = new Set(list.map(previewKey))
  const out = [...list]
  for (const item of additions) {
    if (out.length >= max) break
    const key = previewKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Return upload IDs that were present in `prev` but are no longer in `next`
 * and are not currently used as `activeCover`.
 */
export function removedUploadIds(
  prev: readonly WatchCover[] | undefined,
  next: readonly WatchCover[] | undefined,
  activeCover?: WatchCover
): string[] {
  if (!prev || prev.length === 0) return []
  const keep = new Set<string>()
  if (next) {
    for (const item of next) {
      if (item.kind === 'upload') keep.add(item.id)
    }
  }
  if (activeCover?.kind === 'upload') {
    keep.add(activeCover.id)
  }
  const removed: string[] = []
  const seen = new Set<string>()
  for (const item of prev) {
    if (item.kind !== 'upload') continue
    if (keep.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    removed.push(item.id)
  }
  return removed
}

/* ---------- Floating hover preview singleton ---------- */

let panelEl: HTMLElement | null = null
let activeAnchor: HTMLElement | null = null
let pendingAnchor: HTMLElement | null = null
let showTimer: number | null = null
let renderToken = 0
let removalObserver: MutationObserver | null = null
let globalListenersAttached = false

function canHover(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false
  }
  return window.matchMedia('(hover: hover)').matches
}

function clearTimers(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer)
    showTimer = null
  }
}

function detachObserver(): void {
  if (removalObserver) {
    removalObserver.disconnect()
    removalObserver = null
  }
}

function ensureGlobalListeners(): void {
  if (globalListenersAttached || typeof window === 'undefined') return
  globalListenersAttached = true
  const onDismiss = (): void => {
    hideCardPreview()
  }
  window.addEventListener('scroll', onDismiss, { capture: true, passive: true })
  window.addEventListener('resize', onDismiss, { passive: true })
  window.addEventListener('dragstart', onDismiss, { capture: true })
  window.addEventListener('hashchange', onDismiss)
}

/** Immediately hide any open preview panel and cancel pending hover timers. */
export function hideCardPreview(): void {
  clearTimers()
  detachObserver()
  renderToken += 1
  activeAnchor = null
  pendingAnchor = null
  if (panelEl) {
    panelEl.remove()
    panelEl = null
  }
}

function showPanel(
  anchor: HTMLElement,
  previews: readonly WatchCover[],
  host: string
): void {
  if (!anchor.isConnected || previews.length === 0) return

  clearTimers()
  detachObserver()
  renderToken += 1
  const token = renderToken

  if (panelEl) {
    panelEl.remove()
    panelEl = null
  }

  activeAnchor = anchor
  pendingAnchor = null

  const items = previews.slice(0, MAX_PREVIEWS)
  const cols = previewGridColumns(items.length)

  const panel = el('div', 'w-card-preview-panel')
  panel.setAttribute('aria-hidden', 'true')
  panel.dataset.cols = String(cols)

  const grid = el('div', 'w-preview-grid')
  grid.dataset.cols = String(cols)

  for (const item of items) {
    const cell = el('div', 'w-preview-cell')
    if (item.kind === 'post') {
      const url = thumbUrl(host, item.path)
      if (url) {
        const img = el('img', 'w-preview-img')
        img.decoding = 'async'
        img.alt = ''
        img.addEventListener('error', () => {
          img.remove()
        })
        img.src = url
        cell.appendChild(img)
      }
    } else {
      void coverStore.objectUrl(item.id).then((url) => {
        if (renderToken !== token || !cell.isConnected || !url) return
        const img = el('img', 'w-preview-img')
        img.decoding = 'async'
        img.alt = ''
        img.addEventListener('error', () => {
          img.remove()
        })
        img.src = url
        cell.appendChild(img)
      })
    }
    grid.appendChild(cell)
  }

  panel.appendChild(grid)

  document.body.appendChild(panel)
  panelEl = panel

  // Measure and place inside viewport
  const anchorRect = anchor.getBoundingClientRect()
  const panelRect = panel.getBoundingClientRect()
  const placed = placePreviewPanel(
    {
      left: anchorRect.left,
      top: anchorRect.top,
      right: anchorRect.right,
      bottom: anchorRect.bottom,
      width: anchorRect.width,
      height: anchorRect.height,
    },
    { width: panelRect.width, height: panelRect.height },
    { width: window.innerWidth, height: window.innerHeight }
  )
  panel.style.left = `${Math.round(placed.left)}px`
  panel.style.top = `${Math.round(placed.top)}px`

  // Force a reflow so the fade-in transition runs, then show. Not done in
  // requestAnimationFrame: rAF is paused in background tabs and windows.
  void panel.offsetWidth
  panel.classList.add('is-visible')

  // Hide if the anchor card is removed from DOM
  if (anchor.parentNode && typeof MutationObserver !== 'undefined') {
    removalObserver = new MutationObserver(() => {
      if (!anchor.isConnected) {
        hideCardPreview()
      }
    })
    removalObserver.observe(anchor.parentNode, { childList: true })
  }
}

/** Wire hover preview listeners onto a creator card or list row. */
export function attachCardPreview(
  card: HTMLElement,
  creator: WatchedCreator,
  host: string,
  selectMode: boolean
): void {
  if (selectMode || !creator.previews || creator.previews.length === 0) return
  if (!canHover()) return

  ensureGlobalListeners()
  const previews = creator.previews

  card.addEventListener('pointerenter', (ev) => {
    if (ev.pointerType === 'touch' || !canHover()) return
    if (card.classList.contains('is-dragging')) return

    if (activeAnchor === card) return

    if (showTimer !== null) {
      window.clearTimeout(showTimer)
      showTimer = null
    }
    pendingAnchor = card
    showTimer = window.setTimeout(() => {
      showTimer = null
      if (
        pendingAnchor === card &&
        card.isConnected &&
        !card.classList.contains('is-dragging')
      ) {
        showPanel(card, previews, host)
      }
    }, HOVER_DELAY_MS)
  })

  card.addEventListener('pointerleave', () => {
    if (pendingAnchor === card && showTimer !== null) {
      window.clearTimeout(showTimer)
      showTimer = null
      pendingAnchor = null
    }
    // The panel belongs to the card: leaving the card closes it at once
    if (activeAnchor === card) {
      hideCardPreview()
    }
  })

  card.addEventListener('pointerdown', () => {
    if (activeAnchor === card || pendingAnchor === card) {
      hideCardPreview()
    }
  })

  card.addEventListener('dragstart', () => {
    hideCardPreview()
  })
}
