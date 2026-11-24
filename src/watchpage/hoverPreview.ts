/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Hover previews on the watch page: a favorite image is shown larger at its
 * own aspect ratio, a post tile shows its images (the wheel switches them).
 * The thumbnail is shown first; with watchPreviewOriginal on, the original
 * replaces it once loaded. Settings are read on every hover, so a change in
 * the ⚙ dialog applies without re-rendering the grid. */

import { api } from '../kemono/api'
import type { KemonoService } from '../kemono/apiTypes'
import { imageFiles, imageUrl } from '../preview/previewAssets'
import { settings } from '../setting/Settings'
import { fullImageUrl, thumbUrl } from '../watch/watchKey'
import type { Rect, Size } from './cardPreview'
import { el } from './dom'

export interface PreviewBox {
  left: number
  top: number
  width: number
  height: number
}

const GAP = 10
const MARGIN = 8
/** Below this size beside the tile, the preview covers the page instead */
const MIN_SIDE = 220
/** Longest edge of the preview, however large the window */
const MAX_EDGE = 1400

/**
 * Where to show an image of the given aspect ratio (width / height) next to
 * the hovered tile: the side (right, left, below, above) where it comes out
 * largest. When no side has room, it is centred in the window over the tile.
 */
export function fitPreviewBox(
  anchor: Rect,
  aspect: number,
  viewport: Size
): PreviewBox {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const fit = (w: number, h: number): Size => {
    const maxW = Math.min(Math.max(w, 0), MAX_EDGE)
    const maxH = Math.min(Math.max(h, 0), MAX_EDGE)
    let width = maxW
    let height = width / ratio
    if (height > maxH) {
      height = maxH
      width = height * ratio
    }
    return { width: Math.floor(width), height: Math.floor(height) }
  }
  const fullH = viewport.height - 2 * MARGIN
  const fullW = viewport.width - 2 * MARGIN
  const clampTop = (h: number, top: number) =>
    Math.min(
      Math.max(top, MARGIN),
      Math.max(MARGIN, viewport.height - MARGIN - h)
    )
  const clampLeft = (w: number, left: number) =>
    Math.min(
      Math.max(left, MARGIN),
      Math.max(MARGIN, viewport.width - MARGIN - w)
    )
  const midY = anchor.top + anchor.height / 2
  const midX = anchor.left + anchor.width / 2

  const sides: PreviewBox[] = []
  const right = fit(viewport.width - anchor.right - GAP - MARGIN, fullH)
  sides.push({
    ...right,
    left: anchor.right + GAP,
    top: clampTop(right.height, midY - right.height / 2),
  })
  const left = fit(anchor.left - GAP - MARGIN, fullH)
  sides.push({
    ...left,
    left: anchor.left - GAP - left.width,
    top: clampTop(left.height, midY - left.height / 2),
  })
  const below = fit(fullW, viewport.height - anchor.bottom - GAP - MARGIN)
  sides.push({
    ...below,
    left: clampLeft(below.width, midX - below.width / 2),
    top: anchor.bottom + GAP,
  })
  const above = fit(fullW, anchor.top - GAP - MARGIN)
  sides.push({
    ...above,
    left: clampLeft(above.width, midX - above.width / 2),
    top: anchor.top - GAP - above.height,
  })

  let best = sides[0]
  for (const s of sides) {
    if (s.width * s.height > best.width * best.height) best = s
  }
  if (Math.min(best.width, best.height) >= MIN_SIDE) return best

  const over = fit(fullW, fullH)
  return {
    ...over,
    left: Math.floor((viewport.width - over.width) / 2),
    top: Math.floor((viewport.height - over.height) / 2),
  }
}

/** One picture: shown as `thumb` at once, replaced by `full` if given */
interface PreviewImage {
  thumb: string
  full: string | null
}

interface Session {
  anchor: HTMLElement
  images: PreviewImage[]
  index: number
  /** Still fetching the post's image list */
  loading: boolean
  abort: AbortController
}

let panel: HTMLDivElement | null = null
let imgEl: HTMLImageElement | null = null
let counterEl: HTMLDivElement | null = null
let session: Session | null = null
let pending: { anchor: HTMLElement; timer: number } | null = null
/** Bumped on every picture change, so late loads are dropped */
let showToken = 0
let listenersAttached = false

function canHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover)').matches
  )
}

function cancelPending(): void {
  if (pending) {
    window.clearTimeout(pending.timer)
    pending = null
  }
}

/** Close the preview and cancel a hover that has not opened one yet */
export function hideHoverPreview(): void {
  cancelPending()
  showToken += 1
  session?.abort.abort()
  session = null
  panel?.remove()
  panel = null
  imgEl = null
  counterEl = null
}

function ensureListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  const dismiss = (): void => hideHoverPreview()
  window.addEventListener('scroll', dismiss, { capture: true, passive: true })
  window.addEventListener('resize', dismiss, { passive: true })
  window.addEventListener('dragstart', dismiss, { capture: true })
  window.addEventListener('hashchange', dismiss)
  window.addEventListener('contextmenu', dismiss, { capture: true })
  window.addEventListener('blur', dismiss)
}

function ensurePanel(): void {
  if (panel) return
  panel = el('div', 'w-hover-preview')
  panel.setAttribute('aria-hidden', 'true')
  imgEl = el('img', 'w-hover-preview-img')
  imgEl.alt = ''
  imgEl.decoding = 'async'
  counterEl = el('div', 'w-hover-preview-counter')
  counterEl.hidden = true
  panel.append(imgEl, counterEl)
  document.body.appendChild(panel)
}

function place(width: number, height: number): void {
  if (!panel || !imgEl || !session) return
  const r = session.anchor.getBoundingClientRect()
  const box = fitPreviewBox(r, width / height, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  imgEl.style.width = `${box.width}px`
  imgEl.style.height = `${box.height}px`
  panel.style.left = `${Math.round(box.left)}px`
  panel.style.top = `${Math.round(box.top)}px`
  panel.classList.add('is-visible')
}

function updateCounter(): void {
  if (!counterEl || !session) return
  const n = session.images.length
  counterEl.hidden = n <= 1 && !session.loading
  counterEl.textContent = session.loading ? '…' : `${session.index + 1} / ${n}`
}

/** Load a URL off-screen; resolves with its natural size, or null on error */
function loadImage(
  url: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const probe = new Image()
    probe.decoding = 'async'
    probe.onload = () =>
      resolve(
        probe.naturalWidth > 0
          ? { width: probe.naturalWidth, height: probe.naturalHeight }
          : null
      )
    probe.onerror = () => resolve(null)
    probe.src = url
  })
}

/** Show the current picture: thumbnail first, then the original if wanted */
function showCurrent(): void {
  if (!session) return
  const pic = session.images[session.index]
  if (!pic) return
  const token = ++showToken
  ensurePanel()
  updateCounter()
  const show = (url: string, size: { width: number; height: number }) => {
    if (token !== showToken || !session || !imgEl) return
    imgEl.src = url
    place(size.width, size.height)
  }
  void loadImage(pic.thumb).then((size) => {
    if (size) show(pic.thumb, size)
    const full = pic.full
    if (token !== showToken || !full || full === pic.thumb) return
    void loadImage(full).then((fullSize) => {
      if (fullSize) show(full, fullSize)
    })
  })
  // Load the next picture ahead so the wheel feels instant
  const next = session.images[session.index + 1]
  if (next) void loadImage(next.thumb)
}

function start(
  anchor: HTMLElement,
  images: PreviewImage[],
  loading: boolean
): Session {
  hideHoverPreview()
  const s: Session = {
    anchor,
    images,
    index: 0,
    loading,
    abort: new AbortController(),
  }
  session = s
  if (images.length > 0) showCurrent()
  return s
}

/** Wire the hover timer onto a tile; `open` runs once the cursor rests */
function wireHover(
  tile: HTMLElement,
  enabled: () => boolean,
  open: () => void
): void {
  if (!canHover()) return
  ensureListeners()
  tile.addEventListener('pointerenter', (ev) => {
    if (ev.pointerType === 'touch' || !enabled()) return
    if (tile.classList.contains('is-dragging')) return
    if (session?.anchor === tile) return
    cancelPending()
    const timer = window.setTimeout(() => {
      pending = null
      if (tile.isConnected && !tile.classList.contains('is-dragging')) open()
    }, settings.get('watchPreviewWait'))
    pending = { anchor: tile, timer }
  })
  tile.addEventListener('pointerleave', () => {
    if (pending?.anchor === tile) cancelPending()
    if (session?.anchor === tile) hideHoverPreview()
  })
  tile.addEventListener('pointerdown', () => {
    if (pending?.anchor === tile || session?.anchor === tile) {
      hideHoverPreview()
    }
  })
  tile.addEventListener(
    'wheel',
    (ev) => {
      const s = session
      if (!s || s.anchor !== tile || s.images.length <= 1) return
      ev.preventDefault()
      const step = ev.deltaY > 0 ? 1 : ev.deltaY < 0 ? -1 : 0
      if (step === 0) return
      const next = Math.min(Math.max(s.index + step, 0), s.images.length - 1)
      if (next === s.index) return
      s.index = next
      showCurrent()
    },
    { passive: false }
  )
}

/** Larger view of a favorite image while the cursor rests on its tile */
export function attachImagePreview(
  tile: HTMLElement,
  host: string,
  path: string
): void {
  wireHover(
    tile,
    () => settings.get('watchPreviewImages'),
    () => {
      start(
        tile,
        [
          {
            thumb: thumbUrl(host, path),
            full: settings.get('watchPreviewOriginal')
              ? fullImageUrl(host, path)
              : null,
          },
        ],
        false
      )
    }
  )
}

export interface PostRef {
  host: string
  service: KemonoService
  creatorId: string
  postId: string
  /** Shown while the post's image list is fetched */
  coverPath?: string
}

/** Images of a post while the cursor rests on its tile; the wheel switches */
export function attachPostPreview(tile: HTMLElement, post: PostRef): void {
  wireHover(
    tile,
    () => settings.get('watchPreviewPosts'),
    () => {
      const original = settings.get('watchPreviewOriginal')
      const cover: PreviewImage[] = post.coverPath
        ? [{ thumb: thumbUrl(post.host, post.coverPath), full: null }]
        : []
      const s = start(tile, cover, true)
      void api
        .post(
          {
            service: post.service,
            creatorId: post.creatorId,
            postId: post.postId,
          },
          s.abort.signal,
          { host: post.host }
        )
        .then((data) => {
          if (session !== s) return
          s.loading = false
          if (api.isErrorResponse(data)) {
            updateCounter()
            return
          }
          const images = imageFiles(data).map((f) => ({
            thumb: imageUrl(f, data, false, post.host),
            full: original ? imageUrl(f, data, true, post.host) : null,
          }))
          if (images.length === 0) {
            updateCounter()
            return
          }
          // Keep showing the cover if it is the first image (no flicker)
          const sameFirst = cover[0] && cover[0].thumb === images[0].thumb
          s.images = images
          s.index = 0
          if (sameFirst && !images[0].full) {
            updateCounter()
          } else {
            showCurrent()
          }
        })
        .catch(() => {
          if (session !== s) return
          s.loading = false
          updateCounter()
        })
    }
  )
}
