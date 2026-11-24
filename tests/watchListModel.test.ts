/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Unit tests for pure watchlist model helpers (listModel.ts). */

import { describe, expect, it } from 'vitest'
import {
  UNSORTED_FOLDER_ID,
  type CreatorSnapshot,
  type WatchedCreator,
} from '../src/watch/watchTypes'
import {
  displayName,
  filterCreators,
  fitWithin,
  latestPublished,
  parseRoute,
  sortCreators,
} from '../src/watchpage/listModel'

function makeCreator(
  overrides: Partial<WatchedCreator> & {
    key: string
    creatorId: string
    name: string
  }
): WatchedCreator {
  return {
    site: 'kemono',
    service: 'patreon',
    folderId: UNSORTED_FOLDER_ID,
    addedAt: 0,
    ...overrides,
  }
}

describe('watchpage/listModel', () => {
  describe('displayName', () => {
    it('prefers trimmed alias over original name', () => {
      const c1 = makeCreator({
        key: 'kemono/patreon/1',
        creatorId: '1',
        name: 'Original',
        alias: 'Custom',
      })
      const c2 = makeCreator({
        key: 'kemono/patreon/2',
        creatorId: '2',
        name: 'Original',
        alias: '   ',
      })
      const c3 = makeCreator({
        key: 'kemono/patreon/3',
        creatorId: '3',
        name: 'Original',
      })
      expect(displayName(c1)).toBe('Custom')
      expect(displayName(c2)).toBe('Original')
      expect(displayName(c3)).toBe('Original')
    })
  })

  describe('filterCreators', () => {
    const list: WatchedCreator[] = [
      makeCreator({
        key: 'kemono/patreon/101',
        creatorId: '101',
        name: 'Alice Art',
        alias: 'A-chan',
        note: 'Watercolor landscapes',
      }),
      makeCreator({
        key: 'pawchive/fanbox/202',
        creatorId: '202',
        name: 'Bob Studio',
        note: '3D renders',
      }),
      makeCreator({
        key: 'kemono/pixiv/303',
        creatorId: '303',
        name: 'Carol',
      }),
    ]

    it('returns all items when query is empty or whitespace', () => {
      expect(filterCreators(list, '')).toHaveLength(3)
      expect(filterCreators(list, '   ')).toHaveLength(3)
    })

    it('matches alias, name, note, and creatorId case-insensitively', () => {
      expect(filterCreators(list, 'a-CHAN').map((c) => c.creatorId)).toEqual([
        '101',
      ])
      expect(filterCreators(list, 'studio').map((c) => c.creatorId)).toEqual([
        '202',
      ])
      expect(
        filterCreators(list, 'WATERCOLOR').map((c) => c.creatorId)
      ).toEqual(['101'])
      expect(filterCreators(list, '303').map((c) => c.creatorId)).toEqual([
        '303',
      ])
      expect(filterCreators(list, 'nonexistent')).toEqual([])
    })
  })

  describe('latestPublished', () => {
    it('returns empty string for undefined or empty snapshots', () => {
      expect(latestPublished(undefined)).toBe('')
      expect(latestPublished({ key: 'k', fetchedAt: 1, posts: [] })).toBe('')
    })

    it('returns the newest published timestamp across posts', () => {
      const snap: CreatorSnapshot = {
        key: 'k',
        fetchedAt: 1,
        posts: [
          { id: '1', title: 'Old', published: '2025-01-01T00:00:00' },
          { id: '2', title: 'Newest', published: '2026-03-15T12:00:00' },
          { id: '3', title: 'Mid', published: '2025-12-01T00:00:00' },
        ],
      }
      expect(latestPublished(snap)).toBe('2026-03-15T12:00:00')
    })
  })

  describe('sortCreators', () => {
    const a = makeCreator({
      key: 'kemono/patreon/1',
      creatorId: '1',
      name: 'Zelda',
      alias: 'Alpha',
      addedAt: 100,
    })
    const b = makeCreator({
      key: 'kemono/patreon/2',
      creatorId: '2',
      name: 'Bravo',
      addedAt: 300,
    })
    const c = makeCreator({
      key: 'kemono/patreon/3',
      creatorId: '3',
      name: 'Charlie',
      addedAt: 200,
    })

    const snaps = new Map<string, CreatorSnapshot>([
      [
        a.key,
        {
          key: a.key,
          fetchedAt: 10,
          posts: [{ id: 'p1', title: '', published: '2025-05-01T00:00:00' }],
        },
      ],
      [
        c.key,
        {
          key: c.key,
          fetchedAt: 10,
          posts: [{ id: 'p2', title: '', published: '2026-01-10T00:00:00' }],
        },
      ],
    ])

    it('sorts by display name A->Z using alias when present', () => {
      const res = sortCreators([c, b, a], 'name', snaps)
      expect(res.map((x) => x.creatorId)).toEqual(['1', '2', '3'])
    })

    it('sorts by addedAt descending', () => {
      const res = sortCreators([a, c, b], 'added', snaps)
      expect(res.map((x) => x.creatorId)).toEqual(['2', '3', '1'])
    })

    it('sorts by latest post descending with missing snapshots last', () => {
      const res = sortCreators([b, a, c], 'latest', snaps)
      expect(res.map((x) => x.creatorId)).toEqual(['3', '1', '2'])
    })

    it('sorts by unread count descending with name tie-breaker', () => {
      const t1 = makeCreator({
        key: 'kemono/patreon/10',
        creatorId: '10',
        name: 'Beta',
        tracking: {
          enabled: true,
          since: 1,
          baselinePublished: '2026-01-01',
          seenIds: [],
          unread: [
            { id: '1', title: 'a', published: '2026-01-02' },
            { id: '2', title: 'b', published: '2026-01-03' },
          ],
        },
      })
      const t2 = makeCreator({
        key: 'kemono/patreon/11',
        creatorId: '11',
        name: 'Alpha',
        tracking: {
          enabled: true,
          since: 1,
          baselinePublished: '2026-01-01',
          seenIds: [],
          unread: [
            { id: '3', title: 'c', published: '2026-01-02' },
            { id: '4', title: 'd', published: '2026-01-03' },
          ],
        },
      })
      const t3 = makeCreator({
        key: 'kemono/patreon/12',
        creatorId: '12',
        name: 'Gamma',
        tracking: {
          enabled: true,
          since: 1,
          baselinePublished: '2026-01-01',
          seenIds: [],
          unread: [
            { id: '5', title: 'e', published: '2026-01-02' },
            { id: '6', title: 'f', published: '2026-01-03' },
            { id: '7', title: 'g', published: '2026-01-04' },
          ],
        },
      })
      const res = sortCreators([b, t1, t2, t3], 'unread', snaps)
      expect(res.map((x) => x.creatorId)).toEqual(['12', '11', '10', '2'])
    })

    it('does not mutate the input array', () => {
      const input = [c, b, a]
      sortCreators(input, 'name', snaps)
      expect(input.map((x) => x.creatorId)).toEqual(['3', '2', '1'])
    })
  })

  describe('parseRoute', () => {
    it('parses all, updates, tracking, feed, folder, and encoded creator routes', () => {
      expect(parseRoute('')).toEqual({ view: 'all' })
      expect(parseRoute('#')).toEqual({ view: 'all' })
      expect(parseRoute('#/all')).toEqual({ view: 'all' })
      expect(parseRoute('#/updates')).toEqual({ view: 'updates' })
      expect(parseRoute('#/tracking')).toEqual({ view: 'tracking' })
      expect(parseRoute('#/feed')).toEqual({ view: 'feed' })
      expect(parseRoute('#/folder/unsorted')).toEqual({
        view: 'folder',
        folderId: 'unsorted',
      })
      expect(parseRoute('#/folder/f_123')).toEqual({
        view: 'folder',
        folderId: 'f_123',
      })
      expect(
        parseRoute('#/creator/' + encodeURIComponent('pawchive/patreon/42'))
      ).toEqual({
        view: 'creator',
        key: 'pawchive/patreon/42',
      })
    })

    it('falls back to all on unknown or malformed hashes', () => {
      expect(parseRoute('#/unknown/foo')).toEqual({ view: 'all' })
      expect(parseRoute('#/folder/')).toEqual({ view: 'all' })
      expect(parseRoute('#/creator/')).toEqual({ view: 'all' })
      expect(parseRoute('#/creator/%E0%A4%A')).toEqual({ view: 'all' })
    })
  })

  describe('fitWithin', () => {
    it('never upscales images already within max', () => {
      expect(fitWithin(400, 300, 800)).toEqual({ w: 400, h: 300 })
      expect(fitWithin(800, 800, 800)).toEqual({ w: 800, h: 800 })
    })

    it('scales landscape and portrait images preserving aspect ratio', () => {
      expect(fitWithin(1600, 800, 800)).toEqual({ w: 800, h: 400 })
      expect(fitWithin(1000, 2000, 800)).toEqual({ w: 400, h: 800 })
      expect(fitWithin(1920, 1080, 800)).toEqual({ w: 800, h: 450 })
    })

    it('clamps extreme ratios and invalid inputs to integers >= 1', () => {
      expect(fitWithin(10000, 1, 800)).toEqual({ w: 800, h: 1 })
      expect(fitWithin(0, -5, 800)).toEqual({ w: 1, h: 1 })
    })
  })
})
