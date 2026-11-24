import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  ApiHttpError,
  normalizePost,
  parseRetryAfter,
} from '../src/kemono/api'
import { sleepAbortable } from '../src/Tools'

// 限流佇列有 500ms 啟動間隔，測試改用直通版，避免大量請求逾時
vi.mock('../src/utils/queue', () => ({
  Queue: class {
    enqueue<T>(fn: (s?: AbortSignal) => Promise<T>, signal?: AbortSignal) {
      return fn(signal)
    }
  },
}))

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非 2xx 且 body 有 error：拋 ApiHttpError（保留 HTTP 狀態與訊息）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const err = await api
      .posts({ service: 'patreon', creatorId: 'http-error' })
      .catch((e) => e)

    expect(err).toBeInstanceOf(ApiHttpError)
    expect(err.status).toBe(500)
    expect(err.message).toContain('HTTP 500')
    expect(err.message).toContain('boom')
  })

  it('429 carries the Retry-After wait when the header is readable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: { get: (k: string) => (k === 'Retry-After' ? '7' : null) },
        json: async () => ({}),
      }))
    )
    const err = await api
      .posts({ service: 'patreon', creatorId: 'retry-after' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiHttpError)
    expect(err.retryAfterMs).toBe(7000)
  })

  it('parseRetryAfter reads seconds and dates, and rejects junk', () => {
    expect(parseRetryAfter('120')).toBe(120000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30000)
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0)
  })

  it('post with cache=false is not stored; the default is', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ post: { id: '1' }, attachments: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const info = {
      service: 'patreon',
      creatorId: 'nocache',
      postId: '1',
    } as const
    await api.post(info, undefined, { cache: false })
    await api.post(info, undefined, { cache: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await api.post(info)
    await api.post(info)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('posts index 非有限非負整數：直接拋錯且不發 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.posts({ service: 'patreon', creatorId: 'bad-offset', index: -1 })
    ).rejects.toThrow('invalid offset: -1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses explicit host when provided for profile, posts, and post', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ post: { id: '42' }, attachments: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await api.profile({
      service: 'patreon',
      creatorId: 'host-user',
      host: 'kemono.cr',
    })
    await api.posts({
      service: 'fanbox',
      creatorId: 'host-user',
      index: 50,
      host: 'pawchive.pw',
    })
    await api.post(
      { service: 'patreon', creatorId: 'host-user', postId: '42' },
      undefined,
      { host: 'kemono.su' }
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://kemono.cr/api/v1/patreon/user/host-user/profile',
      expect.any(Object)
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://pawchive.pw/api/v1/fanbox/user/host-user/posts?o=50',
      expect.any(Object)
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://kemono.su/api/v1/patreon/user/host-user/post/42',
      expect.any(Object)
    )
  })
})

describe('api 快取', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const okFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', nested: { n: 1 } }),
    }))

  it('過期後重新請求', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const params = { service: 'patreon', creatorId: 'ttl-user' } as const
    await api.posts(params)
    await api.posts(params)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    await api.posts(params)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('分級 TTL：posts 10 分過期，post 詳情仍在快取，profile 6 小時才過期', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const posts = { service: 'patreon', creatorId: 'tier-user' } as const
    const post = { ...posts, postId: '99' }
    await api.posts(posts)
    await api.post(post)
    await api.profile(posts)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // 11 分後：posts 過期，post／profile 還在
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    await api.post(post)
    await api.profile(posts)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await api.posts(posts)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // 再過 1 小時：post 詳情（60 分）過期，profile 未過期
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    await api.profile(posts)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await api.post(post)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    // 總計超過 6 小時：profile 過期
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000)
    await api.profile(posts)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('超過上限淘汰最舊項目', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 502; i++) {
      await api.posts({ service: 'patreon', creatorId: `cap-${i}` })
    }
    expect(fetchMock).toHaveBeenCalledTimes(502)
    // 最新的仍在快取
    await api.posts({ service: 'patreon', creatorId: 'cap-501' })
    expect(fetchMock).toHaveBeenCalledTimes(502)
    // 最舊的已被淘汰，需重新請求
    await api.posts({ service: 'patreon', creatorId: 'cap-0' })
    expect(fetchMock).toHaveBeenCalledTimes(503)
  })

  it('修改回傳物件不影響下次結果', async () => {
    vi.stubGlobal('fetch', okFetch())
    const params = { service: 'patreon', creatorId: 'clone-user' } as const
    const first: any = await api.posts(params)
    first.nested.n = 999
    first.extra = true
    const second: any = await api.posts(params)
    expect(second).toEqual({ id: 'x', nested: { n: 1 } })
  })

  it('同 URL 並發只 fetch 一次，且各自拿到獨立 clone', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const params = { service: 'patreon', creatorId: 'inflight-user' } as const
    const [a, b]: any[] = await Promise.all([
      api.posts(params),
      api.posts(params),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).not.toBe(b)
    a.nested.n = 5
    expect(b.nested.n).toBe(1)
  })
})

describe('normalizePost', () => {
  it('扁平回包轉 canonical，保留頂層附件', () => {
    const flat = {
      id: '1',
      user: 'u',
      service: 'patreon',
      attachments: [{ name: 'a.png', path: '/a/a.png' }],
    }
    const result = normalizePost(flat)
    expect(result).toMatchObject({
      post: flat,
      attachments: [{ name: 'a.png', path: '/a/a.png' }],
    })
  })

  it('canonical 回包直接回傳', () => {
    const canonical = { post: { id: '1' }, attachments: [] }
    expect(normalizePost(canonical)).toBe(canonical)
  })

  it('null／非物件回錯誤形狀，不崩潰', () => {
    expect(normalizePost(null)).toEqual({ error: 'invalid post response' })
    expect(normalizePost('bad')).toEqual({ error: 'invalid post response' })
    expect(normalizePost({ post: null })).toEqual({
      error: 'invalid post response',
    })
  })
})

describe('sleepAbortable', () => {
  it('abort 時回 false', async () => {
    const controller = new AbortController()
    const p = sleepAbortable(1000, controller.signal)
    controller.abort()
    await expect(p).resolves.toBe(false)
  })
})
