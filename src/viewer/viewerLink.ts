/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * What the content script, the service worker and viewer.html pass to each
 * other to open an image in its own window. Pure (no chrome.* / DOM).
 *
 * Message (sender.id must be this extension):
 *   viewer_open { image, rect } → ViewerOpenResponse
 */

import type { WindowRect } from './viewerMath'

/** The image to show: `src` is loaded, `placeholder` (an already loaded,
 * smaller copy) is shown until it arrives */
interface ViewerImage {
  src: string
  placeholder: string
  title: string
}

interface ViewerOpenMsg {
  msg: 'viewer_open'
  image: ViewerImage
  rect: WindowRect
}

type ViewerOpenResponse = { ok: true } | { ok: false; error: string }

/** Only web images: a page URL must never smuggle in another scheme */
function isWebUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const { protocol } = new URL(v)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** The image part of a message or a viewer.html query, or null if unusable.
 * An unusable placeholder falls back to `src`; a missing title to ''. */
function readViewerImage(input: unknown): ViewerImage | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  if (!isWebUrl(v.src)) return null
  return {
    src: v.src,
    placeholder: isWebUrl(v.placeholder) ? v.placeholder : v.src,
    title: typeof v.title === 'string' ? v.title.slice(0, 300) : '',
  }
}

function readWindowRect(input: unknown): WindowRect | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  const keys = ['left', 'top', 'width', 'height'] as const
  if (!keys.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]))) {
    return null
  }
  const n = (k: (typeof keys)[number]) => Math.round(v[k] as number)
  return {
    left: n('left'),
    top: n('top'),
    width: n('width'),
    height: n('height'),
  }
}

/** viewer.html query string for an image */
function viewerQuery(image: ViewerImage): string {
  return new URLSearchParams({
    src: image.src,
    placeholder: image.placeholder,
    title: image.title,
  }).toString()
}

/** Read the image back out of viewer.html's location.search */
function parseViewerQuery(search: string): ViewerImage | null {
  const q = new URLSearchParams(search)
  return readViewerImage({
    src: q.get('src'),
    placeholder: q.get('placeholder'),
    title: q.get('title') ?? '',
  })
}

export {
  isWebUrl,
  readViewerImage,
  readWindowRect,
  viewerQuery,
  parseViewerQuery,
}
export type { ViewerImage, ViewerOpenMsg, ViewerOpenResponse }
