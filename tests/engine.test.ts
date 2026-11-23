import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { eventNames } from '../src/EVT'

// 只 mock api 方法，保留真正的 ApiHttpError 類別
vi.mock('../src/kemono/api', async () => {
  const actual =
    await vi.importActual<typeof import('../src/kemono/api')>(
      '../src/kemono/api'
    )
  return {
    ...actual,
    api: {
      profile: vi.fn(),
      posts: vi.fn(),
      post: vi.fn(),
    },
  }
})

// Toast 會建立 DOM 元素，測試環境沒有；換成可觀察的 mock
vi.mock('../src/Toast', () => ({
  toast: {
    show: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}))

// 固定為創作者頁
vi.mock('../src/kemono/pages', async () => {
  const actual = await vi.importActual<typeof import('../src/kemono/pages')>(
    '../src/kemono/pages'
  )
  return {
    ...actual,
    detectPage: () => ({
      kind: 'creator' as const,
      service: 'patreon' as const,
      creatorId: '1',
    }),
  }
})

// EVT 是模組內的私有匯流排單例；每次重新載入模組（含 EVT）重新註冊，
// 並在同一批 import 取得與受測模組相同的 EVT 實例
let evt: typeof import('../src/EVT').EVT
async function load() {
  vi.resetModules()
  evt = (await import('../src/EVT')).EVT
  const apiMod = await import('../src/kemono/api')
  const engineMod = await import('../src/crawl/engine')
  evt.fire('settingInitialized')
  return {
    api: apiMod.api,
    ApiHttpError: apiMod.ApiHttpError,
    engine: engineMod.engine,
  }
}

function countEvent(type: eventNames) {
  let count = 0
  evt.on(type, () => {
    count++
  })
  return () => count
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('engine 錯誤分級', () => {
  it('列表 500 重試一次後成功：api.posts 呼叫 2 次並發 crawlComplete', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockRejectedValueOnce(new ApiHttpError(500, 'u', 'HTTP 500: boom'))
      .mockResolvedValueOnce([])
    const complete = countEvent('crawlComplete')

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(api.posts).toHaveBeenCalledTimes(2)
    expect(complete()).toBe(1)
  })

  it('列表 404 直接失敗：api.posts 只呼叫 1 次', async () => {
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockRejectedValueOnce(
      new ApiHttpError(404, 'u', 'HTTP 404: not found')
    )

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(1)
  })
})

describe('engine 可中斷', () => {
  it('429 退避中 stopCrawl：不必等 60 秒，start() 直接完成', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockRejectedValueOnce(
      new ApiHttpError(429, 'u', 'HTTP 429')
    )

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(0)
    evt.fire('stopCrawl')
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(api.posts).toHaveBeenCalledTimes(1)
  })

  it('雙引擎：舊輪被取代後不再呼叫 api.posts，也不重複發 crawlComplete', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockRejectedValueOnce(new ApiHttpError(429, 'u', 'HTTP 429'))
      .mockResolvedValueOnce([])
    const complete = countEvent('crawlComplete')

    const first = engine.start()
    await vi.advanceTimersByTimeAsync(0)
    evt.fire('stopCrawl')
    const second = engine.start()
    await vi.advanceTimersByTimeAsync(0)
    await first
    await second

    // 第一次請求（舊輪）＋第二次請求（新輪），舊輪醒來後不再打 API
    expect(api.posts).toHaveBeenCalledTimes(2)
    // 串行化後舊輪先正常收尾（中止也要發 crawlComplete 以釋放 busy），新輪再收尾
    expect(complete()).toBe(2)
  })
})

describe('engine 錯誤分級：無 HTTP 狀態', () => {
  it('錯誤回應物件（語意錯誤）不重試：api.posts 只呼叫 1 次', async () => {
    const { api, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValue({ error: 'Not found' })

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(1)
  })

  it('fetch 網路失敗（TypeError）仍會重試', async () => {
    vi.useFakeTimers()
    const { api, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce([])

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(api.posts).toHaveBeenCalledTimes(2)
  })
})

describe('engine 串行化', () => {
  it('上一輪收尾期間兩個 start() 同時進場：每個實際執行的輪次只收尾一次', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockRejectedValueOnce(new ApiHttpError(429, 'u', 'HTTP 429'))
      .mockResolvedValue([])
    const complete = countEvent('crawlComplete')
    const started = countEvent('crawlStart')

    const first = engine.start()
    await vi.advanceTimersByTimeAsync(0)
    evt.fire('stopCrawl')
    // 第一輪還在收尾時，兩個入口同時進場
    const b = engine.start()
    const c = engine.start()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, b, c])

    // 每個實際開跑的輪次恰好收尾一次，且 busy 不會卡住
    expect(started()).toBeGreaterThanOrEqual(2)
    expect(complete()).toBe(started())
    const { states } = await import('../src/store/States')
    expect(states.busy).toBe(false)
  })
})

describe('engine 翻頁迴圈偵測', () => {
  // has_full=false 的帖子會被快篩（預設跳過 pending）擋掉，不打詳情，測試很快
  const page = (from: number, n = 50) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(from + i),
      user: '1',
      service: 'patreon',
      title: 't',
      published: '2024-01-01T00:00:00',
      attachments: [],
      file: {},
      has_full: false,
    }))

  it('API 忽略 o= 一直回同一頁：第二頁判定重複並停止，不翻到上限', async () => {
    const { api, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValue(page(0))
    const complete = countEvent('crawlComplete')

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(2)
    expect(complete()).toBe(1)
  })

  it('超過 400 頁的不同帖子：完整翻完，不被舊的 400 頁上限截斷', async () => {
    const { api, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    const total = 450
    ;(api.posts as any).mockImplementation(async (q: { index: number }) => {
      const pageNo = q.index / 50
      if (pageNo >= total) return []
      return page(q.index)
    })

    await engine.start()

    // 450 頁滿頁 + 1 次空頁收尾
    expect(api.posts).toHaveBeenCalledTimes(total + 1)
  })
})

describe('engine 暫停／繼續', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const pendingItem = (id: string) => ({
    id,
    user: '1',
    service: 'patreon',
    title: 't',
    published: '2024-01-01T00:00:00',
    attachments: [],
    file: {},
    has_full: false,
  })
  const fullPage = (from: number) =>
    Array.from({ length: 50 }, (_, i) => pendingItem(String(from + i)))

  it('暫停後，下一個翻頁請求等到繼續才發出', async () => {
    const { api, engine } = await load()
    const { crawlPause } = await import('../src/crawl/CrawlPause')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockImplementationOnce(async () => {
        // 第一頁請求「進行中」時按下暫停：這個請求照常完成
        expect(crawlPause.pause()).toBe(true)
        return fullPage(0)
      })
      .mockResolvedValueOnce([])
    const complete = countEvent('crawlComplete')
    const { states } = await import('../src/store/States')

    const p = engine.start()
    await flush()
    await flush()

    expect(api.posts).toHaveBeenCalledTimes(1)
    expect(complete()).toBe(0)
    expect(states.busy).toBe(true) // 暫停仍算抓取中

    crawlPause.resume()
    await p

    expect(api.posts).toHaveBeenCalledTimes(2)
    expect(complete()).toBe(1)
    expect(states.crawlPaused).toBe(false)
  })

  it('暫停後，下一個詳情請求等到繼續才發出', async () => {
    const { api, engine } = await load()
    const { crawlPause } = await import('../src/crawl/CrawlPause')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockImplementationOnce(async () => {
      crawlPause.pause()
      return [{ ...pendingItem('9'), has_full: true }]
    })
    ;(api.post as any).mockResolvedValue({ error: 'nope' })

    const p = engine.start()
    await flush()
    await flush()
    expect(api.post).not.toHaveBeenCalled()

    crawlPause.resume()
    await p
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it('開始時就暫停：連創作者資料請求都不發', async () => {
    const { api, engine } = await load()
    const { crawlPause } = await import('../src/crawl/CrawlPause')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValue([])
    // crawlStart 之後立刻暫停（監聽在引擎之後註冊，仍早於第一個 await 之後的請求）
    evt.on('crawlStart', () => {
      crawlPause.pause()
    })

    const p = engine.start()
    await flush()
    await flush()
    expect(api.profile).not.toHaveBeenCalled()
    expect(api.posts).not.toHaveBeenCalled()

    crawlPause.resume()
    await p
    expect(api.profile).toHaveBeenCalledTimes(1)
    expect(api.posts).toHaveBeenCalledTimes(1)
  })

  it('暫停中停止抓取：不再發請求，start() 收尾並釋放 busy', async () => {
    const { api, engine } = await load()
    const { crawlPause } = await import('../src/crawl/CrawlPause')
    const { states } = await import('../src/store/States')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockImplementationOnce(async () => {
      crawlPause.pause()
      return fullPage(0)
    })
    const complete = countEvent('crawlComplete')

    const p = engine.start()
    await flush()
    await flush()
    expect(api.posts).toHaveBeenCalledTimes(1)

    evt.fire('stopCrawl')
    await p

    expect(api.posts).toHaveBeenCalledTimes(1)
    expect(complete()).toBe(1)
    expect(states.busy).toBe(false)
    expect(states.crawlPaused).toBe(false)
    expect(crawlPause.paused).toBe(false)
  })
})

describe('engine 抓取進度與空結果說明', () => {
  // has_full=false 的帖子被快篩（預設跳過 pending）擋掉，不打詳情
  const pendingItem = (id: string, title = 't') => ({
    id,
    user: '1',
    service: 'patreon',
    title,
    published: '2024-01-01T00:00:00',
    attachments: [],
    file: {},
    has_full: false,
  })
  const fullPost = (id: string, files: number) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: {},
      attachments: Array.from({ length: files }, (_, i) => ({
        path: `/a/${i}.jpg`,
        name: `${i}.jpg`,
      })),
    },
    attachments: [],
    previews: [],
    videos: [],
  })

  it('全部被篩選排除：空結果訊息列出檢查數與各原因，並以警告 toast 提示', async () => {
    const { api, engine } = await load()
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    const { toast } = await import('../src/Toast')
    const toastWarning = toast.warning as ReturnType<typeof vi.fn>
    const { settings } = await import('../src/setting/Settings')
    settings.set('filterTitle', 'zzz')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator', post_count: 7 })
    ;(api.posts as any).mockResolvedValueOnce([
      pendingItem('1'),
      pendingItem('2'),
      pendingItem('3'),
    ])
    const empty = countEvent('crawlEmpty')

    await engine.start()

    expect(empty()).toBe(1)
    expect(crawlProgress.phase).toBe('empty')
    expect(crawlProgress.target).toBe('Creator (patreon/1)')
    expect(crawlProgress.total).toBe(7)
    expect(crawlProgress.pages).toBe(1)
    expect(crawlProgress.scanned).toBe(3)
    expect(crawlProgress.kept).toBe(0)
    expect(crawlProgress.excluded).toEqual({ title: 3 })
    expect(crawlProgress.failed).toBe(0)
    expect(api.post).not.toHaveBeenCalled()
    // 測試 stub 的介面語言為 en
    expect(toastWarning).toHaveBeenCalledTimes(1)
    expect(toastWarning).toHaveBeenCalledWith(
      'Crawl result is empty: 3 posts were checked and all were excluded by the filters (title 3). Adjust the filters on the Crawl page'
    )
    settings.set('filterTitle', '')
  })

  it('沒找到任何帖子：空結果訊息為「沒有找到任何帖子」', async () => {
    const { api, engine } = await load()
    const { toast } = await import('../src/Toast')
    const toastWarning = toast.warning as ReturnType<typeof vi.fn>
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([])

    await engine.start()

    expect(toastWarning).toHaveBeenCalledWith(
      'Crawl result is empty: no posts were found'
    )
  })

  it('詳情取得失敗：計入 failed，空結果訊息提到失敗', async () => {
    const { api, engine } = await load()
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    const { toast } = await import('../src/Toast')
    const toastWarning = toast.warning as ReturnType<typeof vi.fn>
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([
      { ...pendingItem('9'), has_full: true },
    ])
    ;(api.post as any).mockResolvedValue({ error: 'nope' })

    await engine.start()

    expect(crawlProgress.scanned).toBe(1)
    expect(crawlProgress.failed).toBe(1)
    // Pawchive 沒有 post_count：總數維持未知
    expect(crawlProgress.total).toBeNull()
    expect(toastWarning).toHaveBeenCalledWith(
      'Crawl result is empty: 1 posts were checked and all failed to load. Check the log and try again later'
    )
  })

  it('有結果：統計加入的帖子與檔案數，階段為完成', async () => {
    const { api, engine } = await load()
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([
      { ...pendingItem('5'), has_full: true },
    ])
    ;(api.post as any).mockResolvedValue(fullPost('5', 2))

    await engine.start()

    expect(crawlProgress.phase).toBe('done')
    expect(crawlProgress.scanned).toBe(1)
    expect(crawlProgress.kept).toBe(1)
    expect(crawlProgress.keptFiles).toBeGreaterThanOrEqual(2)
    expect(crawlProgress.excludedTotal).toBe(0)
  })

  it('重抓已下載過的創作者：不再因下載記錄而被排除', async () => {
    const { api, engine } = await load()
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    const { settings } = await import('../src/setting/Settings')
    settings.set('skipDownloaded', 'record')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([
      { ...pendingItem('5'), has_full: true },
    ])
    ;(api.post as any).mockResolvedValue(fullPost('5', 1))

    await engine.start()

    expect(crawlProgress.kept).toBe(1)
    expect(crawlProgress.excluded.duplicate).toBeUndefined()
  })
})

describe('engine list-page failure ends the crawl as incomplete', () => {
  const listItem = (id: string) => ({
    id,
    user: '1',
    service: 'patreon',
    title: 't',
    published: '2024-01-01T00:00:00',
    attachments: [],
    file: {},
    has_full: true,
  })
  const fullListPage = (from: number) =>
    Array.from({ length: 50 }, (_, i) => listItem(String(from + i)))
  const detailOf = (id: string) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: {},
      attachments: [{ path: `/a/${id}.jpg`, name: `${id}.jpg` }],
    },
    attachments: [],
    previews: [],
    videos: [],
  })
  const logMessages = async (level: string) => {
    const { log } = await import('../src/Log')
    return log
      .entries()
      .filter((e) => e.level === level)
      .map((e) => e.msg)
  }

  it('page 2 fails with 403: finishes as incomplete, not as a success', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockResolvedValueOnce(fullListPage(0))
      .mockRejectedValueOnce(new ApiHttpError(403, 'u', 'HTTP 403: nope'))
    ;(api.post as any).mockImplementation(async (q: { postId: string }) =>
      detailOf(q.postId)
    )
    const complete = countEvent('crawlComplete')
    const empty = countEvent('crawlEmpty')

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(2)
    expect(complete()).toBe(1)
    expect(empty()).toBe(0)
    expect(store.resultMeta.length).toBe(50)
    const expected = `Crawl ended early: the post list failed on page 2. Kept 50 posts / ${store.result.length} files; later pages were not crawled`
    expect(await logMessages('warning')).toContain(expected)
    expect(await logMessages('success')).not.toContainEqual(
      expect.stringContaining('Crawl complete')
    )
    expect(toast.warning).toHaveBeenCalledWith(expected)
  })

  it('page 1 fails with 403: reports the list failure instead of "no posts found"', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockRejectedValueOnce(
      new ApiHttpError(403, 'u', 'HTTP 403: nope')
    )
    const complete = countEvent('crawlComplete')
    const empty = countEvent('crawlEmpty')

    await engine.start()

    const expected =
      'Crawl failed: the post list could not be loaded (page 1). See the log for the error'
    expect(complete()).toBe(1)
    expect(empty()).toBe(1)
    expect(toast.warning).toHaveBeenCalledWith(expected)
    expect(toast.warning).not.toHaveBeenCalledWith(
      'Crawl result is empty: no posts were found'
    )
    expect(await logMessages('warning')).toContain(expected)
  })

  it('a SyntaxError (non-JSON body) is retried and the crawl finishes normally', async () => {
    vi.useFakeTimers()
    const { api, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any)
      .mockRejectedValueOnce(new SyntaxError('Unexpected token < in JSON'))
      .mockResolvedValueOnce([listItem('1')])
    ;(api.post as any).mockImplementation(async (q: { postId: string }) =>
      detailOf(q.postId)
    )
    const complete = countEvent('crawlComplete')

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(api.posts).toHaveBeenCalledTimes(2)
    expect(complete()).toBe(1)
    expect(await logMessages('success')).toContain(
      `Crawl complete: 1 posts / ${store.result.length} files`
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('a SyntaxError that keeps failing ends the crawl as a list failure after the retry budget', async () => {
    vi.useFakeTimers()
    const { api, engine } = await load()
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockRejectedValue(new SyntaxError('bad json'))

    const p = engine.start()
    // 5s + 10s + 15s of backoff for RETRY_TRANSIENT_MAX = 3
    await vi.advanceTimersByTimeAsync(30000)
    await p

    expect(api.posts).toHaveBeenCalledTimes(4)
    expect(toast.warning).toHaveBeenCalledWith(
      'Crawl failed: the post list could not be loaded (page 1). See the log for the error'
    )
  })

  it('does not leak the incomplete flag into the next run', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockImplementation(async (q: { postId: string }) =>
      detailOf(q.postId)
    )
    ;(api.posts as any)
      .mockResolvedValueOnce(fullListPage(0))
      .mockRejectedValueOnce(new ApiHttpError(403, 'u', 'HTTP 403: nope'))
      .mockResolvedValueOnce([listItem('900')])

    await engine.start()
    const warningsAfterFirst = (toast.warning as ReturnType<typeof vi.fn>).mock
      .calls.length
    expect(warningsAfterFirst).toBe(1)

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(3)
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(await logMessages('success')).toContain(
      `Crawl complete: ${store.resultMeta.length} posts / ${store.result.length} files`
    )
  })
})

describe('engine crawlIds picked (manual pick)', () => {
  const fullPost = (id: string) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: {},
      attachments: [{ path: `/a/${id}.jpg`, name: `${id}.jpg` }],
    },
    attachments: [],
    previews: [],
    videos: [],
  })

  it('a manual pick is crawled as a full crawl, so the cache saves it', async () => {
    const { api, engine } = await load()
    const { states } = await import('../src/store/States')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockResolvedValue(fullPost('5'))
    let quickAtStart: boolean | null = null
    evt.on('crawlStart', () => {
      quickAtStart = states.quickCrawl
    })

    await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }], {
      picked: true,
    })

    expect(quickAtStart).toBe(false)
    expect(states.quickCrawl).toBe(false)
  })

  it('a manual pick ignores the filter settings and marks its files', async () => {
    const { api, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { settings } = await import('../src/setting/Settings')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockResolvedValue(fullPost('5'))
    settings.set('filterTitle', 'zzz')
    settings.set('downImageFiles', false)
    settings.set('filterServices', 'fanbox')
    try {
      await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }], {
        picked: true,
      })
      expect(store.resultMeta).toHaveLength(1)
      expect(store.result.length).toBeGreaterThan(0)
      expect(store.result.every((r) => r.picked === true)).toBe(true)

      // The same post from the thumbnail button is still filtered
      store.reset()
      await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }])
      expect(store.resultMeta).toHaveLength(0)
    } finally {
      settings.set('filterTitle', '')
      settings.set('downImageFiles', true)
      settings.set('filterServices', '')
    }
  })

  it('without picked it stays a quick crawl', async () => {
    const { api, engine } = await load()
    const { states } = await import('../src/store/States')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockResolvedValue(fullPost('5'))

    await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }])

    expect(states.quickCrawl).toBe(true)
  })

  it('while busy a manual pick is not queued (the queue would replay it as quick)', async () => {
    const { engine } = await load()
    const { states } = await import('../src/store/States')
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    states.busy = true
    try {
      await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }], {
        picked: true,
      })
      expect(store.waitingIdList).toEqual([])
      expect(toast.warning).toHaveBeenCalled()

      // The thumbnail button path still queues
      await engine.crawlIds([{ id: 'patreon/1/6', type: 'post' }])
      expect(store.waitingIdList).toEqual([{ id: 'patreon/1/6', type: 'post' }])
    } finally {
      states.busy = false
    }
  })

  it('returns the ids that were added, not the ones that failed', async () => {
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockImplementation(async (q: { postId: string }) => {
      if (q.postId === '6') throw new ApiHttpError(404, 'u', 'HTTP 404')
      return fullPost(q.postId)
    })

    const added = await engine.crawlIds(
      [
        { id: 'patreon/1/5', type: 'post' },
        { id: 'patreon/1/6', type: 'post' },
        { id: 'patreon/1/7', type: 'post' },
      ],
      { picked: true }
    )

    expect(added).toEqual(['patreon/1/5', 'patreon/1/7'])
  })

  it('returns nothing when the crawl did not run', async () => {
    const { engine } = await load()
    const { states } = await import('../src/store/States')
    states.busy = true
    try {
      expect(
        await engine.crawlIds([{ id: 'patreon/1/5', type: 'post' }], {
          picked: true,
        })
      ).toEqual([])
    } finally {
      states.busy = false
    }
  })
})

describe('engine list quick screen matches the full filter', () => {
  const detail = (
    id: string,
    attachments: { path: string; name: string }[]
  ) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: attachments[0],
      attachments,
    },
    attachments: [],
    previews: [],
    videos: [],
  })
  const item = (id: string, attachments: { path: string; name: string }[]) => ({
    id,
    user: '1',
    service: 'patreon',
    title: 't',
    published: '2024-01-01T00:00:00',
    attachments,
    file: attachments[0],
    has_full: true,
  })

  it('a cover that repeats an attachment is one file, so filterMaxFiles=1 keeps the post', async () => {
    const { api, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { settings } = await import('../src/setting/Settings')
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    const files = [{ path: '/a/1.jpg', name: '1.jpg' }]
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([item('5', files)])
    ;(api.post as any).mockResolvedValue(detail('5', files))
    settings.set('filterMaxFiles', 1)
    try {
      await engine.start()
    } finally {
      settings.set('filterMaxFiles', 0)
    }

    expect(api.post).toHaveBeenCalledTimes(1)
    expect(crawlProgress.excluded.fileCount).toBeUndefined()
    expect(store.resultMeta).toHaveLength(1)
    expect(store.resultMeta[0].fileCount).toBe(1)
  })

  it('both stages exclude the same post when it really has too many files', async () => {
    const { api, engine } = await load()
    const { crawlProgress } = await import('../src/crawl/CrawlProgress')
    const { settings } = await import('../src/setting/Settings')
    const files = [
      { path: '/a/1.jpg', name: '1.jpg' },
      { path: '/a/2.jpg', name: '2.jpg' },
    ]
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([item('5', files)])
    settings.set('filterMaxFiles', 1)
    try {
      await engine.start()
    } finally {
      settings.set('filterMaxFiles', 0)
    }

    // Excluded from the list alone, without a detail request
    expect(api.post).not.toHaveBeenCalled()
    expect(crawlProgress.excluded).toEqual({ fileCount: 1 })
  })

  it('detail requests bypass the api cache', async () => {
    const { api, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([item('5', [])])
    ;(api.post as any).mockResolvedValue(detail('5', []))

    await engine.start()

    expect(api.post).toHaveBeenCalledWith(
      { service: 'patreon', creatorId: '1', postId: '5' },
      expect.anything(),
      { cache: false }
    )
  })
})

describe('engine creator profile failures', () => {
  const listItem = (id: string) => ({
    id,
    user: '1',
    service: 'patreon',
    title: 't',
    published: '2024-01-01T00:00:00',
    attachments: [],
    file: {},
    has_full: true,
  })
  const detailOf = (id: string) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: {},
      attachments: [{ path: `/a/${id}.jpg`, name: `${id}.jpg` }],
    },
    attachments: [],
    previews: [],
    videos: [],
  })
  const logMessages = async (level: string) => {
    const { log } = await import('../src/Log')
    return log
      .entries()
      .filter((e) => e.level === level)
      .map((e) => e.msg)
  }

  it('a transient profile failure is retried, so the creator name is kept', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    ;(api.profile as any)
      .mockRejectedValueOnce(new ApiHttpError(500, 'u', 'HTTP 500'))
      .mockResolvedValueOnce({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([listItem('5')])
    ;(api.post as any).mockResolvedValue(detailOf('5'))

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(5000)
    await p

    expect(api.profile).toHaveBeenCalledTimes(2)
    expect(store.resultMeta[0].creator).toBe('Creator')
  })

  it('a profile that stays unavailable falls back to the id and warns', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockRejectedValue(
      new ApiHttpError(404, 'u', 'HTTP 404')
    )
    ;(api.posts as any).mockResolvedValueOnce([listItem('5')])
    ;(api.post as any).mockResolvedValue(detailOf('5'))

    await engine.start()

    expect(store.resultMeta[0].creator).toBe('1')
    const msg =
      'Could not fetch the creator name (HTTP 404); the ID "1" is used as the folder name instead. Files may be saved to a different folder than earlier downloads'
    expect(toast.warning).toHaveBeenCalledWith(msg)
    expect(await logMessages('warning')).toContain(msg)
  })

  it('reuses the name from the previous results when the profile fails', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any)
      .mockResolvedValueOnce({ name: 'Alice' })
      .mockRejectedValueOnce(new ApiHttpError(404, 'u', 'HTTP 404'))
    ;(api.posts as any)
      .mockResolvedValueOnce([listItem('5')])
      .mockResolvedValueOnce([listItem('6')])
    ;(api.post as any).mockImplementation(async (q: { postId: string }) =>
      detailOf(q.postId)
    )

    await engine.start()
    expect(store.resultMeta[0].creator).toBe('Alice')
    await engine.start()

    expect(store.resultMeta).toHaveLength(1)
    expect(store.resultMeta[0].postId).toBe('6')
    expect(store.resultMeta[0].creator).toBe('Alice')
    expect(await logMessages('warning')).toContain(
      'Could not fetch the creator name (HTTP 404); reusing the earlier name: Alice'
    )
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('engine failed posts and rate limiting', () => {
  const listItem = (id: string) => ({
    id,
    user: '1',
    service: 'patreon',
    title: 't',
    published: '2024-01-01T00:00:00',
    attachments: [],
    file: {},
    has_full: true,
  })
  const detailOf = (id: string) => ({
    post: {
      id,
      user: '1',
      service: 'patreon',
      title: 'hello',
      content: '',
      published: '2024-01-01T00:00:00',
      file: {},
      attachments: [{ path: `/a/${id}.jpg`, name: `${id}.jpg` }],
    },
    attachments: [],
    previews: [],
    videos: [],
  })
  const logMessages = async (level: string) => {
    const { log } = await import('../src/Log')
    return log
      .entries()
      .filter((e) => e.level === level)
      .map((e) => e.msg)
  }

  it('posts dropped after retries make the run incomplete, not "Crawl complete"', async () => {
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([listItem('1'), listItem('2')])
    ;(api.post as any).mockImplementation(async (q: { postId: string }) => {
      if (q.postId === '2') throw new ApiHttpError(404, 'u', 'HTTP 404')
      return detailOf(q.postId)
    })
    const complete = countEvent('crawlComplete')
    const empty = countEvent('crawlEmpty')

    await engine.start()

    const expected = `Crawl finished with problems: 1 posts failed to load and were skipped. Kept 1 posts / ${store.result.length} files; the result is incomplete, so crawl again to pick up the failed ones`
    expect(complete()).toBe(1)
    expect(empty()).toBe(0)
    expect(store.resultMeta).toHaveLength(1)
    expect(await logMessages('warning')).toContain(expected)
    expect(toast.warning).toHaveBeenCalledWith(expected)
    expect(await logMessages('success')).not.toContainEqual(
      expect.stringContaining('Crawl complete')
    )
  })

  it('uses the Retry-After wait of a 429 instead of the default', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([listItem('1')])
    ;(api.post as any)
      .mockRejectedValueOnce(new ApiHttpError(429, 'u', 'HTTP 429', 5000))
      .mockResolvedValueOnce(detailOf('1'))

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(4000)
    expect(api.post).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    await p

    expect(api.post).toHaveBeenCalledTimes(2)
    expect(store.resultMeta).toHaveLength(1)
    expect(await logMessages('warning')).toContain(
      'Rate limited (429), retrying in 5s (1/2)'
    )
  })

  it('stops after several posts in a row gave up on 429 instead of dropping them all', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    const { states } = await import('../src/store/States')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => listItem(String(i + 1)))
    )
    ;(api.post as any).mockRejectedValue(new ApiHttpError(429, 'u', 'HTTP 429'))
    const complete = countEvent('crawlComplete')

    const p = engine.start()
    // 3 posts x (first try + 2 retries of 30s each)
    await vi.advanceTimersByTimeAsync(200000)
    await p

    // 3 attempts per post, 3 posts; the other 7 posts were never requested
    expect(api.post).toHaveBeenCalledTimes(9)
    expect(complete()).toBe(1)
    expect(states.busy).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith(
      'Crawl stopped: the site kept rate limiting requests (429). Kept 0 posts / 0 files; the remaining posts were not crawled. Try again later'
    )
  })

  it('a success between 429 give-ups resets the count', async () => {
    vi.useFakeTimers()
    const { api, ApiHttpError, engine } = await load()
    const { store } = await import('../src/store/Store')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce(
      ['1', '2', '3', '4', '5'].map(listItem)
    )
    ;(api.post as any).mockImplementation(async (q: { postId: string }) => {
      // posts 1, 2, 4 and 5 are rate limited for good; 3 works
      if (q.postId !== '3') throw new ApiHttpError(429, 'u', 'HTTP 429', 1000)
      return detailOf(q.postId)
    })

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(60000)
    await p

    expect(api.post).toHaveBeenCalledTimes(3 * 4 + 1)
    expect(store.resultMeta.map((m) => m.postId)).toEqual(['3'])
  })

  it('reports the failing API URL with the status', async () => {
    const { api, ApiHttpError, engine } = await load()
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValueOnce([listItem('1')])
    ;(api.post as any).mockRejectedValue(
      new ApiHttpError(404, 'https://x.test/api/v1/post/1', 'HTTP 404')
    )
    const seen: unknown[] = []
    evt.on('requestStatusError', (ev: CustomEventInit) => {
      seen.push(ev.detail.data)
    })

    await engine.start()

    expect(seen).toEqual([{ status: 404, url: 'https://x.test/api/v1/post/1' }])
  })

  it('a list body that is not an array is a list failure', async () => {
    const { api, engine } = await load()
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.posts as any).mockResolvedValue({})
    const complete = countEvent('crawlComplete')

    await engine.start()

    expect(api.posts).toHaveBeenCalledTimes(1)
    expect(complete()).toBe(1)
    expect(toast.warning).toHaveBeenCalledWith(
      'Crawl failed: the post list could not be loaded (page 1). See the log for the error'
    )
    expect(await logMessages('success')).not.toContainEqual(
      expect.stringContaining('Crawl complete')
    )
  })

  it('an unexpected error ends the run as incomplete, not as complete', async () => {
    const { api, engine } = await load()
    const { store } = await import('../src/store/Store')
    const { toast } = await import('../src/Toast')
    ;(api.profile as any).mockResolvedValue({ name: 'Creator' })
    ;(api.post as any).mockImplementation(async (q: { postId: string }) =>
      detailOf(q.postId)
    )
    ;(api.posts as any)
      .mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, i) => listItem(String(i + 1)))
      )
      // A null entry makes the page handling throw outside any request
      .mockResolvedValueOnce([null])

    await engine.start()

    expect(store.resultMeta).toHaveLength(50)
    expect(toast.warning).toHaveBeenCalledWith(
      expect.stringContaining('Crawl ended early because of an error: ')
    )
    expect(await logMessages('success')).not.toContainEqual(
      expect.stringContaining('Crawl complete')
    )
  })
})
