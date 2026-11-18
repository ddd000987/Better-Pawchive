/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * Service worker side of the image window: content scripts cannot open
 * windows, so they ask here (viewer_open) and get a popup with viewer.html.
 */

import { readViewerImage, readWindowRect, viewerQuery } from './viewerLink'
import type { ViewerOpenResponse } from './viewerLink'

async function openViewer(
  payload: Record<string, unknown>
): Promise<ViewerOpenResponse> {
  const image = readViewerImage(payload.image)
  const rect = readWindowRect(payload.rect)
  if (!image || !rect) {
    return { ok: false, error: 'invalid viewer request' }
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('viewer.html?' + viewerQuery(image)),
      type: 'popup',
      focused: true,
      ...rect,
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
  if (!rawMsg || typeof rawMsg !== 'object') return false
  const payload = rawMsg as Record<string, unknown>
  if (payload.msg !== 'viewer_open') return false
  // Only this extension's own content scripts
  if (sender.id !== chrome.runtime.id) return false
  void openViewer(payload).then(sendResponse)
  return true
})
