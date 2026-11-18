import { describe, expect, it } from 'vitest'
import type { PostsApiItem } from '../src/kemono/apiTypes'
import {
  creatorGridShape,
  creatorPostCountLabel,
  creatorPostCover,
  creatorPostPath,
  parseCreatorHref,
} from '../src/preview/creatorPreviewModel'

const item = (over: Partial<PostsApiItem>): PostsApiItem => ({
  attachments: [],
  file: {},
  id: '1',
  published: '',
  service: 'patreon',
  title: 't',
  user: '9',
  ...over,
})

describe('parseCreatorHref', () => {
  it('reads relative and absolute creator links', () => {
    expect(parseCreatorHref('/patreon/user/123')).toEqual({
      service: 'patreon',
      creatorId: '123',
    })
    expect(parseCreatorHref('https://kemono.cr/fanbox/user/45/')).toEqual({
      service: 'fanbox',
      creatorId: '45',
    })
  })

  it('ignores post links, other pages and unknown services', () => {
    expect(parseCreatorHref('/patreon/user/123/post/9')).toBeNull()
    expect(parseCreatorHref('/artists')).toBeNull()
    expect(parseCreatorHref('/notaservice/user/1')).toBeNull()
  })
})

describe('creatorPostCover', () => {
  const host = 'kemono.cr'

  it('uses the cover when it is an image', () => {
    expect(
      creatorPostCover(
        item({ file: { name: 'a.png', path: '/aa/a.png' } }),
        host
      )
    ).toBe('https://img.kemono.cr/thumbnail/data/aa/a.png')
  })

  it('falls back to the first image attachment', () => {
    const post = item({
      file: { name: 'v.mp4', path: '/vv/v.mp4' },
      attachments: [
        { name: 'r.zip', path: '/zz/r.zip' },
        { name: 'b.jpg', path: '/bb/b.jpg' },
      ] as PostsApiItem['attachments'],
    })
    expect(creatorPostCover(post, host)).toBe(
      'https://img.kemono.cr/thumbnail/data/bb/b.jpg'
    )
  })

  it('no image at all gives an empty string', () => {
    expect(creatorPostCover(item({}), host)).toBe('')
  })
})

describe('creatorGridShape', () => {
  it('small counts sit in one row', () => {
    expect(creatorGridShape(1)).toEqual({ cols: 1, rows: 1 })
    expect(creatorGridShape(6)).toEqual({ cols: 6, rows: 1 })
  })

  it('picks a column count that fits the count exactly', () => {
    expect(creatorGridShape(12)).toEqual({ cols: 6, rows: 2 })
    expect(creatorGridShape(20)).toEqual({ cols: 5, rows: 4 })
    expect(creatorGridShape(8)).toEqual({ cols: 4, rows: 2 })
    expect(creatorGridShape(50)).toEqual({ cols: 5, rows: 10 })
  })

  it('otherwise uses 6 columns and rounds rows up', () => {
    expect(creatorGridShape(7)).toEqual({ cols: 6, rows: 2 })
  })

  it('bad input falls back to one cover', () => {
    expect(creatorGridShape(0)).toEqual({ cols: 1, rows: 1 })
    expect(creatorGridShape(NaN)).toEqual({ cols: 1, rows: 1 })
  })
})

describe('creatorPostCountLabel', () => {
  it('marks a full page with a plus', () => {
    expect(creatorPostCountLabel(50)).toBe('50+')
    expect(creatorPostCountLabel(12)).toBe('12')
  })
})

describe('creatorPostPath', () => {
  it('builds the site path of a post', () => {
    expect(
      creatorPostPath({ service: 'patreon', creatorId: '12' }, '345')
    ).toBe('/patreon/user/12/post/345')
  })
})
