/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure list, routing, and image sizing helpers for the watch page. */

import { matchesLabels } from '../watch/labels'
import type { CreatorSnapshot, WatchedCreator } from '../watch/watchTypes'

export type SortMode = 'name' | 'added' | 'latest' | 'unread' | 'rating'

export interface LabelFilter {
  tags: string[]
  minRating?: number
}

export type WatchRoute =
  | { view: 'all' }
  | { view: 'updates' }
  | { view: 'tracking' }
  | { view: 'feed' }
  | { view: 'tags' }
  | { view: 'folder'; folderId: string }
  | { view: 'creator'; key: string }
  | { view: 'posts'; folderId?: string }
  | { view: 'images'; folderId?: string }

/** Preferred display name for a creator (custom alias first, else site name). */
export function displayName(c: WatchedCreator): string {
  const alias = c.alias?.trim()
  return alias || c.name
}

/** Return true if any tag or minimum rating filter is active. */
export function hasActiveLabelFilter(filter: LabelFilter): boolean {
  return filter.tags.length > 0 || (filter.minRating ?? 0) > 0
}

/** Filter creators by tags (AND) and minimum rating using matchesLabels. */
export function filterCreatorsByLabels(
  list: WatchedCreator[],
  filter: LabelFilter
): WatchedCreator[] {
  if (!hasActiveLabelFilter(filter)) return [...list]
  return list.filter((c) => matchesLabels(c, filter))
}

/** Filter creators by case-insensitive substring match on alias, name, note, and creatorId, plus optional label filter. */
export function filterCreators(
  list: WatchedCreator[],
  query: string,
  labelFilter?: LabelFilter
): WatchedCreator[] {
  const q = query.trim().toLowerCase()
  const base =
    labelFilter && hasActiveLabelFilter(labelFilter)
      ? filterCreatorsByLabels(list, labelFilter)
      : list
  if (!q) return [...base]
  return base.filter((c) => {
    if (c.alias && c.alias.toLowerCase().includes(q)) return true
    if (c.name.toLowerCase().includes(q)) return true
    if (c.note && c.note.toLowerCase().includes(q)) return true
    if (c.creatorId.toLowerCase().includes(q)) return true
    return false
  })
}

/** Return the newest published timestamp string in a snapshot, or '' when none. */
export function latestPublished(snap: CreatorSnapshot | undefined): string {
  if (!snap || snap.posts.length === 0) return ''
  let latest = ''
  for (const post of snap.posts) {
    if (post.published && post.published > latest) {
      latest = post.published
    }
  }
  return latest
}

/** Return a new array sorted by the requested mode. */
export function sortCreators(
  list: WatchedCreator[],
  mode: SortMode,
  snaps: Map<string, CreatorSnapshot>
): WatchedCreator[] {
  const compareName = (a: WatchedCreator, b: WatchedCreator): number => {
    const diff = displayName(a).localeCompare(displayName(b))
    return diff !== 0 ? diff : a.key.localeCompare(b.key)
  }

  return [...list].sort((a, b) => {
    if (mode === 'name') {
      return compareName(a, b)
    }
    if (mode === 'added') {
      if (a.addedAt !== b.addedAt) return b.addedAt - a.addedAt
      return compareName(a, b)
    }
    if (mode === 'unread') {
      const ua = a.tracking?.enabled ? a.tracking.unread.length : 0
      const ub = b.tracking?.enabled ? b.tracking.unread.length : 0
      if (ua !== ub) return ub - ua
      return compareName(a, b)
    }
    if (mode === 'rating') {
      const ra = a.rating ?? 0
      const rb = b.rating ?? 0
      if (ra !== rb) return rb - ra
      return compareName(a, b)
    }
    const la = latestPublished(snaps.get(a.key))
    const lb = latestPublished(snaps.get(b.key))
    if (la && !lb) return -1
    if (!la && lb) return 1
    if (la !== lb) return lb.localeCompare(la)
    return compareName(a, b)
  })
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}

/** Parse location.hash into a watch page route. Unknown hashes fall back to all. */
export function parseRoute(hash: string): WatchRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const trimmed = raw.startsWith('/') ? raw.slice(1) : raw
  if (!trimmed || trimmed === 'all') return { view: 'all' }
  if (trimmed === 'updates') return { view: 'updates' }
  if (trimmed === 'tracking') return { view: 'tracking' }
  if (trimmed === 'feed') return { view: 'feed' }
  if (trimmed === 'tags') return { view: 'tags' }
  if (trimmed === 'posts') return { view: 'posts' }
  if (trimmed === 'images') return { view: 'images' }

  const slash = trimmed.indexOf('/')
  if (slash === -1) return { view: 'all' }

  const head = trimmed.slice(0, slash)
  const rest = trimmed.slice(slash + 1)

  if (head === 'posts') {
    const folderId = rest ? safeDecode(rest) : ''
    return folderId ? { view: 'posts', folderId } : { view: 'posts' }
  }
  if (head === 'images') {
    const folderId = rest ? safeDecode(rest) : ''
    return folderId ? { view: 'images', folderId } : { view: 'images' }
  }
  if (!rest) return { view: 'all' }

  if (head === 'folder') {
    const folderId = safeDecode(rest)
    if (folderId) return { view: 'folder', folderId }
    return { view: 'all' }
  }
  if (head === 'creator') {
    const key = safeDecode(rest)
    if (key) return { view: 'creator', key }
    return { view: 'all' }
  }
  return { view: 'all' }
}

/** Scale (w, h) to fit within max on the longer side without upscaling; returns integers >= 1. */
export function fitWithin(
  w: number,
  h: number,
  max: number
): { w: number; h: number } {
  const safeW = Number.isFinite(w) && w > 0 ? w : 1
  const safeH = Number.isFinite(h) && h > 0 ? h : 1
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1
  const longest = Math.max(safeW, safeH)
  if (longest <= safeMax) {
    return {
      w: Math.max(1, Math.round(safeW)),
      h: Math.max(1, Math.round(safeH)),
    }
  }
  const scale = safeMax / longest
  return {
    w: Math.max(1, Math.round(safeW * scale)),
    h: Math.max(1, Math.round(safeH * scale)),
  }
}
