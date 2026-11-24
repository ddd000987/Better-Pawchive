/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */

import { describe, expect, it } from 'vitest'
import type { PostApiResponse } from '../src/kemono/apiTypes'
import { extractFileNameFromUrl, pickCoverPath } from '../src/watch/postMeta'

function makePostData(
  file: PostApiResponse['post']['file'],
  postAttachments: PostApiResponse['post']['attachments'] = [],
  topAttachments: PostApiResponse['attachments'] = []
): PostApiResponse {
  return {
    post: {
      id: '100',
      user: '42',
      service: 'patreon',
      title: 'Sample post',
      content: '',
      embed: {},
      shared_file: false,
      added: '2026-01-01T00:00:00',
      published: '2026-01-01T00:00:00',
      edited: '',
      file,
      attachments: postAttachments,
    },
    attachments: topAttachments,
  }
}

describe('pickCoverPath', () => {
  it('picks post.file.path when it is an image', () => {
    const data = makePostData(
      { name: 'cover.png', path: '/aa/bb/aabbccdd.png' },
      [{ name: 'second.jpg', path: '/11/22/11223344.jpg' }]
    )
    expect(pickCoverPath(data)).toBe('/aa/bb/aabbccdd.png')
  })

  it('falls back to the first image attachment when post.file is non-image', () => {
    const data = makePostData(
      { name: 'archive.zip', path: '/aa/bb/aabbccdd.zip' },
      [
        { name: 'clip.mp4', path: '/11/22/11223344.mp4' },
        { name: 'page1.webp', path: '/33/44/33445566.webp' },
      ]
    )
    expect(pickCoverPath(data)).toBe('/33/44/33445566.webp')
  })

  it('falls back to top-level attachments when post.file is empty', () => {
    const data = makePostData(
      {},
      [],
      [{ name: 'art.jpeg', path: '/5a/48/5a48deadbeef.jpeg' }]
    )
    expect(pickCoverPath(data)).toBe('/5a/48/5a48deadbeef.jpeg')
  })

  it('returns undefined when there are no image files', () => {
    const data = makePostData(
      { name: 'notes.txt', path: '/aa/bb/aabbccdd.txt' },
      [{ name: 'video.mp4', path: '/11/22/11223344.mp4' }]
    )
    expect(pickCoverPath(data)).toBeUndefined()
  })

  it('ignores invalid paths that do not start with a slash', () => {
    const data = makePostData({ name: 'bad.png', path: 'relative/path.png' })
    expect(pickCoverPath(data)).toBeUndefined()
  })
})

describe('extractFileNameFromUrl', () => {
  it('extracts the f query parameter from a full data URL', () => {
    expect(
      extractFileNameFromUrl(
        'https://n4.pawchive.pw/data/25a/48/5a48deadbeef.jpeg?f=cover.jpeg'
      )
    ).toBe('cover.jpeg')
  })

  it('decodes percent-encoded file names', () => {
    expect(
      extractFileNameFromUrl(
        'https://n1.kemono.cr/data/aa/bb/aabb.png?f=my%20art%20%231.png'
      )
    ).toBe('my art #1.png')
  })

  it('supports relative URLs', () => {
    expect(extractFileNameFromUrl('/data/aa/bb/aabb.png?f=01.png')).toBe(
      '01.png'
    )
  })

  it('returns undefined when f is missing, empty, or URL is empty', () => {
    expect(
      extractFileNameFromUrl('https://n4.pawchive.pw/data/aa/bb/aabb.png')
    ).toBeUndefined()
    expect(
      extractFileNameFromUrl('https://n4.pawchive.pw/data/aa/bb/aabb.png?f=  ')
    ).toBeUndefined()
    expect(extractFileNameFromUrl('')).toBeUndefined()
  })
})
