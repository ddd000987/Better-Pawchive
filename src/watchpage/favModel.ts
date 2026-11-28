/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure filter and sort helpers for favorite posts and favorite images. */

import type { FavImage, FavPost } from '../watch/collectTypes'
import { matchesLabels } from '../watch/labels'
import { hasActiveLabelFilter, type LabelFilter } from './listModel'

export type FavSortMode = 'added' | 'published' | 'title' | 'rating'

function matchesTagsQuery(tags: string[] | undefined, q: string): boolean {
  if (!tags || tags.length === 0) return false
  return tags.some((t) => t.toLowerCase().includes(q))
}

/** Filter favorite posts by label filter (tags + ratings) and case-insensitive search on title, creatorName, note, tags. */
export function filterFavPosts(
  list: FavPost[],
  query: string,
  labelFilter?: LabelFilter
): FavPost[] {
  const base =
    labelFilter && hasActiveLabelFilter(labelFilter)
      ? list.filter((p) => matchesLabels(p, labelFilter))
      : list
  const q = query.trim().toLowerCase()
  if (!q) return [...base]
  return base.filter((p) => {
    if (p.title.toLowerCase().includes(q)) return true
    if (p.creatorName.toLowerCase().includes(q)) return true
    if (p.note && p.note.toLowerCase().includes(q)) return true
    if (matchesTagsQuery(p.tags, q)) return true
    return false
  })
}

/** Return a new array of favorite posts sorted by the requested mode. */
export function sortFavPosts(list: FavPost[], mode: FavSortMode): FavPost[] {
  const byAdded = (a: FavPost, b: FavPost): number => {
    if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt
    return a.key.localeCompare(b.key)
  }

  return [...list].sort((a, b) => {
    if (mode === 'added') return byAdded(a, b)
    if (mode === 'published') {
      const pa = a.published ?? ''
      const pb = b.published ?? ''
      if (pa && !pb) return -1
      if (!pa && pb) return 1
      if (pa !== pb) return pb.localeCompare(pa)
      return byAdded(a, b)
    }
    if (mode === 'title') {
      const ta = a.title || a.postId
      const tb = b.title || b.postId
      const diff = ta.localeCompare(tb)
      return diff !== 0 ? diff : a.key.localeCompare(b.key)
    }
    const ra = a.rating ?? 0
    const rb = b.rating ?? 0
    if (ra !== rb) return rb - ra
    return byAdded(a, b)
  })
}

/** Filter favorite images by label filter (tags + ratings) and case-insensitive search on postTitle, creatorName, fileName, note, tags. */
export function filterFavImages(
  list: FavImage[],
  query: string,
  labelFilter?: LabelFilter
): FavImage[] {
  const base =
    labelFilter && hasActiveLabelFilter(labelFilter)
      ? list.filter((img) => matchesLabels(img, labelFilter))
      : list
  const q = query.trim().toLowerCase()
  if (!q) return [...base]
  return base.filter((img) => {
    if (img.postTitle && img.postTitle.toLowerCase().includes(q)) return true
    if (img.creatorName && img.creatorName.toLowerCase().includes(q))
      return true
    if (img.fileName && img.fileName.toLowerCase().includes(q)) return true
    if (img.note && img.note.toLowerCase().includes(q)) return true
    if (matchesTagsQuery(img.tags, q)) return true
    return false
  })
}

/** Return a new array of favorite images sorted by the requested mode. */
export function sortFavImages(list: FavImage[], mode: FavSortMode): FavImage[] {
  const byAdded = (a: FavImage, b: FavImage): number => {
    if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt
    return a.key.localeCompare(b.key)
  }

  return [...list].sort((a, b) => {
    if (mode === 'added' || mode === 'published') return byAdded(a, b)
    if (mode === 'title') {
      const ta = a.postTitle || a.fileName || a.path
      const tb = b.postTitle || b.fileName || b.path
      const diff = ta.localeCompare(tb)
      return diff !== 0 ? diff : a.key.localeCompare(b.key)
    }
    const ra = a.rating ?? 0
    const rb = b.rating ?? 0
    if (ra !== rb) return rb - ra
    return byAdded(a, b)
  })
}
