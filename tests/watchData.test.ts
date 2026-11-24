import { describe, expect, it } from 'vitest'
import {
  creatorsInFolder,
  emptyWatchData,
  sortedFolders,
  totalUnread,
  validateWatchData,
} from '../src/watch/watchData'
import { UNSORTED_FOLDER_ID, type WatchData } from '../src/watch/watchTypes'

describe('watchData', () => {
  it('returns emptyWatchData for non-object or garbage input', () => {
    const empty = emptyWatchData()
    expect(validateWatchData(null)).toEqual(empty)
    expect(validateWatchData(undefined)).toEqual(empty)
    expect(validateWatchData('garbage')).toEqual(empty)
    expect(validateWatchData(123)).toEqual(empty)
    expect(validateWatchData([])).toEqual(empty)
  })

  it('prepends unsorted folder if missing and sanitizes folders', () => {
    const data = validateWatchData({
      version: 99,
      folders: [
        { id: 'f1', name: '  Favorites  ', order: 2, createdAt: 100 },
        { id: 'f1', name: 'Duplicate', order: 5, createdAt: 200 },
        { id: '', name: 'Empty id', order: 1, createdAt: 0 },
        { id: 'x'.repeat(65), name: 'Too long id', order: 1, createdAt: 0 },
        { id: 'f2', name: 'a'.repeat(120), order: 1, createdAt: Number.NaN },
        { id: 'f3', name: 'Bad order', order: Infinity, createdAt: 0 },
        null,
      ],
    })

    expect(data.version).toBe(1)
    expect(data.folders).toEqual([
      { id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 },
      { id: 'f1', name: 'Favorites', order: 2, createdAt: 100 },
      { id: 'f2', name: 'a'.repeat(100), order: 1, createdAt: 0 },
    ])
  })

  it('sanitizes creators, drops key/field mismatches, fixes missing folders and bad covers', () => {
    const seenIds = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const unread = Array.from({ length: 510 }, (_, i) => ({
      id: `u-${i}`,
      title: `Post ${i}`,
      published: '2026-01-01',
    }))

    const data = validateWatchData({
      folders: [{ id: 'f1', name: 'Art', order: 1, createdAt: 10 }],
      creators: {
        // valid creator with unknown folder -> falls back to unsorted
        'pawchive/patreon/1': {
          key: 'pawchive/patreon/1',
          site: 'pawchive',
          service: 'patreon',
          creatorId: '1',
          name: 'Alice',
          alias: '   ',
          note: 'n'.repeat(5050),
          cover: { kind: 'post', path: 'no-leading-slash.jpg' },
          folderId: 'missing-folder',
          addedAt: 500,
          tracking: {
            enabled: true,
            since: 1000,
            baselinePublished: '2026-01-01',
            seenIds: [123, ...seenIds],
            unread: [{ id: '' }, ...unread],
            overflow: true,
            lastCheckedAt: 2000,
            lastError: 'timeout',
          },
        },
        // valid creator with valid folder and upload cover
        'kemono/fanbox/2': {
          key: 'kemono/fanbox/2',
          site: 'kemono',
          service: 'fanbox',
          creatorId: '2',
          name: '',
          alias: '  Bob  ',
          cover: { kind: 'upload', id: 'img-1', extra: true },
          folderId: 'f1',
          addedAt: Number.NaN,
          tracking: { enabled: 'yes' },
        },
        // valid post cover
        'kemono/patreon/3': {
          key: 'kemono/patreon/3',
          site: 'kemono',
          service: 'patreon',
          creatorId: '3',
          name: 'Carol',
          cover: { kind: 'post', path: '/a/b.png' },
          folderId: 'f1',
          addedAt: 10,
        },
        // mismatched fields -> dropped
        'kemono/patreon/4': {
          key: 'kemono/patreon/4',
          site: 'pawchive',
          service: 'patreon',
          creatorId: '4',
          name: 'Mismatch',
          folderId: UNSORTED_FOLDER_ID,
          addedAt: 0,
        },
        // invalid key -> dropped
        'bad/key': {
          key: 'bad/key',
          site: 'kemono',
          service: 'patreon',
          creatorId: '5',
          name: 'Bad',
          folderId: UNSORTED_FOLDER_ID,
          addedAt: 0,
        },
      },
    })

    expect(Object.keys(data.creators)).toEqual([
      'pawchive/patreon/1',
      'kemono/fanbox/2',
      'kemono/patreon/3',
    ])

    const c1 = data.creators['pawchive/patreon/1']
    expect(c1.folderId).toBe(UNSORTED_FOLDER_ID)
    expect(c1.alias).toBeUndefined()
    expect(c1.note).toHaveLength(5000)
    expect(c1.cover).toBeUndefined()
    expect(c1.tracking?.seenIds).toHaveLength(200)
    expect(c1.tracking?.seenIds[0]).toBe('id-50')
    expect(c1.tracking?.seenIds[199]).toBe('id-249')
    expect(c1.tracking?.unread).toHaveLength(500)
    expect(c1.tracking?.unread[0].id).toBe('u-0')
    expect(c1.tracking?.overflow).toBe(true)
    expect(c1.tracking?.lastCheckedAt).toBe(2000)
    expect(c1.tracking?.lastError).toBe('timeout')

    const c2 = data.creators['kemono/fanbox/2']
    expect(c2.name).toBe('2')
    expect(c2.alias).toBe('Bob')
    expect(c2.cover).toEqual({ kind: 'upload', id: 'img-1' })
    expect(c2.folderId).toBe('f1')
    expect(c2.addedAt).toBe(0)
    expect(c2.tracking).toBeUndefined()

    const c3 = data.creators['kemono/patreon/3']
    expect(c3.cover).toEqual({ kind: 'post', path: '/a/b.png' })
  })

  it('filters hosts to valid matching sites only', () => {
    const data = validateWatchData({
      hosts: {
        pawchive: 'www.pawchive.pw',
        kemono: 'pawchive.pw',
        other: 'example.com',
      },
    })
    expect(data.hosts).toEqual({ pawchive: 'www.pawchive.pw' })
  })

  it('sortedFolders puts unsorted first, then sorts by order and createdAt', () => {
    const data: WatchData = {
      version: 1,
      folders: [
        { id: 'f3', name: 'C', order: 2, createdAt: 30 },
        { id: 'f2', name: 'B', order: 1, createdAt: 20 },
        { id: 'f1', name: 'A', order: 1, createdAt: 10 },
        { id: UNSORTED_FOLDER_ID, name: '', order: 99, createdAt: 0 },
      ],
      creators: {},
      hosts: {},
    }
    expect(sortedFolders(data).map((f) => f.id)).toEqual([
      UNSORTED_FOLDER_ID,
      'f1',
      'f2',
      'f3',
    ])
  })

  it('creatorsInFolder and totalUnread compute expected results', () => {
    const data = validateWatchData({
      folders: [{ id: 'f1', name: 'Art', order: 1, createdAt: 0 }],
      creators: {
        'kemono/patreon/1': {
          key: 'kemono/patreon/1',
          site: 'kemono',
          service: 'patreon',
          creatorId: '1',
          name: 'One',
          folderId: 'f1',
          addedAt: 0,
          tracking: {
            enabled: true,
            since: 0,
            baselinePublished: '',
            seenIds: [],
            unread: [
              { id: 'p1', title: 'P1', published: '' },
              { id: 'p2', title: 'P2', published: '' },
            ],
          },
        },
        'kemono/patreon/2': {
          key: 'kemono/patreon/2',
          site: 'kemono',
          service: 'patreon',
          creatorId: '2',
          name: 'Two',
          folderId: UNSORTED_FOLDER_ID,
          addedAt: 0,
          tracking: {
            enabled: false,
            since: 0,
            baselinePublished: '',
            seenIds: [],
            unread: [{ id: 'p3', title: 'P3', published: '' }],
          },
        },
      },
    })

    expect(creatorsInFolder(data, 'f1').map((c) => c.creatorId)).toEqual(['1'])
    expect(totalUnread(data)).toBe(2)
  })
})
