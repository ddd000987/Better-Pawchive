import { describe, expect, it, vi } from 'vitest'
import type { PostsApiItem } from '../src/kemono/apiTypes'
import {
  isSnapshotStale,
  snapshotFromPosts,
  snapshots,
} from '../src/watch/snapshot'

function makeItem(overrides: Partial<PostsApiItem> = {}): PostsApiItem {
  return {
    id: '1',
    user: 'u1',
    service: 'patreon',
    title: 'Title',
    published: '2026-01-01T00:00:00',
    file: {},
    attachments: [],
    ...overrides,
  }
}

describe('snapshot', () => {
  it('snapshotFromPosts selects image cover from file or first image attachment', () => {
    const items: PostsApiItem[] = [
      makeItem({
        id: '1',
        title: 'From file',
        file: { name: 'cover.png', path: '/a/cover.png' },
        attachments: [{ name: 'att.jpg', path: '/a/att.jpg' }],
      }),
      makeItem({
        id: '2',
        title: 'From attachment',
        file: { name: 'archive.zip', path: '/a/archive.zip' },
        attachments: [
          { name: 'video.mp4', path: '/a/video.mp4' },
          { name: 'pic.webp', path: '/a/pic.webp' },
          { name: 'pic2.png', path: '/a/pic2.png' },
        ],
      }),
      makeItem({
        id: '3',
        title: 'No image',
        file: { name: 'clip.mp4', path: '/a/clip.mp4' },
        attachments: [{ name: 'doc.zip', path: '/a/doc.zip' }],
      }),
      makeItem({
        id: '' as any,
        title: 'Skipped empty id',
      }),
    ]

    const snap = snapshotFromPosts('kemono/patreon/u1', items, 12345)
    expect(snap).toEqual({
      key: 'kemono/patreon/u1',
      fetchedAt: 12345,
      posts: [
        {
          id: '1',
          title: 'From file',
          published: '2026-01-01T00:00:00',
          coverPath: '/a/cover.png',
        },
        {
          id: '2',
          title: 'From attachment',
          published: '2026-01-01T00:00:00',
          coverPath: '/a/pic.webp',
        },
        {
          id: '3',
          title: 'No image',
          published: '2026-01-01T00:00:00',
        },
      ],
    })
  })

  it('snapshotFromPosts caps at 50 posts', () => {
    const items = Array.from({ length: 65 }, (_, i) =>
      makeItem({ id: String(i + 1) })
    )
    const snap = snapshotFromPosts('pawchive/fanbox/u1', items, 1000)
    expect(snap.posts).toHaveLength(50)
    expect(snap.posts[0].id).toBe('1')
    expect(snap.posts[49].id).toBe('50')
  })

  it('isSnapshotStale checks missing snapshot and age against maxAgeMs', () => {
    expect(isSnapshotStale(undefined, 1000, 5000)).toBe(true)
    const snap = { key: 'kemono/patreon/1', fetchedAt: 4000, posts: [] }
    expect(isSnapshotStale(snap, 1000, 4500)).toBe(false)
    expect(isSnapshotStale(snap, 1000, 5000)).toBe(true)
    expect(isSnapshotStale(snap, 1000, 6000)).toBe(true)
  })

  it('snapshots get, getMany, set, remove validate data and batch getMany into one call', async () => {
    const mem: Record<string, any> = {}
    const get = vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, any> = {}
      for (const k of list) {
        if (k in mem) out[k] = mem[k]
      }
      return out
    })
    const set = vi.fn(async (obj: Record<string, any>) => {
      Object.assign(mem, obj)
    })
    const remove = vi.fn(async (keys: string[]) => {
      for (const k of keys) delete mem[k]
    })

    const g = globalThis as any
    g.chrome = {
      ...(g.chrome ?? {}),
      storage: { local: { get, set, remove } },
    }

    const s1 = snapshotFromPosts(
      'kemono/patreon/1',
      [makeItem({ id: 'p1', file: { name: 'a.jpg', path: '/a.jpg' } })],
      100
    )
    await snapshots.set(s1)
    expect(await snapshots.get('kemono/patreon/1')).toEqual(s1)

    // Store a malformed snapshot directly
    mem['pawchiveProWatchSnap:kemono/patreon/bad'] = {
      key: 'kemono/patreon/bad',
      fetchedAt: 'nope',
      posts: [],
    }

    get.mockClear()
    const many = await snapshots.getMany([
      'kemono/patreon/1',
      'kemono/patreon/bad',
      'kemono/patreon/missing',
    ])
    expect(get).toHaveBeenCalledTimes(1)
    expect(many.size).toBe(1)
    expect(many.get('kemono/patreon/1')).toEqual(s1)

    await snapshots.remove(['kemono/patreon/1'])
    expect(await snapshots.get('kemono/patreon/1')).toBeUndefined()
  })
})
