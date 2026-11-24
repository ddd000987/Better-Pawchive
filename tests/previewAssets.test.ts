import { describe, expect, it } from 'vitest'
import {
  allFiles,
  coverUrl,
  downloadUrl,
  hasOriginalFiles,
  imageFiles,
  imageUrl,
  isKemonoHost,
  isRetiredKemonoHost,
  parsePostKey,
  parsePostKeyFromHref,
  resolveDownloadUrl,
} from '../src/preview/previewAssets'
import type { PostApiResponse } from '../src/kemono/apiTypes'

const K_HOST = 'kemono.cr'
const P_HOST = 'pawchive.pw'

function fixture(): PostApiResponse {
  return {
    post: {
      id: '999',
      user: 'u1',
      service: 'patreon',
      title: 't',
      content: '',
      embed: {},
      shared_file: false,
      added: '',
      published: '2024-01-02T03:04:05',
      edited: '',
      file: { name: 'cover.jpg', path: '/a/cover.jpg' },
      attachments: [{ name: 'a.png', path: '/a/a.png' }],
    },
    attachments: [
      { name: 'a.png', path: '/a/a.png' },
      { name: 'b.zip', path: '/b/b.zip' },
    ],
  }
}

describe('parsePostKeyFromHref', () => {
  it('parses absolute + relative hrefs', () => {
    expect(
      parsePostKeyFromHref('https://kemono.su/patreon/user/1/post/2')
    ).toBe('patreon/1/2')
    expect(parsePostKeyFromHref('/fanbox/user/x/post/y')).toBe('fanbox/x/y')
    expect(parsePostKeyFromHref('/discord/user/a/post/b')).toBe('discord/a/b')
  })
  it('rejects non-post links', () => {
    expect(parsePostKeyFromHref('/patreon/user/1')).toBeNull()
    expect(parsePostKeyFromHref('https://kemono.su/')).toBeNull()
    expect(parsePostKeyFromHref('::::')).toBeNull()
  })
})

describe('parsePostKey', () => {
  it('splits service/creatorId/postId', () => {
    expect(parsePostKey('patreon/1/2')).toEqual({
      service: 'patreon',
      creatorId: '1',
      postId: '2',
    })
    expect(parsePostKey('bad')).toBeNull()
  })
  it('服務名不在白名單時回 null', () => {
    expect(parsePostKey('evil/1/2')).toBeNull()
  })
})

describe('isKemonoHost / coverUrl', () => {
  it('distinguishes families', () => {
    expect(isKemonoHost('kemono.su')).toBe(true)
    expect(isKemonoHost('www.kemono.cr')).toBe(true)
    expect(isKemonoHost('pawchive.pw')).toBe(false)
  })
  it('域名精確匹配，不誤判相似網域', () => {
    expect(isKemonoHost('kemono.su.evil.com')).toBe(false)
    expect(isKemonoHost('fakekemono.com')).toBe(false)
  })
  it('builds thumbnail or empty', () => {
    expect(coverUrl({ path: '/a/b.jpg' }, K_HOST)).toBe(
      'https://img.kemono.cr/thumbnail/data/a/b.jpg'
    )
    expect(coverUrl(undefined, K_HOST)).toBe('')
    expect(coverUrl({}, K_HOST)).toBe('')
  })
})

describe('file merging', () => {
  it('allFiles dedupes post.file + both attachment lists', () => {
    expect(allFiles(fixture()).map((f) => f.path)).toEqual([
      '/a/cover.jpg',
      '/a/a.png',
      '/b/b.zip',
    ])
  })
  it('imageFiles keeps images only', () => {
    expect(imageFiles(fixture()).map((f) => f.path)).toEqual([
      '/a/cover.jpg',
      '/a/a.png',
    ])
  })
})

describe('kemono URL rules', () => {
  const img = { name: 'a.png', path: '/a/a.png' }
  const zip = { name: 'b.zip', path: '/b/b.zip' }
  // The original-file servers n1–n4.kemono.cr are gone: thumbnails only
  it('images are thumbnails, whatever the original switch says', () => {
    for (const original of [true, false]) {
      expect(imageUrl(img, original, K_HOST)).toBe(
        'https://img.kemono.cr/thumbnail/data/a/a.png'
      )
      expect(downloadUrl(img, original, K_HOST)).toBe(
        'https://img.kemono.cr/thumbnail/data/a/a.png'
      )
    }
  })
  it('other files have no URL', () => {
    expect(imageUrl(zip, true, K_HOST)).toBe('')
    expect(downloadUrl(zip, true, K_HOST)).toBe('')
  })
})

describe('hasOriginalFiles / isRetiredKemonoHost', () => {
  it('only Pawchive still serves original files', () => {
    expect(hasOriginalFiles('pawchive.pw')).toBe(true)
    expect(hasOriginalFiles('www.pawchive.pw')).toBe(true)
    expect(hasOriginalFiles('kemono.cr')).toBe(false)
    expect(hasOriginalFiles('kemono.su')).toBe(false)
  })
  it('names the Kemono domains that no longer resolve', () => {
    expect(isRetiredKemonoHost('kemono.su')).toBe(true)
    expect(isRetiredKemonoHost('www.kemono.party')).toBe(true)
    expect(isRetiredKemonoHost('kemono.cr')).toBe(false)
    expect(isRetiredKemonoHost('kemono.su.evil.com')).toBe(false)
  })
})

describe('pawchive URL rules', () => {
  const img = { name: 'a.png', path: '/a/a.png' }
  const zip = { name: 'b.zip', path: '/b/b.zip' }
  it('image follows the original switch', () => {
    expect(imageUrl(img, true, P_HOST)).toBe(
      'https://file.pawchive.pw/data/a/a.png'
    )
    expect(imageUrl(img, false, P_HOST)).toBe(
      'https://img.pawchive.pw/thumbnail/data/a/a.png'
    )
  })
  it('preview_only ignores the switch; non-image uses file.', () => {
    const locked = { name: 'x.jpg', path: '/x/x.jpg', preview_only: true }
    expect(imageUrl(locked, true, P_HOST)).toBe(
      'https://img.pawchive.pw/thumbnail/data/x/x.jpg'
    )
    expect(downloadUrl(zip, false, P_HOST)).toBe(
      'https://file.pawchive.pw/data/b/b.zip'
    )
  })
})

describe('resolveDownloadUrl', () => {
  const kThumb = 'https://img.kemono.cr/thumbnail/data/a/a.png'
  const pThumb = 'https://img.pawchive.pw/thumbnail/data/a/a.png'
  it('kemono 縮圖網址不換（原檔伺服器已停用）', () => {
    expect(
      resolveDownloadUrl({ fileUrl: kThumb, previewOnly: false }, true)
    ).toBe(kThumb)
  })
  it('pawchive 縮圖網址換回 file. 原圖', () => {
    expect(
      resolveDownloadUrl({ fileUrl: pThumb, previewOnly: false }, true)
    ).toBe('https://file.pawchive.pw/data/a/a.png')
  })
  it('站點取自網址本身：不受目前分頁的站點影響', () => {
    // 測試環境的 location.host 是 pawchive.pw：Kemono 的縮圖照樣不換
    const k = 'https://img.kemono.cr/thumbnail/data/c/c.jpg'
    const p = 'https://img.pawchive.pw/thumbnail/data/c/c.jpg'
    expect(resolveDownloadUrl({ fileUrl: k, previewOnly: false }, true)).toBe(k)
    expect(resolveDownloadUrl({ fileUrl: p, previewOnly: false }, true)).toBe(
      'https://file.pawchive.pw/data/c/c.jpg'
    )
  })
  it('previewOnly 不換', () => {
    expect(
      resolveDownloadUrl({ fileUrl: kThumb, previewOnly: true }, true)
    ).toBe(kThumb)
    expect(
      resolveDownloadUrl({ fileUrl: pThumb, previewOnly: true }, true)
    ).toBe(pThumb)
  })
  it('非縮圖網址原樣返回', () => {
    const u = 'https://n1.kemono.cr/data/b/b.zip'
    expect(resolveDownloadUrl({ fileUrl: u, previewOnly: false }, true)).toBe(u)
    expect(resolveDownloadUrl({ fileUrl: '', previewOnly: false }, true)).toBe(
      ''
    )
    // 縮圖前綴後面不是路徑：不換
    const odd = 'https://img.kemono.su/thumbnail/dataX'
    expect(resolveDownloadUrl({ fileUrl: odd, previewOnly: false }, true)).toBe(
      odd
    )
  })
  it('original=false 原樣返回', () => {
    expect(
      resolveDownloadUrl({ fileUrl: kThumb, previewOnly: false }, false)
    ).toBe(kThumb)
  })
})
