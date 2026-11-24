import { describe, expect, it } from 'vitest'
import {
  emptyCollectData,
  validateFavImages,
  validateFavPosts,
} from '../src/watch/collectData'
import { validateWatchData } from '../src/watch/watchData'
import { parseImagePathFromUrl } from '../src/watch/watchKey'
import { UNSORTED_FOLDER_ID } from '../src/watch/watchTypes'

describe('collectData', () => {
  it('validateFavPosts returns empty on garbage, drops invalid items, fixes folders and sanitizes labels', () => {
    expect(validateFavPosts(null)).toEqual(emptyCollectData())
    expect(validateFavPosts('bad')).toEqual(emptyCollectData())

    const data = validateFavPosts({
      folders: [{ id: 'f1', name: 'Saved', order: 1, createdAt: 10 }],
      items: {
        // valid item with unknown folder -> unsorted, trimmed note, sanitized labels
        'pawchive/patreon/100/999': {
          key: 'pawchive/patreon/100/999',
          site: 'pawchive',
          service: 'patreon',
          creatorId: '100',
          postId: '999',
          title: 'My Post',
          published: '2026-01-01T00:00:00',
          coverPath: '/5a/48/5a48deadbeef.jpeg',
          creatorName: 'Alice',
          folderId: 'missing',
          addedAt: 500,
          note: '  good post  ',
          rating: 5,
          tags: ['  Art ', 'art', 'Color'],
        },
        // valid item with empty note and bad coverPath/rating -> removed
        'kemono/fanbox/200/888': {
          key: 'kemono/fanbox/200/888',
          site: 'kemono',
          service: 'fanbox',
          creatorId: '200',
          postId: '888',
          title: 'Second',
          coverPath: 'no-leading-slash.jpg',
          creatorName: 'Bob',
          folderId: 'f1',
          addedAt: Number.NaN,
          note: '   ',
          rating: 9,
          tags: ['   '],
        },
        // key mismatch -> dropped
        'pawchive/patreon/100/WRONG': {
          key: 'pawchive/patreon/100/WRONG',
          site: 'pawchive',
          service: 'patreon',
          creatorId: '100',
          postId: '777',
          title: 'Mismatch',
          creatorName: 'X',
          folderId: 'f1',
          addedAt: 1,
        },
        // bad service -> dropped
        'pawchive/invalid/100/777': {
          key: 'pawchive/invalid/100/777',
          site: 'pawchive',
          service: 'invalid',
          creatorId: '100',
          postId: '777',
          title: 'Bad service',
          creatorName: 'X',
          folderId: 'f1',
          addedAt: 1,
        },
      },
    })

    expect(Object.keys(data.items)).toEqual([
      'pawchive/patreon/100/999',
      'kemono/fanbox/200/888',
    ])

    const p1 = data.items['pawchive/patreon/100/999']
    expect(p1.folderId).toBe(UNSORTED_FOLDER_ID)
    expect(p1.note).toBe('good post')
    expect(p1.rating).toBe(5)
    expect(p1.tags).toEqual(['Art', 'Color'])
    expect(p1.coverPath).toBe('/5a/48/5a48deadbeef.jpeg')

    const p2 = data.items['kemono/fanbox/200/888']
    expect(p2.folderId).toBe('f1')
    expect(p2.addedAt).toBe(0)
    expect(p2.coverPath).toBeUndefined()
    expect(p2.note).toBeUndefined()
    expect(p2.rating).toBeUndefined()
    expect(p2.tags).toBeUndefined()
  })

  it('validateFavImages validates path, key match, folders, and labels', () => {
    expect(validateFavImages(undefined)).toEqual(emptyCollectData())

    const data = validateFavImages({
      folders: [{ id: 'f1', name: 'Wallpapers', order: 1, createdAt: 1 }],
      items: {
        'pawchive/5a/48/5a48deadbeef.jpeg': {
          key: 'pawchive/5a/48/5a48deadbeef.jpeg',
          site: 'pawchive',
          path: '/5a/48/5a48deadbeef.jpeg',
          fileName: 'orig.jpeg',
          service: 'patreon',
          creatorId: '10',
          postId: '20',
          postTitle: 'Post',
          creatorName: 'Alice',
          folderId: 'f1',
          addedAt: 123,
          rating: 4,
          tags: ['Wallpaper'],
          note: '  nice ',
        },
        // invalid path with query -> dropped
        'pawchive/5a/48/5a48deadbeef.jpeg?f=1': {
          key: 'pawchive/5a/48/5a48deadbeef.jpeg?f=1',
          site: 'pawchive',
          path: '/5a/48/5a48deadbeef.jpeg?f=1',
          service: 'patreon',
          creatorId: '10',
          postId: '20',
          folderId: 'f1',
          addedAt: 123,
        },
        // key mismatch -> dropped
        'kemono/5a/48/5a48deadbeef.jpeg': {
          key: 'kemono/5a/48/5a48deadbeef.jpeg',
          site: 'pawchive',
          path: '/5a/48/5a48deadbeef.jpeg',
          service: 'patreon',
          creatorId: '10',
          postId: '20',
          folderId: 'f1',
          addedAt: 123,
        },
      },
    })

    expect(Object.keys(data.items)).toEqual([
      'pawchive/5a/48/5a48deadbeef.jpeg',
    ])
    const img = data.items['pawchive/5a/48/5a48deadbeef.jpeg']
    expect(img.fileName).toBe('orig.jpeg')
    expect(img.note).toBe('nice')
    expect(img.rating).toBe(4)
    expect(img.tags).toEqual(['Wallpaper'])
  })

  it('parseImagePathFromUrl handles Pawchive full/thumb URLs, Kemono thumb URLs, and rejects junk', () => {
    const hash = '5a48deadbeef0123456789abcdef'
    expect(
      parseImagePathFromUrl(
        `https://n4.pawchive.pw/data/25a/48/${hash}.jpeg?f=a.jpeg`
      )
    ).toBe(`/5a/48/${hash}.jpeg`)

    expect(
      parseImagePathFromUrl(
        `https://img.pawchive.pw/thumbnail/data/5a/48/${hash}.jpeg`
      )
    ).toBe(`/5a/48/${hash}.jpeg`)

    const kemonoHash = 'abcd1234567890ef'
    expect(
      parseImagePathFromUrl(
        `https://img.kemono.cr/thumbnail/data/ab/cd/${kemonoHash}.png#hash`
      )
    ).toBe(`/ab/cd/${kemonoHash}.png`)

    expect(parseImagePathFromUrl('')).toBeNull()
    expect(parseImagePathFromUrl('not a url')).toBeNull()
    expect(
      parseImagePathFromUrl('https://example.com/other/5a/48/5a48abcd.png')
    ).toBeNull()
    expect(
      parseImagePathFromUrl(
        'https://n4.pawchive.pw/data/5a/48/not-a-hex-hash.jpeg'
      )
    ).toBeNull()
  })

  it('validateWatchData keeps valid rating, tags, and previews and drops bad ones', () => {
    const data = validateWatchData({
      creators: {
        'pawchive/patreon/1': {
          key: 'pawchive/patreon/1',
          site: 'pawchive',
          service: 'patreon',
          creatorId: '1',
          name: 'Alice',
          folderId: UNSORTED_FOLDER_ID,
          addedAt: 1,
          rating: 5,
          tags: ['  TagA ', 'taga', 'TagB'],
          previews: [
            { kind: 'post', path: '/a/1.jpg' },
            { kind: 'post', path: '/a/1.jpg' }, // duplicate
            { kind: 'post', path: 'bad-no-slash.jpg' }, // invalid
            { kind: 'upload', id: 'u1' },
            { kind: 'upload', id: 'u1' }, // duplicate
            { kind: 'upload', id: '' }, // invalid
            { kind: 'post', path: '/a/2.jpg' },
            { kind: 'post', path: '/a/3.jpg' },
            { kind: 'post', path: '/a/4.jpg' },
            { kind: 'post', path: '/a/5.jpg' },
            { kind: 'post', path: '/a/6.jpg' }, // exceeds MAX_PREVIEWS (6)
          ],
        },
        'kemono/fanbox/2': {
          key: 'kemono/fanbox/2',
          site: 'kemono',
          service: 'fanbox',
          creatorId: '2',
          name: 'Bob',
          folderId: UNSORTED_FOLDER_ID,
          addedAt: 1,
          rating: 0,
          tags: ['   '],
          previews: [{ kind: 'post', path: 'invalid' }],
        },
      },
    })

    const c1 = data.creators['pawchive/patreon/1']
    expect(c1.rating).toBe(5)
    expect(c1.tags).toEqual(['TagA', 'TagB'])
    expect(c1.previews).toEqual([
      { kind: 'post', path: '/a/1.jpg' },
      { kind: 'upload', id: 'u1' },
      { kind: 'post', path: '/a/2.jpg' },
      { kind: 'post', path: '/a/3.jpg' },
      { kind: 'post', path: '/a/4.jpg' },
      { kind: 'post', path: '/a/5.jpg' },
    ])

    const c2 = data.creators['kemono/fanbox/2']
    expect(c2.rating).toBeUndefined()
    expect(c2.tags).toBeUndefined()
    expect(c2.previews).toBeUndefined()
  })
})
