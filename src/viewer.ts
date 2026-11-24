/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * Image window (viewer.html), opened from the hover preview's "open in its
 * own window" key. The service worker opens it as a popup window; the image
 * and title come in the query (see viewerLink).
 *
 * Wheel zooms around the cursor. Dragging pans the image while it is larger
 * than the window, and otherwise moves the window itself. Double-click
 * switches between fitting the window and actual size; 0 fits; Esc closes.
 * While the image fits, resizing the window resizes the image with it.
 */

import { EVT } from './EVT'
import { lang } from './Language'
import { settings } from './setting/Settings'
import { parseViewerQuery } from './viewer/viewerLink'
import { clampView, fitView, overflows, zoomAt } from './viewer/viewerMath'
import type { Size, ViewState } from './viewer/viewerMath'

/** How long the help line stays before it fades (ms) */
const HELP_TIME = 3000
/** Pointer travel (px) before a press counts as a drag that moves the window */
const MOVE_THRESHOLD = 3

const img = document.getElementById('img') as HTMLImageElement
const help = document.getElementById('help') as HTMLDivElement
const error = document.getElementById('error') as HTMLDivElement
const notice = document.getElementById('notice') as HTMLDivElement

const image = parseViewerQuery(location.search)

/** Natural size of what img shows now (placeholder first, then the image) */
let natural: Size | null = null
let view: ViewState = { x: 0, y: 0, scale: 1 }
/** Following the window size (until the user zooms) */
let fitting = true

const pageSize = (): Size => ({
  w: document.documentElement.clientWidth,
  h: document.documentElement.clientHeight,
})

function paint(): void {
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  img.style.cursor =
    natural && overflows(view, natural, pageSize()) ? 'grab' : 'move'
}

function fit(): void {
  if (!natural) return
  fitting = true
  view = fitView(natural, pageSize())
  paint()
}

function showError(): void {
  error.textContent = lang.transl('_imageLoadFailed')
  error.hidden = false
}

/** The original failed but the preview copy is on screen: say so, without
 * covering the picture */
function showOriginalFailedNotice(): void {
  error.hidden = true
  notice.textContent = lang.transl('_viewerOriginalFailed')
  notice.hidden = false
}

/** Show a loaded picture. Swapping the placeholder for the full image keeps
 * the same on-screen size, so the picture only gets sharper. */
function show(src: string, size: Size): void {
  const before = natural
  img.src = src
  natural = size
  img.hidden = false
  if (fitting || !before) {
    fit()
    return
  }
  view = clampView(
    { ...view, scale: (view.scale * before.w) / size.w },
    size,
    pageSize()
  )
  paint()
}

function load(src: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    const probe = new Image()
    probe.onload = () =>
      resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
    probe.onerror = () => reject(new Error('image load failed: ' + src))
    probe.src = src
  })
}

async function start(): Promise<void> {
  if (!image) {
    showError()
    return
  }
  document.title = image.title || 'Better Pawchive'
  const full = load(image.src)
  let shown = false
  let fullFailed = false
  if (image.placeholder !== image.src) {
    // Usually already in the cache from the preview, so it shows at once
    load(image.placeholder)
      .then((size) => {
        if (shown) return
        show(image.placeholder, size)
        // The original failed first: this blurry copy is all there is
        if (fullFailed) showOriginalFailedNotice()
      })
      .catch(() => undefined)
  }
  try {
    const size = await full
    shown = true
    show(image.src, size)
  } catch (e) {
    console.error('[Better Pawchive]', e)
    fullFailed = true
    if (natural) {
      showOriginalFailedNotice()
    } else {
      showError()
    }
  }
}

// ---------- zoom ----------

window.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault()
    if (!natural) return
    // Lines (Firefox-style mice) and pages are turned into pixels first
    const unit = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1
    const delta = Math.max(-300, Math.min(300, ev.deltaY * unit))
    fitting = false
    view = zoomAt(
      view,
      Math.exp(-delta * 0.0015),
      ev.clientX,
      ev.clientY,
      natural,
      pageSize()
    )
    paint()
  },
  { passive: false }
)

window.addEventListener('dblclick', (ev) => {
  if (!natural) return
  if (fitting) {
    // Actual size, keeping the clicked point under the cursor
    fitting = false
    view = zoomAt(
      view,
      1 / view.scale,
      ev.clientX,
      ev.clientY,
      natural,
      pageSize()
    )
    paint()
  } else {
    fit()
  }
})

window.addEventListener('resize', () => {
  if (!natural) return
  if (fitting) {
    fit()
  } else {
    view = clampView(view, natural, pageSize())
    paint()
  }
})

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    window.close()
  } else if (ev.key === '0' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    fit()
  }
})

// ---------- drag: pan the image, or move the window ----------

interface Drag {
  pointerX: number
  pointerY: number
  /** Pan: the view at the press. Move: the window's position at the press */
  startX: number
  startY: number
  pan: boolean
  moved: boolean
}

let drag: Drag | null = null
/** One window update in flight at a time; the latest target waits its turn */
let moving = false
let moveTarget: { left: number; top: number } | null = null

function sendMove(): void {
  if (moving || !moveTarget) return
  const target = moveTarget
  moveTarget = null
  moving = true
  chrome.windows
    .update(chrome.windows.WINDOW_ID_CURRENT, target)
    .catch((e) => console.error('[Better Pawchive] move window failed', e))
    .finally(() => {
      moving = false
      sendMove()
    })
}

window.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !natural) return
  const pan = overflows(view, natural, pageSize())
  drag = {
    pointerX: ev.screenX,
    pointerY: ev.screenY,
    startX: pan ? view.x : window.screenX,
    startY: pan ? view.y : window.screenY,
    pan,
    moved: false,
  }
  document.documentElement.setPointerCapture(ev.pointerId)
  if (pan) img.style.cursor = 'grabbing'
})

window.addEventListener('pointermove', (ev) => {
  if (!drag || !natural) return
  const dx = ev.screenX - drag.pointerX
  const dy = ev.screenY - drag.pointerY
  if (!drag.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return
  drag.moved = true
  if (drag.pan) {
    view = clampView(
      { ...view, x: drag.startX + dx, y: drag.startY + dy },
      natural,
      pageSize()
    )
    img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  } else {
    moveTarget = {
      left: Math.round(drag.startX + dx),
      top: Math.round(drag.startY + dy),
    }
    sendMove()
  }
})

function endDrag(): void {
  if (!drag) return
  drag = null
  paint()
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)

/** Keep <html lang> on the UI language, for screen readers and font choice */
function syncHtmlLang(): void {
  document.documentElement.lang = lang.htmlLang()
}

async function init(): Promise<void> {
  // Settings first, so the help line uses the chosen interface language
  await settings.restore()
  syncHtmlLang()
  EVT.on(EVT.list.langChange, syncHtmlLang)
  help.textContent = lang.transl('_viewerHelp')
  help.hidden = false
  window.setTimeout(() => help.classList.add('fade'), HELP_TIME)
  await start()
}

void init()
