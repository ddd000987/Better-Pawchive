/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Export and import the watchlist (JSON + uploaded cover images). */

import { lang } from '../Language'
import { pickJsonFile, saveJsonFile } from '../utils/jsonFile'
import { validateWatchData } from '../watch/watchData'
import { watchStore } from '../watch/watchStore'
import { coverStore } from './coverStore'

const EXPORT_TYPE = 'pawchivePro-watchlist'
const EXPORT_VERSION = 1

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('unexpected FileReader result'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read blob failed'))
    reader.readAsDataURL(blob)
  })
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

/** Export the current watchlist and all referenced uploaded covers to a JSON file. */
export async function exportWatchlist(): Promise<void> {
  const data = watchStore.data
  const covers: Record<string, string> = {}

  for (const creator of Object.values(data.creators)) {
    if (creator.cover?.kind !== 'upload') continue
    const id = creator.cover.id
    if (id in covers) continue
    const blob = await coverStore.get(id)
    if (!blob) continue
    try {
      covers[id] = await blobToDataUrl(blob)
    } catch (e) {
      console.warn('[PawchivePro] failed to serialize cover', id, e)
    }
  }

  saveJsonFile(`pawchivepro-watchlist-${todayStamp()}.json`, {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    data,
    covers,
  })
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

      const rawObj = parsed as { data?: unknown; covers?: unknown }
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
        onStatus(lang.transl('_w_importDone', String(importCount)))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        onStatus(lang.transl('_w_importFailed', msg), true)
      }
    })()
  })
}
