/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Storage and object-URL cache for user-uploaded creator cover images. */

import { idbDelete, idbGet, idbPut } from './idb'
import { fitWithin } from './listModel'

const MAX_COVER_SIZE = 800
const WEBP_QUALITY = 0.85

const urlCache = new Map<string, string>()
const pendingUrls = new Map<string, Promise<string | undefined>>()

function revokeCached(id: string): void {
  const existing = urlCache.get(id)
  if (existing) {
    URL.revokeObjectURL(existing)
    urlCache.delete(id)
  }
}

export const coverStore = {
  async put(id: string, blob: Blob): Promise<void> {
    revokeCached(id)
    pendingUrls.delete(id)
    await idbPut('covers', id, blob)
  },

  async get(id: string): Promise<Blob | undefined> {
    const value = await idbGet<unknown>('covers', id)
    return value instanceof Blob ? value : undefined
  },

  async delete(id: string): Promise<void> {
    revokeCached(id)
    pendingUrls.delete(id)
    await idbDelete('covers', id)
  },

  async objectUrl(id: string): Promise<string | undefined> {
    const cached = urlCache.get(id)
    if (cached) return cached

    const inflight = pendingUrls.get(id)
    if (inflight) return inflight

    const task = (async () => {
      const blob = await this.get(id)
      if (!blob) return undefined
      const url = URL.createObjectURL(blob)
      urlCache.set(id, url)
      return url
    })().finally(() => {
      pendingUrls.delete(id)
    })

    pendingUrls.set(id, task)
    return task
  },
}

/** Generate a unique cover id for an uploaded image. */
export function makeCoverId(): string {
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return 'c_' + Date.now().toString(36) + rand
}

/** Resize an uploaded image so its longer side is at most `max` px, encoded as WebP. */
export async function resizeCoverImage(
  file: Blob,
  max = MAX_COVER_SIZE
): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const size = fitWithin(bitmap.width, bitmap.height, max)
    const canvas = document.createElement('canvas')
    canvas.width = size.w
    canvas.height = size.h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, 0, 0, size.w, size.h)

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY)
    )
    if (blob) return blob

    const fallback = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', WEBP_QUALITY)
    )
    if (!fallback) throw new Error('failed to encode cover image')
    return fallback
  } finally {
    bitmap.close()
  }
}
