/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure helpers for ratings and tags shared across creators, posts, and images. */

import type { Labels, Rating } from './collectTypes'

export const MAX_TAGS = 30
export const MAX_TAG_LEN = 40
export const MAX_PREVIEWS = 6

export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TAG_LEN)
    .trim()
  return normalized ? normalized : null
}

export function normalizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= MAX_TAGS) break
    const tag = normalizeTag(item)
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(tag)
  }
  return out.length > 0 ? out : undefined
}

export function sanitizeRating(raw: unknown): Rating | undefined {
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    raw <= 5
  ) {
    return raw as Rating
  }
  return undefined
}

export function applyLabelsPatch(
  target: Labels,
  patch: { rating?: Rating | null; tags?: string[] | null }
): void {
  if (patch.rating === null) {
    delete target.rating
  } else if (patch.rating !== undefined) {
    const r = sanitizeRating(patch.rating)
    if (r !== undefined) target.rating = r
    else delete target.rating
  }

  if (patch.tags === null) {
    delete target.tags
  } else if (patch.tags !== undefined) {
    const t = normalizeTags(patch.tags)
    if (t) target.tags = t
    else delete target.tags
  }
}

export function applyBulkLabelsPatch(
  target: Labels,
  patch: { addTags?: string[]; removeTags?: string[]; rating?: Rating | null }
): void {
  if (patch.rating === null) {
    delete target.rating
  } else if (patch.rating !== undefined) {
    const r = sanitizeRating(patch.rating)
    if (r !== undefined) target.rating = r
    else delete target.rating
  }

  if (patch.removeTags !== undefined || patch.addTags !== undefined) {
    let tags = target.tags ? [...target.tags] : []
    if (patch.removeTags && patch.removeTags.length > 0) {
      const toRemove = new Set<string>()
      for (const raw of patch.removeTags) {
        const norm = normalizeTag(raw)
        if (norm) toRemove.add(norm.toLowerCase())
      }
      if (toRemove.size > 0) {
        tags = tags.filter((t) => !toRemove.has(t.toLowerCase()))
      }
    }
    if (patch.addTags && patch.addTags.length > 0) {
      tags = [...tags, ...patch.addTags]
    }
    const next = normalizeTags(tags)
    if (next) target.tags = next
    else delete target.tags
  }
}

export function matchesLabels(
  item: Labels,
  filter: { tags?: string[]; minRating?: number }
): boolean {
  if (filter.minRating !== undefined && filter.minRating > 0) {
    if (!item.rating || item.rating < filter.minRating) return false
  }
  if (filter.tags && filter.tags.length > 0) {
    const itemTags = new Set((item.tags ?? []).map((t) => t.toLowerCase()))
    for (const raw of filter.tags) {
      const norm = normalizeTag(raw)
      if (!norm) continue
      if (!itemTags.has(norm.toLowerCase())) return false
    }
  }
  return true
}

export function collectTagCounts(
  lists: Labels[][]
): Array<{ tag: string; count: number }> {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const list of lists) {
    for (const item of list) {
      if (!item.tags || item.tags.length === 0) continue
      const seenInItem = new Set<string>()
      for (const tag of item.tags) {
        const norm = normalizeTag(tag)
        if (!norm) continue
        const lower = norm.toLowerCase()
        if (seenInItem.has(lower)) continue
        seenInItem.add(lower)
        const existing = counts.get(lower)
        if (existing) {
          existing.count += 1
        } else {
          counts.set(lower, { tag: norm, count: 1 })
        }
      }
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag)
  )
}
