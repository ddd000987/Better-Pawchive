/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Unit tests for pure watchlist tracking logic in src/watch/tracker.ts. */

import { describe, expect, it } from 'vitest'
import type { PostsApiItem } from '../src/kemono/apiTypes'
import {
  comparePublished,
  diffTracking,
  markRead,
  SEEN_CAP,
  startTracking,
  toUnread,
  UNREAD_CAP,
} from '../src/watch/tracker'
import type { WatchTracking } from '../src/watch/watchTypes'

function makeItem(
  id: string,
  published: string,
  opts: Partial<PostsApiItem> = {}
): PostsApiItem {
  return {
    id,
    user: 'u1',
    service: 'patreon',
    title: opts.title ?? `Title ${id}`,
    published,
    file: opts.file ?? {},
    attachments: opts.attachments ?? [],
  }
}

describe('comparePublished', () => {
  it('treats empty string as oldest, parses valid dates, and falls back to string compare', () => {
    expect(comparePublished('', '')).toBe(0)
    expect(comparePublished('', '2025-01-01T00:00:00')).toBeLessThan(0)
    expect(comparePublished('2025-01-01T00:00:00', '')).toBeGreaterThan(0)
    expect(comparePublished('', 'not-a-date')).toBeLessThan(0)
    expect(comparePublished('not-a-date', '')).toBeGreaterThan(0)

    expect(
      comparePublished('2025-01-01T00:00:00', '2025-01-02T00:00:00')
    ).toBeLessThan(0)
    expect(
      comparePublished('2025-01-02T00:00:00', '2025-01-01T00:00:00')
    ).toBeGreaterThan(0)
    expect(
      comparePublished('2025-01-01T00:00:00Z', '2025-01-01T00:00:00.000Z')
    ).toBe(0)

    // Unparsable strings fall back to lexicographical order
    expect(comparePublished('alpha', 'beta')).toBeLessThan(0)
    expect(comparePublished('beta', 'alpha')).toBeGreaterThan(0)
    expect(comparePublished('2025-01-01', 'invalid')).toBeLessThan(0)
  })
})

describe('toUnread', () => {
  it('extracts coverPath from file or first image attachment', () => {
    const withFile = makeItem('1', '2025-01-01', {
      file: { path: '/a/cover.jpg' },
    })
    expect(toUnread(withFile)).toEqual({
      id: '1',
      title: 'Title 1',
      published: '2025-01-01',
      coverPath: '/a/cover.jpg',
    })

    const withAttachment = makeItem('2', '2025-01-01', {
      file: { path: '/a/video.mp4' },
      attachments: [{ path: '/a/doc.zip' }, { path: '/a/pic.webp' }],
    })
    expect(toUnread(withAttachment).coverPath).toBe('/a/pic.webp')

    const noImage = makeItem('3', '2025-01-01', {
      file: { path: '/a/video.mp4' },
    })
    expect('coverPath' in toUnread(noImage)).toBe(false)
  })
})

describe('startTracking', () => {
  it('sets baseline to newest published, caps seenIds, and starts with empty unread', () => {
    const items = [
      makeItem('p1', '2025-01-01T00:00:00'),
      makeItem('p3', '2025-01-03T00:00:00'),
      makeItem('p2', '2025-01-02T00:00:00'),
    ]
    const t = startTracking(items, 1000)
    expect(t).toEqual({
      enabled: true,
      since: 1000,
      baselinePublished: '2025-01-03T00:00:00',
      seenIds: ['p1', 'p3', 'p2'],
      unread: [],
      lastCheckedAt: 1000,
    })

    const empty = startTracking([], 2000)
    expect(empty.baselinePublished).toBe('')
    expect(empty.seenIds).toEqual([])
  })
})

describe('diffTracking', () => {
  it('first check after an offline start establishes baseline without adding new posts', () => {
    const offline: WatchTracking = {
      enabled: true,
      since: 100,
      baselinePublished: '',
      seenIds: [],
      unread: [{ id: 'old', title: 'Old', published: '2024-01-01' }],
      lastError: 'offline',
    }
    const items = [
      makeItem('p2', '2025-02-01T00:00:00'),
      makeItem('p1', '2025-01-01T00:00:00'),
    ]
    const { tracking, added } = diffTracking(offline, items, 200)
    expect(added).toEqual([])
    expect(tracking.since).toBe(100)
    expect(tracking.baselinePublished).toBe('2025-02-01T00:00:00')
    expect(tracking.seenIds).toEqual(['p2', 'p1'])
    expect(tracking.unread).toEqual(offline.unread)
    expect(tracking.lastCheckedAt).toBe(200)
    expect(tracking.lastError).toBeUndefined()
  })

  it('detects new posts, ignores backfilled older posts while marking them seen, and counts same-date new ids', () => {
    const base = startTracking([makeItem('p2', '2025-01-02T00:00:00')], 1000)
    base.lastError = 'temporary error'

    const { tracking, added } = diffTracking(
      base,
      [
        makeItem('p4', '2025-01-04T00:00:00'),
        makeItem('p2b', '2025-01-02T00:00:00'), // same date, new id -> counts!
        makeItem('p2', '2025-01-02T00:00:00'), // already seen
        makeItem('p1', '2025-01-01T00:00:00'), // backfilled older post -> ignored, but added to seenIds
      ],
      2000
    )

    expect(added.map((p) => p.id)).toEqual(['p4', 'p2b'])
    expect(tracking.unread.map((p) => p.id)).toEqual(['p4', 'p2b'])
    expect(tracking.seenIds).toEqual(['p4', 'p2b', 'p2', 'p1'])
    expect(tracking.baselinePublished).toBe('2025-01-04T00:00:00')
    expect(tracking.lastCheckedAt).toBe(2000)
    expect(tracking.lastError).toBeUndefined()
    expect(tracking.overflow).toBeUndefined()
  })

  it('sets overflow when a full page of >= 50 items are all new and keeps it until markRead', () => {
    const base = startTracking([makeItem('old', '2025-01-01T00:00:00')], 1000)
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      makeItem(
        `n${i}`,
        `2025-02-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00`
      )
    )
    const first = diffTracking(base, fullPage, 2000)
    expect(first.added).toHaveLength(50)
    expect(first.tracking.overflow).toBe(true)

    // Subsequent check with no new posts preserves overflow
    const second = diffTracking(first.tracking, fullPage, 3000)
    expect(second.added).toEqual([])
    expect(second.tracking.overflow).toBe(true)

    // markRead clears unread and removes overflow
    const cleared = markRead(second.tracking)
    expect(cleared.unread).toEqual([])
    expect(cleared.overflow).toBeUndefined()
    expect(cleared.lastCheckedAt).toBe(3000)
    // Original was not mutated
    expect(second.tracking.overflow).toBe(true)
    expect(second.tracking.unread).toHaveLength(50)
  })

  it('orders unread newest-first, dedupes by id, caps unread at UNREAD_CAP and seenIds at SEEN_CAP', () => {
    const oldUnread = Array.from({ length: UNREAD_CAP }, (_, i) => ({
      id: `u${i}`,
      title: `Old ${i}`,
      published: '2025-01-02T00:00:00',
    }))
    const oldSeen = Array.from({ length: SEEN_CAP }, (_, i) => `s${i}`)
    const initial: WatchTracking = {
      enabled: true,
      since: 100,
      baselinePublished: '2025-01-01T00:00:00',
      seenIds: oldSeen,
      unread: oldUnread,
      lastCheckedAt: 100,
    }
    const snapshotBefore = structuredClone(initial)

    // Include one post whose id is already in oldUnread (not in seenIds) plus two new posts out of order
    const items = [
      makeItem('new-older', '2025-01-03T00:00:00'),
      makeItem('new-newer', '2025-01-05T00:00:00'),
      makeItem('u0', '2025-01-04T00:00:00'),
    ]

    const { tracking, added } = diffTracking(initial, items, 500)

    // Input must not be mutated
    expect(initial).toEqual(snapshotBefore)

    // Added sorted newest first
    expect(added.map((p) => p.id)).toEqual(['new-newer', 'u0', 'new-older'])

    // Unread has new posts first, deduped (u0 appears once), capped at UNREAD_CAP
    expect(tracking.unread).toHaveLength(UNREAD_CAP)
    expect(tracking.unread.slice(0, 4).map((p) => p.id)).toEqual([
      'new-newer',
      'u0',
      'new-older',
      'u1',
    ])
    expect(tracking.unread.filter((p) => p.id === 'u0')).toHaveLength(1)

    // seenIds has current page ids first, capped at SEEN_CAP
    expect(tracking.seenIds).toHaveLength(SEEN_CAP)
    expect(tracking.seenIds.slice(0, 4)).toEqual([
      'new-older',
      'new-newer',
      'u0',
      's0',
    ])
  })
})
