/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure post tracking logic: baseline tracking, diffing new posts, and marking read. */

import type { PostsApiItem, PostsApiResponse } from '../kemono/apiTypes'
import { postCoverPath } from './snapshot'
import type { UnreadPost, WatchTracking } from './watchTypes'

export const SEEN_CAP = 200
export const UNREAD_CAP = 500
const OVERFLOW_PAGE_SIZE = 50

export function comparePublished(a: string, b: string): number {
  if (a === b) return 0
  if (a === '') return -1
  if (b === '') return 1
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) {
    return ta - tb
  }
  return a < b ? -1 : 1
}

export function toUnread(item: PostsApiItem): UnreadPost {
  const post: UnreadPost = {
    id: item.id,
    title: typeof item.title === 'string' ? item.title : '',
    published: typeof item.published === 'string' ? item.published : '',
  }
  const coverPath = postCoverPath(item)
  if (coverPath) post.coverPath = coverPath
  return post
}

function uniqueCapped(ids: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= cap) break
  }
  return out
}

function newestPublished(items: PostsApiResponse, initial = ''): string {
  let max = initial
  for (const item of items) {
    if (!item || typeof item.published !== 'string') continue
    if (comparePublished(item.published, max) > 0) {
      max = item.published
    }
  }
  return max
}

export function startTracking(
  items: PostsApiResponse,
  now: number
): WatchTracking {
  const pageIds: string[] = []
  for (const item of items) {
    if (item && typeof item.id === 'string' && item.id) {
      pageIds.push(item.id)
    }
  }
  return {
    enabled: true,
    since: now,
    baselinePublished: newestPublished(items),
    seenIds: uniqueCapped(pageIds, SEEN_CAP),
    unread: [],
    lastCheckedAt: now,
  }
}

export function diffTracking(
  t: WatchTracking,
  items: PostsApiResponse,
  now: number
): { tracking: WatchTracking; added: UnreadPost[] } {
  const validItems = items.filter(
    (item): item is PostsApiItem =>
      !!item && typeof item.id === 'string' && item.id.length > 0
  )
  const pageIds = validItems.map((item) => item.id)

  // Never checked yet (e.g. tracking turned on while offline): establish baseline
  if (t.baselinePublished === '' && t.seenIds.length === 0) {
    const tracking: WatchTracking = {
      enabled: t.enabled,
      since: t.since,
      baselinePublished: newestPublished(validItems),
      seenIds: uniqueCapped(pageIds, SEEN_CAP),
      unread: t.unread.map((u) => ({ ...u })),
      lastCheckedAt: now,
    }
    if (t.overflow) tracking.overflow = true
    return { tracking, added: [] }
  }

  const oldSeen = new Set(t.seenIds)
  const addedRaw: UnreadPost[] = []
  const addedIds = new Set<string>()
  let allNew = validItems.length > 0

  for (const item of validItems) {
    const pub = typeof item.published === 'string' ? item.published : ''
    const isNew =
      !oldSeen.has(item.id) && comparePublished(pub, t.baselinePublished) >= 0
    if (isNew) {
      if (!addedIds.has(item.id)) {
        addedIds.add(item.id)
        addedRaw.push(toUnread(item))
      }
    } else {
      allNew = false
    }
  }

  const added = addedRaw.sort((a, b) =>
    comparePublished(b.published, a.published)
  )

  const unread: UnreadPost[] = []
  const unreadSeen = new Set<string>()
  for (const post of [...added, ...t.unread]) {
    if (unreadSeen.has(post.id)) continue
    unreadSeen.add(post.id)
    unread.push({ ...post })
    if (unread.length >= UNREAD_CAP) break
  }

  const pageOverflow = validItems.length >= OVERFLOW_PAGE_SIZE && allNew
  const tracking: WatchTracking = {
    enabled: t.enabled,
    since: t.since,
    baselinePublished: newestPublished(validItems, t.baselinePublished),
    seenIds: uniqueCapped([...pageIds, ...t.seenIds], SEEN_CAP),
    unread,
    lastCheckedAt: now,
  }
  if (t.overflow || pageOverflow) {
    tracking.overflow = true
  }

  return { tracking, added }
}

export function markRead(t: WatchTracking): WatchTracking {
  const next: WatchTracking = {
    enabled: t.enabled,
    since: t.since,
    baselinePublished: t.baselinePublished,
    seenIds: [...t.seenIds],
    unread: [],
  }
  if (t.lastCheckedAt !== undefined) next.lastCheckedAt = t.lastCheckedAt
  if (t.lastError !== undefined) next.lastError = t.lastError
  return next
}
