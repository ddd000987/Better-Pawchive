/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* IndexedDB cache for paginated creator post lists (offsets 50, 100, ...). */

import type { SnapshotPost } from '../watch/watchTypes'
import { idbGet, idbPut } from './idb'

export const DEFAULT_PAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface PageCacheEntry {
  firstIds: string
  fetchedAt: number
  posts: SnapshotPost[]
}

/** Build the fingerprint from the first 5 post IDs of the newest page. */
export function firstIdsOf(posts: SnapshotPost[]): string {
  return posts
    .slice(0, 5)
    .map((p) => p.id)
    .join(',')
}

/** Check whether a cached page entry is still valid for the current newest-page fingerprint. */
export function isPageCacheValid(
  entry: PageCacheEntry | undefined,
  currentFirstIds: string,
  now = Date.now(),
  maxAgeMs = DEFAULT_PAGE_CACHE_MAX_AGE_MS
): boolean {
  if (!entry) return false
  if (!currentFirstIds || entry.firstIds !== currentFirstIds) return false
  if (
    typeof entry.fetchedAt !== 'number' ||
    !Number.isFinite(entry.fetchedAt)
  ) {
    return false
  }
  return now - entry.fetchedAt < maxAgeMs
}

function cacheKey(creatorKey: string, offset: number): string {
  return `${creatorKey}|${offset}`
}

export const pageCache = {
  async get(
    creatorKey: string,
    offset: number,
    currentFirstIds: string
  ): Promise<SnapshotPost[] | undefined> {
    const entry = await idbGet<PageCacheEntry>(
      'pages',
      cacheKey(creatorKey, offset)
    )
    if (!isPageCacheValid(entry, currentFirstIds)) return undefined
    return entry!.posts
  },

  async set(
    creatorKey: string,
    offset: number,
    firstIds: string,
    posts: SnapshotPost[]
  ): Promise<void> {
    const entry: PageCacheEntry = {
      firstIds,
      fetchedAt: Date.now(),
      posts,
    }
    await idbPut('pages', cacheKey(creatorKey, offset), entry)
  },
}
