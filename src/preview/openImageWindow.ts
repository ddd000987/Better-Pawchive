/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * Preview key "open this image in its own window": works out the window's
 * size from the image on screen and asks the service worker to open it.
 */

import { lang } from '../Language'
import { toast } from '../Toast'
import type { ViewerImage, ViewerOpenResponse } from '../viewer/viewerLink'
import { initialWindowRect } from '../viewer/viewerMath'
import type { Size } from '../viewer/viewerMath'

/** Screen with Chrome's non-standard origin of the available area */
type ScreenWithOrigin = Screen & { availLeft?: number; availTop?: number }

/**
 * @param image what to show (the original when known, the preview copy as
 *   its placeholder)
 * @param shown the natural size of the picture the preview shows now, or
 *   null while it has not loaded; gives the aspect ratio of the window
 * @param shownIsFull whether that picture is the image itself (not a smaller
 *   copy), so its size is the real one
 */
async function openImageWindow(
  image: ViewerImage,
  shown: Size | null,
  shownIsFull: boolean
): Promise<void> {
  const s = window.screen as ScreenWithOrigin
  const rect = initialWindowRect(
    shown,
    {
      left: s.availLeft ?? 0,
      top: s.availTop ?? 0,
      w: s.availWidth,
      h: s.availHeight,
    },
    shownIsFull
  )
  try {
    const res = (await chrome.runtime.sendMessage({
      msg: 'viewer_open',
      image,
      rect,
    })) as ViewerOpenResponse | undefined
    if (!res?.ok) {
      throw new Error(res ? res.error : 'no reply')
    }
  } catch (e) {
    console.error('[PawchivePro] open image window failed', e)
    toast.error(lang.transl('_viewerOpenFailed'))
  }
}

export { openImageWindow }
