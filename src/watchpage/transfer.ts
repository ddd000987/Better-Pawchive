/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Export and import the watchlist, favorites, and uploaded cover/preview images. */

import { lang } from '../Language'
import { pickJsonFile, saveJsonFile } from '../utils/jsonFile'
import { favImages, favPosts } from '../watch/collectStore'
import type { CollectData, FavImage, FavPost } from '../watch/collectTypes'
import { validateWatchData } from '../watch/watchData'
import { watchStore } from '../watch/watchStore'
import type { WatchData } from '../watch/watchTypes'
import { coverStore } from './coverStore'

export const EXPORT_TYPE = 'pawchivePro-watchlist'
export const EXPORT_VERSION = 2

export interface ExportPayload {
  type: typeof EXPORT_TYPE
  version: number
  exportedAt: string
  data: WatchData
  favPosts: CollectData<FavPost>
  favImages: CollectData<FavImage>
  covers: Record<string, string>
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const mime = blob.type || 'application/octet-stream'
  return `data:${mime};base64,${btoa(binary)}`
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith('data:image/')) return null
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const header = dataUrl.slice(5, comma)
  const payload = dataUrl.slice(comma + 1)
  const isBase64 = header.endsWith(';base64')
  const mime = isBase64 ? header.slice(0, -7) : header
  if (!mime.startsWith('image/')) return null
  try {
    if (isBase64) {
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(payload)], { type: mime })
  } catch {
    return null
  }
}

function todayStamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** Build the JSON-serializable export payload including watchlist, favorites, and uploaded cover/preview blobs. */
export async function buildExportPayload(): Promise<ExportPayload> {
  const data = watchStore.data
  const covers: Record<string, string> = {}

  const uploadIds = new Set<string>()
  for (const creator of Object.values(data.creators)) {
    if (creator.cover?.kind === 'upload') {
      uploadIds.add(creator.cover.id)
    }
    if (creator.previews) {
      for (const preview of creator.previews) {
        if (preview.kind === 'upload') {
          uploadIds.add(preview.id)
        }
      }
    }
  }

  for (const id of uploadIds) {
    const blob = await coverStore.get(id)
    if (!blob) continue
    try {
      covers[id] = await blobToDataUrl(blob)
    } catch (e) {
      console.warn('[PawchivePro] failed to serialize cover', id, e)
    }
  }

  return {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
    favPosts: favPosts.data,
    favImages: favImages.data,
    covers,
  }
}

/** Apply a parsed export payload: restore uploaded blobs, replace watchlist, and replace favorites when present. */
export async function applyImportPayload(
  parsed: unknown
): Promise<{ importCount: number }> {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as { type?: unknown }).type !== EXPORT_TYPE
  ) {
    throw new Error('invalid export payload')
  }

  const rawObj = parsed as {
    data?: unknown
    favPosts?: unknown
    favImages?: unknown
    covers?: unknown
  }
  const validated = validateWatchData(rawObj.data)

  if (
    rawObj.covers &&
    typeof rawObj.covers === 'object' &&
    !Array.isArray(rawObj.covers)
  ) {
    for (const [id, val] of Object.entries(
      rawObj.covers as Record<string, unknown>
    )) {
      if (!id || typeof val !== 'string') continue
      if (!val.startsWith('data:image/')) continue
      const blob = dataUrlToBlob(val)
      if (blob) {
        await coverStore.put(id, blob)
      }
    }
  }

  await watchStore.replaceAll(validated)
  if ('favPosts' in rawObj && rawObj.favPosts !== undefined) {
    await favPosts.replaceAll(rawObj.favPosts)
  }
  if ('favImages' in rawObj && rawObj.favImages !== undefined) {
    await favImages.replaceAll(rawObj.favImages)
  }

  return { importCount: Object.keys(validated.creators).length }
}

/** Export the current watchlist, favorites, and all referenced uploaded covers to a JSON file. */
export async function exportWatchlist(): Promise<void> {
  const payload = await buildExportPayload()
  saveJsonFile(`pawchivepro-watchlist-${todayStamp()}.json`, payload)
}

/** Prompt the user for a watchlist JSON file, confirm replacement, and restore data + covers. */
export function importWatchlist(
  onStatus: (message: string, isError?: boolean) => void
): void {
  pickJsonFile((text) => {
    void (async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        onStatus(lang.transl('_w_importInvalid'), true)
        return
      }

      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed as { type?: unknown }).type !== EXPORT_TYPE
      ) {
        onStatus(lang.transl('_w_importInvalid'), true)
        return
      }

      const rawObj = parsed as { data?: unknown }
      const validated = validateWatchData(rawObj.data)
      const currentCount = Object.keys(watchStore.data.creators).length
      const importCount = Object.keys(validated.creators).length

      const ok = window.confirm(
        lang.transl(
          '_w_importConfirm',
          String(currentCount),
          String(importCount)
        )
      )
      if (!ok) return

      try {
        const res = await applyImportPayload(parsed)
        onStatus(lang.transl('_w_importDone', String(res.importCount)))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        onStatus(lang.transl('_w_importFailed', msg), true)
      }
    })()
  })
}
