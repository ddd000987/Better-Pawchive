/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Unit tests for favorite posts/images filter, sort, and route parsing helpers. */

import { describe, expect, it } from 'vitest'
import type { FavImage, FavPost } from '../src/watch/collectTypes'
import { UNSORTED_FOLDER_ID } from '../src/watch/watchTypes'
import {
  filterFavImages,
  filterFavPosts,
  sortFavImages,
  sortFavPosts,
} from '../src/watchpage/favModel'
import { parseRoute } from '../src/watchpage/listModel'

function makePost(
  overrides: Partial<FavPost> & { key: string; postId: string; title: string }
): FavPost {
  return {
    site: 'kemono',
    service: 'patreon',
    creatorId: 'c1',
    creatorName: 'Creator One',
    folderId: UNSORTED_FOLDER_ID,
    addedAt: 0,
    ...overrides,
  }
}

function makeImage(
  overrides: Partial<FavImage> & { key: string; path: string }
): FavImage {
  return {
    site: 'kemono',
    service: 'patreon',
    creatorId: 'c1',
    postId: 'p1',
    folderId: UNSORTED_FOLDER_ID,
    addedAt: 0,
    ...overrides,
  }
}

describe('watchpage/favModel', () => {
  describe('parseRoute for favorites', () => {
    it('parses posts and images routes with and without folderId', () => {
      expect(parseRoute('#/posts')).toEqual({ view: 'posts' })
      expect(parseRoute('#/posts/')).toEqual({ view: 'posts' })
      expect(parseRoute('#/posts/unsorted')).toEqual({
        view: 'posts',
        folderId: 'unsorted',
      })
      expect(parseRoute('#/posts/f_abc')).toEqual({
        view: 'posts',
        folderId: 'f_abc',
      })
      expect(parseRoute('#/posts/' + encodeURIComponent('f/1'))).toEqual({
        view: 'posts',
        folderId: 'f/1',
      })
      expect(parseRoute('#/images')).toEqual({ view: 'images' })
      expect(parseRoute('#/images/')).toEqual({ view: 'images' })
      expect(parseRoute('#/images/f_xyz')).toEqual({
        view: 'images',
        folderId: 'f_xyz',
      })
    })

    it('falls back to section all when folderId fails to decode', () => {
      expect(parseRoute('#/posts/%E0%A4%A')).toEqual({ view: 'posts' })
      expect(parseRoute('#/images/%E0%A4%A')).toEqual({ view: 'images' })
    })
  })

  describe('filterFavPosts', () => {
    const posts: FavPost[] = [
      makePost({
        key: 'kemono/patreon/1/10',
        postId: '10',
        title: 'Sunset Sketch',
        creatorName: 'Alice Art',
        note: 'Great lighting',
        rating: 5,
        tags: ['landscape', 'color'],
      }),
      makePost({
        key: 'kemono/patreon/2/20',
        postId: '20',
        title: 'Mecha Concept',
        creatorName: 'Bob Studio',
        note: 'Hard surface',
        rating: 3,
        tags: ['sci-fi'],
      }),
      makePost({
        key: 'pawchive/fanbox/3/30',
        postId: '30',
        title: 'Portrait Study',
        creatorName: 'Carol',
        tags: ['landscape'],
      }),
    ]

    it('returns all items when query and filter are empty', () => {
      expect(filterFavPosts(posts, '')).toHaveLength(3)
      expect(filterFavPosts(posts, '   ', { tags: [] })).toHaveLength(3)
    })

    it('matches title, creatorName, note, and tags case-insensitively', () => {
      expect(filterFavPosts(posts, 'SUNSET').map((p) => p.postId)).toEqual([
        '10',
      ])
      expect(filterFavPosts(posts, 'studio').map((p) => p.postId)).toEqual([
        '20',
      ])
      expect(filterFavPosts(posts, 'lighting').map((p) => p.postId)).toEqual([
        '10',
      ])
      expect(filterFavPosts(posts, 'SCI-FI').map((p) => p.postId)).toEqual([
        '20',
      ])
      expect(filterFavPosts(posts, 'nonexistent')).toEqual([])
    })

    it('combines search query with label filter (tags AND + ratings)', () => {
      expect(
        filterFavPosts(posts, '', { tags: ['landscape'], ratings: [4, 5] }).map(
          (p) => p.postId
        )
      ).toEqual(['10'])
      expect(
        filterFavPosts(posts, 'alice', {
          tags: ['color'],
          ratings: [5],
        }).map((p) => p.postId)
      ).toEqual(['10'])
      expect(
        filterFavPosts(posts, 'bob', { tags: ['sci-fi'], ratings: [4, 5] })
      ).toEqual([])
    })
  })

  describe('sortFavPosts', () => {
    const p1 = makePost({
      key: 'kemono/patreon/1/1',
      postId: '1',
      title: 'Zebra',
      addedAt: 100,
      published: '2025-05-01T00:00:00',
      rating: 4,
    })
    const p2 = makePost({
      key: 'kemono/patreon/1/2',
      postId: '2',
      title: 'Alpha',
      addedAt: 300,
      published: '2026-01-10T00:00:00',
      rating: 5,
    })
    const p3 = makePost({
      key: 'kemono/patreon/1/3',
      postId: '3',
      title: 'Middle',
      addedAt: 200,
    })

    it('sorts by addedAt descending', () => {
      expect(sortFavPosts([p1, p3, p2], 'added').map((p) => p.postId)).toEqual([
        '2',
        '3',
        '1',
      ])
    })

    it('sorts by published descending with missing published last', () => {
      expect(
        sortFavPosts([p3, p1, p2], 'published').map((p) => p.postId)
      ).toEqual(['2', '1', '3'])
    })

    it('sorts by title ascending', () => {
      expect(sortFavPosts([p1, p2, p3], 'title').map((p) => p.postId)).toEqual([
        '2',
        '3',
        '1',
      ])
    })

    it('sorts by rating descending with unrated last', () => {
      expect(sortFavPosts([p3, p1, p2], 'rating').map((p) => p.postId)).toEqual(
        ['2', '1', '3']
      )
    })

    it('does not mutate the input array', () => {
      const input = [p1, p2, p3]
      sortFavPosts(input, 'title')
      expect(input.map((p) => p.postId)).toEqual(['1', '2', '3'])
    })
  })

  describe('filterFavImages', () => {
    const images: FavImage[] = [
      makeImage({
        key: 'kemono/aa/bb/1.jpg',
        path: '/aa/bb/1.jpg',
        postTitle: 'Beach Episode',
        creatorName: 'Alice',
        fileName: 'summer_01.png',
        note: 'Wallpaper crop',
        rating: 5,
        tags: ['summer', 'wallpaper'],
      }),
      makeImage({
        key: 'kemono/aa/bb/2.jpg',
        path: '/aa/bb/2.jpg',
        postTitle: 'Night City',
        creatorName: 'Bob',
        fileName: 'neon_rain.jpg',
        rating: 2,
        tags: ['cyberpunk'],
      }),
    ]

    it('matches postTitle, creatorName, fileName, note, and tags', () => {
      expect(filterFavImages(images, 'beach').map((i) => i.key)).toEqual([
        'kemono/aa/bb/1.jpg',
      ])
      expect(filterFavImages(images, 'bob').map((i) => i.key)).toEqual([
        'kemono/aa/bb/2.jpg',
      ])
      expect(filterFavImages(images, 'neon_rain').map((i) => i.key)).toEqual([
        'kemono/aa/bb/2.jpg',
      ])
      expect(filterFavImages(images, 'crop').map((i) => i.key)).toEqual([
        'kemono/aa/bb/1.jpg',
      ])
      expect(filterFavImages(images, 'CYBERPUNK').map((i) => i.key)).toEqual([
        'kemono/aa/bb/2.jpg',
      ])
    })

    it('applies label filter alongside search query', () => {
      expect(
        filterFavImages(images, 'summer', {
          tags: ['wallpaper'],
          ratings: [4, 5],
        }).map((i) => i.key)
      ).toEqual(['kemono/aa/bb/1.jpg'])
      expect(
        filterFavImages(images, '', { tags: ['cyberpunk'], ratings: [3, 4, 5] })
      ).toEqual([])
    })
  })

  describe('sortFavImages', () => {
    const i1 = makeImage({
      key: 'kemono/aa/01.jpg',
      path: '/aa/01.jpg',
      postTitle: 'Zeta',
      addedAt: 100,
      rating: 3,
    })
    const i2 = makeImage({
      key: 'kemono/aa/02.jpg',
      path: '/aa/02.jpg',
      fileName: 'alpha.png',
      addedAt: 300,
      rating: 5,
    })
    const i3 = makeImage({
      key: 'kemono/aa/03.jpg',
      path: '/aa/03.jpg',
      postTitle: 'Beta',
      addedAt: 200,
    })

    it('sorts by addedAt descending (and falls back for published)', () => {
      expect(sortFavImages([i1, i3, i2], 'added').map((i) => i.key)).toEqual([
        i2.key,
        i3.key,
        i1.key,
      ])
      expect(
        sortFavImages([i1, i3, i2], 'published').map((i) => i.key)
      ).toEqual([i2.key, i3.key, i1.key])
    })

    it('sorts by title falling back to fileName and path', () => {
      expect(sortFavImages([i1, i2, i3], 'title').map((i) => i.key)).toEqual([
        i2.key,
        i3.key,
        i1.key,
      ])
    })

    it('sorts by rating descending with unrated last', () => {
      expect(sortFavImages([i3, i1, i2], 'rating').map((i) => i.key)).toEqual([
        i2.key,
        i1.key,
        i3.key,
      ])
    })
  })
})
