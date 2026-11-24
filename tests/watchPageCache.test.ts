/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Unit tests for pageCache validation logic (isPageCacheValid, firstIdsOf). */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_CACHE_MAX_AGE_MS,
  firstIdsOf,
  isPageCacheValid,
  type PageCacheEntry,
} from '../src/watchpage/pageCache'

describe('watchpage/pageCache', () => {
  it('firstIdsOf joins up to the first 5 post ids with commas', () => {
    const posts = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i + 1}`,
      title: `Post ${i + 1}`,
      published: '',
    }))
    expect(firstIdsOf(posts)).toBe('p1,p2,p3,p4,p5')
    expect(firstIdsOf(posts.slice(0, 2))).toBe('p1,p2')
    expect(firstIdsOf([])).toBe('')
  })

  it('validates entry only when firstIds match and entry is within maxAgeMs', () => {
    const now = 1_000_000
    const entry: PageCacheEntry = {
      firstIds: 'a,b,c,d,e',
      fetchedAt: now - 1000,
      posts: [],
    }

    expect(isPageCacheValid(entry, 'a,b,c,d,e', now)).toBe(true)
    expect(isPageCacheValid(entry, 'x,a,b,c,d', now)).toBe(false)
    expect(isPageCacheValid(entry, '', now)).toBe(false)
    expect(isPageCacheValid(undefined, 'a,b,c,d,e', now)).toBe(false)
  })

  it('expires entries at or beyond maxAgeMs', () => {
    const fetchedAt = 10_000
    const entry: PageCacheEntry = {
      firstIds: '1,2,3',
      fetchedAt,
      posts: [],
    }

    expect(
      isPageCacheValid(
        entry,
        '1,2,3',
        fetchedAt + DEFAULT_PAGE_CACHE_MAX_AGE_MS - 1
      )
    ).toBe(true)
    expect(
      isPageCacheValid(
        entry,
        '1,2,3',
        fetchedAt + DEFAULT_PAGE_CACHE_MAX_AGE_MS
      )
    ).toBe(false)
    expect(isPageCacheValid(entry, '1,2,3', fetchedAt + 5000, 5000)).toBe(false)
    expect(isPageCacheValid(entry, '1,2,3', fetchedAt + 4999, 5000)).toBe(true)
  })
})
