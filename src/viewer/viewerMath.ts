/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * Geometry for the image window (viewer.html): the window's first size and
 * place, fitting the image, zooming around a point and keeping it in view.
 * Pure functions (no DOM), so they can be unit tested.
 */

/** Where the image sits in the page: its top-left corner and its scale */
interface ViewState {
  x: number
  y: number
  scale: number
}

interface Size {
  w: number
  h: number
}

/** Screen area the window may use (window.screen avail* values) */
interface ScreenArea {
  left: number
  top: number
  w: number
  h: number
}

/** Window position and outer size, as chrome.windows.create takes them */
interface WindowRect {
  left: number
  top: number
  width: number
  height: number
}

/** Space the popup frame takes around the page (title bar, URL strip,
 * borders). Only an estimate: the page refits the image to whatever size it
 * really gets, so a wrong guess only leaves a thin margin. */
const FRAME_W = 16
const FRAME_H = 64
/** Largest share of the screen a new window takes */
const MAX_SCREEN_SHARE = 0.8
/** Smallest page size a new window gets */
const MIN_PAGE = 200
/** Zoom limits, as a factor of the image's own pixels */
const MIN_SCALE = 0.02
const MAX_SCALE = 32

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi)

/** First size and place of the window, centred on the screen. The page keeps
 * the image's aspect ratio and fills up to 80% of the screen; with
 * `fullSize` known (the shown image is the original) a small image is not
 * blown up past its own pixels. Without a known size it takes 60% x 60%. */
function initialWindowRect(
  image: Size | null,
  screen: ScreenArea,
  fullSize: boolean
): WindowRect {
  const maxW = Math.max(MIN_PAGE, screen.w * MAX_SCREEN_SHARE - FRAME_W)
  const maxH = Math.max(MIN_PAGE, screen.h * MAX_SCREEN_SHARE - FRAME_H)
  let pageW = maxW * 0.75
  let pageH = maxH * 0.75
  if (image && image.w > 0 && image.h > 0) {
    let scale = Math.min(maxW / image.w, maxH / image.h)
    if (fullSize) scale = Math.min(scale, 1)
    pageW = Math.max(MIN_PAGE, image.w * scale)
    pageH = Math.max(MIN_PAGE, image.h * scale)
  }
  const width = Math.round(pageW + FRAME_W)
  const height = Math.round(pageH + FRAME_H)
  return {
    left: Math.round(screen.left + (screen.w - width) / 2),
    top: Math.round(screen.top + (screen.h - height) / 2),
    width,
    height,
  }
}

/** Scale that shows the whole image in the page, centred. A small image is
 * enlarged too, so making the window bigger makes the image bigger. */
function fitView(image: Size, view: Size): ViewState {
  const scale = clamp(
    Math.min(view.w / image.w, view.h / image.h),
    MIN_SCALE,
    MAX_SCALE
  )
  return {
    scale,
    x: (view.w - image.w * scale) / 2,
    y: (view.h - image.h * scale) / 2,
  }
}

/** An axis smaller than the page is centred; a larger one may move only as
 * far as leaves no empty gap at either edge. */
function clampView(state: ViewState, image: Size, view: Size): ViewState {
  const place = (pos: number, size: number, room: number) =>
    size <= room ? (room - size) / 2 : clamp(pos, room - size, 0)
  return {
    scale: state.scale,
    x: place(state.x, image.w * state.scale, view.w),
    y: place(state.y, image.h * state.scale, view.h),
  }
}

/** Zoom by `factor`, keeping the image point under (cx, cy) where it is */
function zoomAt(
  state: ViewState,
  factor: number,
  cx: number,
  cy: number,
  image: Size,
  view: Size
): ViewState {
  const scale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE)
  const k = scale / state.scale
  return clampView(
    { scale, x: cx - (cx - state.x) * k, y: cy - (cy - state.y) * k },
    image,
    view
  )
}

/** Whether the shown image is larger than the page on either axis: then a
 * drag pans the image, otherwise it moves the window. */
function overflows(state: ViewState, image: Size, view: Size): boolean {
  return (
    image.w * state.scale > view.w + 0.5 || image.h * state.scale > view.h + 0.5
  )
}

export {
  initialWindowRect,
  fitView,
  clampView,
  zoomAt,
  overflows,
  MIN_SCALE,
  MAX_SCALE,
}
export type { ViewState, Size, ScreenArea, WindowRect }
