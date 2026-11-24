/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Cross-store tag queries and mutations across creators, favorite posts, and favorite images. */

import { favImages, favPosts } from './collectStore'
import type { Labels } from './collectTypes'
import { collectTagCounts, normalizeTag, normalizeTags } from './labels'
import { watchStore } from './watchStore'

export function allTagCounts(): Array<{ tag: string; count: number }> {
  return collectTagCounts([
    Object.values(watchStore.data.creators),
    Object.values(favPosts.data.items),
    Object.values(favImages.data.items),
  ])
}

function renameInMap(
  items: Record<string, Labels>,
  fromLower: string,
  toNorm: string
): void {
  for (const item of Object.values(items)) {
    if (!item.tags || item.tags.length === 0) continue
    let changed = false
    const replaced = item.tags.map((t) => {
      if (t.toLowerCase() === fromLower) {
        changed = true
        return toNorm
      }
      return t
    })
    if (!changed) continue
    const next = normalizeTags(replaced)
    if (next) item.tags = next
    else delete item.tags
  }
}

function deleteInMap(items: Record<string, Labels>, targetLower: string): void {
  for (const item of Object.values(items)) {
    if (!item.tags || item.tags.length === 0) continue
    const filtered = item.tags.filter((t) => t.toLowerCase() !== targetLower)
    if (filtered.length === item.tags.length) continue
    if (filtered.length > 0) item.tags = filtered
    else delete item.tags
  }
}

export async function renameTag(from: string, to: string): Promise<void> {
  const fromNorm = normalizeTag(from)
  const toNorm = normalizeTag(to)
  if (!fromNorm || !toNorm) return
  const fromLower = fromNorm.toLowerCase()

  await Promise.all([
    watchStore.mutate((draft) =>
      renameInMap(draft.creators, fromLower, toNorm)
    ),
    favPosts.mutate((draft) => renameInMap(draft.items, fromLower, toNorm)),
    favImages.mutate((draft) => renameInMap(draft.items, fromLower, toNorm)),
  ])
}

export async function deleteTag(tag: string): Promise<void> {
  const norm = normalizeTag(tag)
  if (!norm) return
  const targetLower = norm.toLowerCase()

  await Promise.all([
    watchStore.mutate((draft) => deleteInMap(draft.creators, targetLower)),
    favPosts.mutate((draft) => deleteInMap(draft.items, targetLower)),
    favImages.mutate((draft) => deleteInMap(draft.items, targetLower)),
  ])
}
