import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../src/download/CrawlCache'
import { EVT, type eventNames } from '../src/EVT'
import { toast } from '../src/Toast'
import { states } from '../src/store/States'
import { store } from '../src/store/Store'
import type { Result } from '../src/store/StoreType'

function fakeEl(): any {
  const el: any = {
    style: {},
    dataset: {},
    children: [] as any[],
    textContent: '',
    className: '',
    title: '',
    appendChild(c: any) {
      el.children.push(c)
      return c
    },
    append(...cs: any[]) {
      el.children.push(...cs)
      return el
    },
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    remove: () => {},
  }
  return el
}

function file(id: string, overrides: Partial<Result> = {}): Result {
  return {
    id,
    postKey: 'patreon/u1/999',
    service: 'patreon',
    creator: 'artist',
    creatorId: 'u1',
    postId: '999',
    title: 't',
    published: '2024-01-02T03:04:05',
    fileCount: 2,
    pending: false,
    fileUrl: 'https://x/1.png',
    fileName: '1.png',
    ext: 'png',
    kind: 'image',
    previewOnly: false,
    textData: '',
    fileIndex: 0,
    ...overrides,
  }
}

let mem: Record<string, any>
let crawlCache: typeof import('../src/download/CrawlCache').crawlCache
let MAX_ENTRIES: number
let mergeEntries: typeof import('../src/download/CrawlCache').mergeEntries
let downloadControl: typeof import('../src/download/DownloadControl').downloadControl

const keyList = (keys: string | string[]) =>
  typeof keys === 'string' ? [keys] : keys
/** chrome.storage.local over `mem`, copying values through `copy` */
function storageOver(copy: <T>(v: T) => T = (v) => v) {
  return {
    get: async (keys: string | string[]) => {
      const out: Record<string, any> = {}
      for (const k of keyList(keys)) {
        if (k in mem) out[k] = copy(mem[k])
      }
      return out
    },
    set: async (obj: Record<string, any>) => {
      Object.assign(mem, copy(obj))
    },
    remove: async (keys: string | string[]) => {
      for (const k of keyList(keys)) delete mem[k]
    },
  }
}

beforeAll(async () => {
  mem = {}
  ;(globalThis as any).chrome.storage.local = storageOver()
  ;(globalThis as any).chrome.runtime.onMessage = { addListener: () => {} }
  const doc = (globalThis as any).document
  doc.createElement = () => fakeEl()
  doc.body = fakeEl()
  ;({ crawlCache, MAX_ENTRIES, mergeEntries } =
    await import('../src/download/CrawlCache'))
  ;({ downloadControl } = await import('../src/download/DownloadControl'))
})

beforeEach(async () => {
  vi.spyOn(downloadControl, 'startDownload').mockResolvedValue(undefined)
  vi.spyOn(downloadControl, 'readyDownload').mockImplementation(() => {})
  vi.spyOn(downloadControl, 'drainAfterCrawl').mockImplementation(() => {})
  vi.spyOn(toast, 'error').mockImplementation(() => {})
  store.result = []
  store.resultMeta = []
  store.waitingIdList = []
  store.remainingDownload = 0
  states.settingInitialized = true
  states.busy = false
  states.downloading = false
  states.downloadPaused = false
  states.quickCrawl = false
  delete (globalThis as any).window.confirm
  for (const e of crawlCache.list()) {
    await crawlCache.remove(e.id)
  }
  mem = {}
})

function seedStore(creator = 'artist', n = 2) {
  store.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999', creator })]
  store.result = Array.from({ length: n }, (_, i) =>
    file(`patreon/u1/999#${i}`, { fileIndex: i, creator })
  )
}

describe('crawlCache', () => {
  it('空結果不存', async () => {
    expect(await crawlCache.autoSave()).toBeNull()
    expect(crawlCache.list()).toHaveLength(0)
  })

  it('有結果自動存：標題取創作者、新在前', async () => {
    seedStore()
    const saved = await crawlCache.autoSave()
    expect(saved?.title).toBe('artist')
    // 摘要不帶大陣列
    expect(saved).not.toHaveProperty('results')
    store.resultMeta = [file('fanbox/u2/1', { id: 'fanbox/u2/1' })]
    store.result = [
      file('fanbox/u2/1#0', {
        creator: 'b2',
        creatorId: 'u2',
        service: 'fanbox',
      }),
    ]
    await crawlCache.autoSave()
    const list = crawlCache.list()
    expect(list).toHaveLength(2)
    expect(list[0].title).toBe('b2')
    expect(list[1].title).toBe('artist')
    expect(list[0].postCount).toBe(1)
    expect(list[0].fileCount).toBe(1)
  })

  it('縮圖單帖快抓不存', async () => {
    seedStore()
    states.quickCrawl = true
    expect(await crawlCache.autoSave()).toBeNull()
    expect(crawlCache.list()).toHaveLength(0)
    states.quickCrawl = false
    expect(await crawlCache.autoSave()).not.toBeNull()
    expect(crawlCache.list()).toHaveLength(1)
  })

  it('上限擋下（預設 20 筆）', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) {
      seedStore(`a${i}`, 1)
      expect(await crawlCache.autoSave()).not.toBeNull()
    }
    seedStore('overflow', 1)
    expect(await crawlCache.autoSave()).toBeNull()
    expect(crawlCache.list()).toHaveLength(MAX_ENTRIES)
  })

  it('list／loadEntry 回傳拷貝：外部修改不污染快取', async () => {
    seedStore()
    await crawlCache.autoSave()
    const list = crawlCache.list()
    expect(list[0]).not.toHaveProperty('results')
    list[0].title = 'hacked'
    const full = await crawlCache.loadEntry(list[0].id)
    full!.results[0].title = 'hacked'
    expect(crawlCache.list()[0].title).toBe('artist')
    expect((await crawlCache.loadEntry(list[0].id))!.results[0].title).toBe('t')
  })

  it('改名：空字串與未知 id 拒絕', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    expect(await crawlCache.rename(e.id, '  new name  ')).toBe(true)
    expect(crawlCache.list()[0].title).toBe('new name')
    expect(await crawlCache.rename(e.id, '   ')).toBe(false)
    expect(await crawlCache.rename('nope', 'x')).toBe(false)
  })

  it('刪除：存在才刪', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    expect(await crawlCache.remove(e.id)).toBe(true)
    expect(crawlCache.list()).toHaveLength(0)
    expect(await crawlCache.remove(e.id)).toBe(false)
  })

  it('掛載：取代 store、清等待佇列、不開始下載、發 mountChange', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    store.waitingIdList = [{ id: 'x', type: 'post' }]
    store.result = []
    store.resultMeta = []
    const events: any[] = []
    EVT.on('mountChange', (ev) => events.push(ev.detail.data))
    expect(await crawlCache.mount(e.id)).toBe(true)
    expect(store.result).toHaveLength(2)
    expect(store.waitingIdList).toHaveLength(0)
    expect(store.result[0].creator).toBe('artist')
    expect(store.title).toBe('artist')
    expect(store.remainingDownload).toBe(2)
    expect(crawlCache.isMounted(e.id)).toBe(true)
    const mounted = crawlCache.getMounted()
    expect(mounted?.unsaved).toBe(false)
    expect(mounted?.entry?.id).toBe(e.id)
    expect(mounted?.entry).not.toHaveProperty('results')
    expect(events).toEqual([{ manual: true }])
    // 深拷貝：改 store 不污染快取
    store.result[0].title = 'changed'
    expect((await crawlCache.loadEntry(e.id))!.results[0].title).toBe('t')
    expect(downloadControl.startDownload).not.toHaveBeenCalled()
  })

  it('掛載：下載中或暫停中拒絕，store 不動', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    seedStore('other', 1)
    states.downloading = true
    expect(await crawlCache.mount(e.id)).toBe(false)
    states.downloading = false
    states.downloadPaused = true
    expect(await crawlCache.mount(e.id)).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(store.result).toHaveLength(1)
    expect(store.result[0].creator).toBe('other')
    expect(crawlCache.isMounted(e.id)).toBe(false)
  })

  it('掛載：抓取中（busy）拒絕', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    store.result = []
    states.busy = true
    expect(await crawlCache.mount(e.id)).toBe(false)
    expect(store.result).toHaveLength(0)
  })

  it('掛載：重複掛載同一筆直接回 true 不動 store', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    expect(await crawlCache.mount(e.id)).toBe(true)
    store.result[0].title = 'edited'
    expect(await crawlCache.mount(e.id)).toBe(true)
    expect(store.result[0].title).toBe('edited')
  })

  it('刪除掛載中的快取：閒置時一併卸載並清空 store', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    await crawlCache.mount(e.id)
    expect(await crawlCache.remove(e.id)).toBe(true)
    expect(crawlCache.getMounted()).toBeNull()
    expect(store.result).toHaveLength(0)
    expect(store.resultMeta).toHaveLength(0)
  })

  it('刪除掛載中的快取：下載中拒絕', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    await crawlCache.mount(e.id)
    states.downloading = true
    expect(await crawlCache.remove(e.id)).toBe(false)
    expect(crawlCache.list()).toHaveLength(1)
    expect(store.result).toHaveLength(2)
    expect(crawlCache.isMounted(e.id)).toBe(true)
  })

  it('卸載：清空 store、保留快取、發 mountChange(manual=false)', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    await crawlCache.mount(e.id)
    const events: any[] = []
    const off = (ev: any) => events.push(ev.detail.data)
    EVT.on('mountChange', off)
    expect(await crawlCache.unmount()).toBe(true)
    EVT.off('mountChange', off)
    expect(store.result).toHaveLength(0)
    expect(store.resultMeta).toHaveLength(0)
    expect(crawlCache.getMounted()).toBeNull()
    expect(crawlCache.list()).toHaveLength(1)
    expect(events).toEqual([{ manual: false }])
  })

  it('卸載：沒有掛載時回 false', async () => {
    expect(await crawlCache.unmount()).toBe(false)
  })

  it('卸載：下載中、暫停中、抓取中拒絕', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    await crawlCache.mount(e.id)
    for (const key of ['downloading', 'downloadPaused', 'busy'] as const) {
      states[key] = true
      expect(await crawlCache.unmount()).toBe(false)
      states[key] = false
    }
    expect(store.result).toHaveLength(2)
    expect(crawlCache.isMounted(e.id)).toBe(true)
  })

  it('改名掛載中的快取：同步 store.title', async () => {
    seedStore()
    await crawlCache.autoSave()
    const [e] = crawlCache.list()
    await crawlCache.mount(e.id)
    await crawlCache.rename(e.id, 'renamed')
    expect(store.title).toBe('renamed')
    expect(crawlCache.getMounted()?.entry?.title).toBe('renamed')
  })

  it('持久化：索引一個 key、每筆的結果各一個 key', async () => {
    seedStore()
    const saved = await crawlCache.autoSave()
    await new Promise((r) => setTimeout(r, 400))
    const index = mem['pawchiveProCrawlCache:index']
    expect(Array.isArray(index)).toBe(true)
    expect(index).toHaveLength(1)
    expect(index[0]).not.toHaveProperty('results')
    const body = mem[`pawchiveProCrawlCache:entry:${saved!.id}`]
    expect(body.results).toHaveLength(2)
    expect(body.metas).toHaveLength(1)
  })

  it('刪除後也移除該筆結果的 key', async () => {
    seedStore()
    const saved = await crawlCache.autoSave()
    await new Promise((r) => setTimeout(r, 400))
    expect(await crawlCache.remove(saved!.id)).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(mem['pawchiveProCrawlCache:index']).toEqual([])
    expect(`pawchiveProCrawlCache:entry:${saved!.id}` in mem).toBe(false)
  })

  it('未完成的抓取：快取帶 incomplete 旗標並寫入索引', async () => {
    seedStore()
    states.crawlIncomplete = true
    try {
      const saved = await crawlCache.autoSave()
      expect(saved?.incomplete).toBe(true)
      await new Promise((r) => setTimeout(r, 400))
      expect(mem['pawchiveProCrawlCache:index'][0].incomplete).toBe(true)
    } finally {
      states.crawlIncomplete = false
    }
    seedStore()
    const complete = await crawlCache.autoSave()
    expect(complete).not.toHaveProperty('incomplete')
  })
})

describe('crawlCache 事件路徑', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20))

  // EVT 是模組內的私有匯流排單例；每次重新載入模組（含 EVT）以重新綁定，
  // 並在同一批 import 取得與受測模組相同的 EVT 實例來派發事件
  let evt: typeof EVT
  async function fresh() {
    vi.resetModules()
    evt = (await import('../src/EVT')).EVT
    const st = (await import('../src/store/States')).states
    const sto = (await import('../src/store/Store')).store
    const cache = (await import('../src/download/CrawlCache')).crawlCache
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999' })]
    sto.result = [file('patreon/u1/999#0', { fileIndex: 0 })]
    return { st, cache }
  }

  it('crawlComplete 事件：正常抓取會存', async () => {
    const { st, cache } = await fresh()
    st.quickCrawl = false
    evt.fire('crawlComplete')
    await flush()
    expect(cache.list()).toHaveLength(1)
  })

  it('crawlComplete 事件：快速單帖抓取不存（旗標不會被事件提前復位）', async () => {
    const { st, cache } = await fresh()
    st.quickCrawl = true
    evt.fire('crawlComplete')
    await flush()
    expect(st.quickCrawl).toBe(true)
    expect(cache.list()).toHaveLength(0)
  })

  it('stopCrawl 後觸發 crawlComplete：中止的部分結果不存', async () => {
    const { st, cache } = await fresh()
    st.quickCrawl = false
    evt.fire('stopCrawl')
    evt.fire('crawlComplete')
    await flush()
    expect(cache.list()).toHaveLength(0)
  })
})

describe('crawlComplete 掛載決策', () => {
  const flush = () => new Promise((r) => setTimeout(r, 20))
  let evt: typeof EVT
  const fire = (t: eventNames) => evt.fire(t)

  async function fresh() {
    vi.resetModules()
    evt = (await import('../src/EVT')).EVT
    mem = {}
    const st = (await import('../src/store/States')).states
    const sto = (await import('../src/store/Store')).store
    const settings = (await import('../src/setting/Settings')).settings
    const cache = (await import('../src/download/CrawlCache')).crawlCache
    const dc = (await import('../src/download/DownloadControl')).downloadControl
    const tst = (await import('../src/Toast')).toast
    st.settingInitialized = true
    vi.spyOn(dc, 'readyDownload').mockImplementation(() => {})
    vi.spyOn(dc, 'drainAfterCrawl').mockImplementation(() => {})
    vi.spyOn(tst, 'show').mockImplementation(() => {})
    vi.spyOn(tst, 'success').mockImplementation(() => {})
    vi.spyOn(tst, 'error').mockImplementation(() => {})
    return { st, sto, settings, cache, dc }
  }

  function seed(sto: typeof store, creator: string, n = 1) {
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999', creator })]
    sto.result = Array.from({ length: n }, (_, i) =>
      file('patreon/u1/999#' + i, { fileIndex: i, creator })
    )
  }

  it('autoMountCache 開：新結果存入並掛載，走 readyDownload', async () => {
    const { st, sto, cache, dc } = await fresh()
    st.quickCrawl = false
    seed(sto, 'new')
    fire('crawlComplete')
    await flush()
    const list = cache.list()
    expect(list).toHaveLength(1)
    const mounted = cache.getMounted()
    expect(mounted?.unsaved).toBe(false)
    expect(mounted?.entry?.id).toBe(list[0].id)
    expect(dc.readyDownload).toHaveBeenCalledTimes(1)
    expect(dc.drainAfterCrawl).not.toHaveBeenCalled()
    expect(sto.result[0].creator).toBe('new')
  })

  it('autoMountCache 關：還原原本掛載的快取並保留等待佇列', async () => {
    const { st, sto, settings, cache, dc } = await fresh()
    st.quickCrawl = false
    seed(sto, 'old', 2)
    fire('crawlComplete')
    await flush()
    const oldId = cache.list()[0].id
    expect(cache.isMounted(oldId)).toBe(true)
    vi.mocked(dc.readyDownload).mockClear()

    settings.set('autoMountCache', false)
    fire('crawlStart')
    st.quickCrawl = false
    seed(sto, 'fresh', 1)
    sto.waitingIdList = [{ id: 'q', type: 'post' }]
    fire('crawlComplete')
    await flush()

    expect(cache.list()).toHaveLength(2)
    expect(cache.list()[0].title).toBe('fresh')
    expect(cache.isMounted(oldId)).toBe(true)
    expect(sto.result).toHaveLength(2)
    expect(sto.result[0].creator).toBe('old')
    expect(sto.title).toBe('old')
    expect(sto.waitingIdList).toHaveLength(1)
    expect(dc.drainAfterCrawl).toHaveBeenCalledTimes(1)
    expect(dc.readyDownload).not.toHaveBeenCalled()
  })

  it('autoMountCache 關且原本沒掛載：清空下載區、不掛載', async () => {
    const { st, sto, settings, cache, dc } = await fresh()
    settings.set('autoMountCache', false)
    st.quickCrawl = false
    fire('crawlStart')
    seed(sto, 'fresh', 1)
    fire('crawlComplete')
    await flush()
    expect(cache.list()).toHaveLength(1)
    expect(cache.getMounted()).toBeNull()
    expect(sto.result).toHaveLength(0)
    expect(dc.drainAfterCrawl).toHaveBeenCalledTimes(1)
    expect(dc.readyDownload).not.toHaveBeenCalled()
  })

  it('中途停止的結果：不存快取，直接以未存入狀態掛載', async () => {
    const { st, sto, settings, cache, dc } = await fresh()
    // 即使關閉自動掛載，沒存進快取的結果也一律直接掛載
    settings.set('autoMountCache', false)
    st.quickCrawl = false
    fire('stopCrawl')
    seed(sto, 'partial', 1)
    fire('crawlComplete')
    await flush()
    expect(cache.list()).toHaveLength(0)
    expect(cache.getMounted()).toEqual({ entry: null, unsaved: true })
    expect(sto.result).toHaveLength(1)
    expect(dc.readyDownload).toHaveBeenCalledTimes(1)
  })

  it('未存入的掛載：掛載其他快取前要確認，拒絕則不動', async () => {
    const { st, sto, cache } = await fresh()
    st.quickCrawl = false
    seed(sto, 'saved', 1)
    fire('crawlComplete')
    await flush()
    const id = cache.list()[0].id
    // 新一輪快抓：結果不存、掛載為未存入
    fire('crawlStart')
    st.quickCrawl = true
    seed(sto, 'quick', 1)
    fire('crawlComplete')
    await flush()
    expect(cache.getMounted()?.unsaved).toBe(true)
    ;(globalThis as any).window.confirm = () => false
    expect(await cache.mount(id)).toBe(false)
    expect(sto.result[0].creator).toBe('quick')
    ;(globalThis as any).window.confirm = () => true
    expect(await cache.mount(id)).toBe(true)
    expect(sto.result[0].creator).toBe('saved')
    expect(cache.getMounted()?.unsaved).toBe(false)
  })

  it('未存入的掛載：卸載前要確認，拒絕則不動', async () => {
    const { st, sto, cache } = await fresh()
    st.quickCrawl = true
    seed(sto, 'quick', 1)
    fire('crawlComplete')
    await flush()
    expect(cache.getMounted()?.unsaved).toBe(true)
    ;(globalThis as any).window.confirm = () => false
    expect(await cache.unmount()).toBe(false)
    expect(sto.result).toHaveLength(1)
    ;(globalThis as any).window.confirm = () => true
    expect(await cache.unmount()).toBe(true)
    expect(sto.result).toHaveLength(0)
    expect(cache.getMounted()).toBeNull()
  })

  it('空結果：不掛載，交給 readyDownload 收尾', async () => {
    const { st, sto, cache, dc } = await fresh()
    st.quickCrawl = false
    sto.result = []
    sto.resultMeta = []
    fire('crawlComplete')
    await flush()
    expect(cache.getMounted()).toBeNull()
    expect(dc.readyDownload).toHaveBeenCalledTimes(1)
  })

  it('crawlStart 後卸載（store 會被清空）', async () => {
    const { st, sto, cache } = await fresh()
    st.quickCrawl = false
    seed(sto, 'a', 1)
    fire('crawlComplete')
    await flush()
    expect(cache.getMounted()).not.toBeNull()
    fire('crawlStart')
    expect(cache.getMounted()).toBeNull()
  })
})

describe('crawlCache across tabs', () => {
  const KEY = 'pawchiveProCrawlCache:index'
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const settle = () => wait(350)

  function entry(id: string, createdAt: number, title = id): CacheEntry {
    return {
      id,
      title,
      service: 'patreon',
      creatorId: 'u1',
      creator: 'artist',
      host: 'kemono.su',
      postCount: 1,
      fileCount: 1,
      createdAt,
      results: [file(`${id}#0`)],
      metas: [file(id, { id })],
    }
  }
  const ids = () => (mem[KEY] as CacheEntry[]).map((e) => e.id)
  /** Storage as another tab leaves it: the index plus a body per entry */
  function seed(list: CacheEntry[]) {
    mem[KEY] = list.map(({ results: _r, metas: _m, ...summary }) => summary)
    for (const e of list) {
      mem[`pawchiveProCrawlCache:entry:${e.id}`] = {
        results: e.results,
        metas: e.metas,
      }
    }
  }
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

  let changeListeners: Array<(changes: any, area: string) => void>
  let keySets: number
  let quotaWhenOver: number
  /** Runs right after this tab's index write lands, before set() resolves */
  let afterIndexSet: (() => void) | null

  function emitChange(newValue: unknown) {
    for (const fn of changeListeners) {
      fn({ [KEY]: { newValue } }, 'local')
    }
  }

  async function freshCache() {
    vi.resetModules()
    evt = (await import('../src/EVT')).EVT
    const st = (await import('../src/store/States')).states
    const sto = (await import('../src/store/Store')).store
    const cache = (await import('../src/download/CrawlCache')).crawlCache
    const tst = (await import('../src/Toast')).toast
    st.settingInitialized = true
    vi.spyOn(tst, 'show').mockImplementation(() => {})
    vi.spyOn(tst, 'success').mockImplementation(() => {})
    vi.spyOn(tst, 'warning').mockImplementation(() => {})
    vi.spyOn(tst, 'error').mockImplementation(() => {})
    await wait(10)
    return { cache, sto }
  }
  let evt: typeof EVT

  // Let debounced saves of earlier tests' instances fire before we swap the
  // storage mock, so they cannot write into this suite's storage
  beforeAll(() => wait(300))

  beforeEach(() => {
    changeListeners = []
    keySets = 0
    quotaWhenOver = Infinity
    afterIndexSet = null
    const g = globalThis as any
    g.chrome.storage.onChanged = {
      addListener: (fn: any) => changeListeners.push(fn),
    }
    const base = storageOver(clone)
    g.chrome.storage.local = {
      ...base,
      set: async (obj: Record<string, any>) => {
        if (KEY in obj) {
          keySets++
          if (obj[KEY].length > quotaWhenOver) {
            throw new Error('QUOTA_BYTES quota exceeded')
          }
        }
        await base.set(obj)
        if (KEY in obj && afterIndexSet) {
          const fn = afterIndexSet
          afterIndexSet = null
          fn()
        }
      },
    }
    mem = {}
  })

  it('keeps an entry another tab added after our load, and ours too', async () => {
    seed([entry('E1', 1000)])
    const { cache, sto } = await freshCache()
    seed([entry('E2', 2000), entry('E1', 1000)])
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999' })]
    sto.result = [file('patreon/u1/999#0')]
    const saved = await cache.autoSave({ silent: true })
    await settle()
    expect(ids()).toEqual([saved!.id, 'E2', 'E1'])
    expect(cache.list().map((e) => e.id)).toEqual([saved!.id, 'E2', 'E1'])
  })

  it('does not undo our delete when merging with another tab', async () => {
    seed([entry('E2', 2000), entry('E1', 1000)])
    const { cache } = await freshCache()
    expect(await cache.remove('E1')).toBe(true)
    seed([entry('E3', 3000), entry('E2', 2000), entry('E1', 1000)])
    await settle()
    expect(ids()).toEqual(['E3', 'E2'])
  })

  it('does not undo the other tab delete unless we modified that entry', async () => {
    seed([entry('E3', 3000), entry('E2', 2000), entry('E1', 1000)])
    const { cache } = await freshCache()
    seed([entry('E3', 3000), entry('E1', 1000)])
    expect(await cache.rename('E1', 'mine')).toBe(true)
    await settle()
    expect(ids()).toEqual(['E3', 'E1'])
    expect(cache.list().map((e) => e.id)).toEqual(['E3', 'E1'])

    // an entry we modified ourselves is written back even if it was deleted
    seed([entry('E3', 3000)])
    expect(await cache.rename('E1', 'mine again')).toBe(true)
    await settle()
    expect(ids()).toEqual(['E3', 'E1'])
    expect((mem[KEY] as CacheEntry[])[1].title).toBe('mine again')
  })

  it('a rename here wins over the stored copy; untouched entries follow storage', async () => {
    seed([entry('E3', 3000, 'c'), entry('E1', 1000, 'a')])
    const { cache } = await freshCache()
    seed([
      entry('E3', 3000, 'c renamed elsewhere'),
      entry('E2', 2000),
      entry('E1', 1000, 'a renamed elsewhere'),
    ])
    expect(await cache.rename('E1', 'mine')).toBe(true)
    await settle()
    const saved = mem[KEY] as CacheEntry[]
    expect(saved.map((e) => [e.id, e.title])).toEqual([
      ['E3', 'c renamed elsewhere'],
      ['E2', 'E2'],
      ['E1', 'mine'],
    ])
  })

  it('still caps at MAX_ENTRIES after a merge, dropping the oldest', async () => {
    const { cache, sto } = await freshCache()
    seed(
      Array.from({ length: MAX_ENTRIES }, (_, i) => entry(`O${i}`, 5000 - i))
    )
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999' })]
    sto.result = [file('patreon/u1/999#0')]
    const saved = await cache.autoSave({ silent: true })
    await settle()
    expect(saved).not.toBeNull()
    expect(ids()).toHaveLength(MAX_ENTRIES)
    expect(ids()[0]).toBe(saved!.id)
    expect(ids()).not.toContain(`O${MAX_ENTRIES - 1}`)
  })

  it('follows changes from another tab without a reload', async () => {
    seed([entry('E1', 1000)])
    const { cache } = await freshCache()
    const changes: any[] = []
    evt.on('cacheChange', (ev) => changes.push(ev.detail.data))
    const next = [entry('E2', 2000), entry('E1', 1000, 'renamed elsewhere')]
    seed(next)
    emitChange(next)
    expect(cache.list().map((e) => [e.id, e.title])).toEqual([
      ['E2', 'E2'],
      ['E1', 'renamed elsewhere'],
    ])
    expect(changes).toHaveLength(1)
    // following another tab never writes
    await settle()
    expect(keySets).toBe(0)
  })

  it('the mounted entry disappearing flips to mounted-but-unsaved', async () => {
    seed([entry('E1', 1000)])
    const { cache, sto } = await freshCache()
    expect(await cache.mount('E1')).toBe(true)
    expect(sto.result).toHaveLength(1)
    expect(cache.getMounted()?.unsaved).toBe(false)
    const mounts: any[] = []
    evt.on('mountChange', (ev) => mounts.push(ev.detail.data))

    seed([])
    emitChange([])

    expect(cache.list()).toHaveLength(0)
    expect(cache.isMounted('E1')).toBe(false)
    expect(cache.getMounted()).toEqual({ entry: null, unsaved: true })
    expect(mounts).toEqual([{ manual: false }])
    await settle()
    expect(keySets).toBe(0)
  })

  it('ignores storage changes that arrive before the first load', async () => {
    let release: (v: any) => void = () => {}
    ;(globalThis as any).chrome.storage.local.get = () =>
      new Promise((resolve) => {
        release = resolve
      })
    vi.resetModules()
    const cache = (await import('../src/download/CrawlCache')).crawlCache
    emitChange([entry('E9', 9000)])
    release({ [KEY]: [entry('E1', 1000)] })
    await wait(10)
    expect(cache.list().map((e) => e.id)).toEqual(['E1'])
  })

  it('quota eviction does not bring the dropped entry back from storage', async () => {
    seed([entry('E2', 2000), entry('E1', 1000)])
    const { cache, sto } = await freshCache()
    quotaWhenOver = 2
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999' })]
    sto.result = [file('patreon/u1/999#0')]
    const saved = await cache.autoSave({ silent: true })
    await wait(700)
    expect(ids()).toEqual([saved!.id, 'E2'])
    expect(cache.list().map((e) => e.id)).toEqual([saved!.id, 'E2'])
  })

  it('keeps the results of an entry another tab saved while our write was in flight', async () => {
    seed([entry('E1', 1000)])
    const { cache, sto } = await freshCache()
    // The other tab writes E9 (index and results) right after our write
    // lands, and its change event reaches us before our set() resolves
    afterIndexSet = () => {
      const next = [entry('E9', 9000), ...(mem[KEY] as CacheEntry[])]
      seed(next)
      emitChange(mem[KEY])
    }
    sto.resultMeta = [file('patreon/u1/999', { id: 'patreon/u1/999' })]
    sto.result = [file('patreon/u1/999#0')]
    await cache.autoSave({ silent: true })
    await settle()
    expect(ids()).toContain('E9')
    expect(mem['pawchiveProCrawlCache:entry:E9']).toBeDefined()
    expect(await cache.mount('E9')).toBe(true)
  })

  it('mounting an entry whose results key is gone fails with a message', async () => {
    seed([entry('E1', 1000)])
    delete mem['pawchiveProCrawlCache:entry:E1']
    const { cache, sto } = await freshCache()
    const { toast: tst } = await import('../src/Toast')
    expect(await cache.mount('E1')).toBe(false)
    expect(tst.error).toHaveBeenCalled()
    expect(sto.result).toHaveLength(0)
  })

  describe('migration from the single key', () => {
    const LEGACY = 'pawchiveProCrawlCache'
    const bodyIn = (id: string) => mem[`pawchiveProCrawlCache:entry:${id}`]

    it('moves the old entries to the index and their own keys, then removes the old key', async () => {
      mem[LEGACY] = [entry('E2', 2000, 'two'), entry('E1', 1000)]
      const { cache, sto } = await freshCache()
      expect(cache.list().map((e) => [e.id, e.title])).toEqual([
        ['E2', 'two'],
        ['E1', 'E1'],
      ])
      await settle()
      expect(LEGACY in mem).toBe(false)
      expect(ids()).toEqual(['E2', 'E1'])
      expect(mem[KEY][0]).not.toHaveProperty('results')
      expect(bodyIn('E2').results).toHaveLength(1)
      expect(bodyIn('E1').metas).toHaveLength(1)
      expect(await cache.mount('E1')).toBe(true)
      expect(sto.result[0].id).toBe('E1#0')
    })

    it('keeps what the index already has and adds only the missing entries', async () => {
      seed([entry('E2', 2000, 'renamed in the new layout')])
      mem[LEGACY] = [entry('E2', 2000, 'old title'), entry('E1', 1000)]
      const { cache } = await freshCache()
      await settle()
      expect(LEGACY in mem).toBe(false)
      expect(mem[KEY].map((e: CacheEntry) => [e.id, e.title])).toEqual([
        ['E2', 'renamed in the new layout'],
        ['E1', 'E1'],
      ])
      expect(cache.list()).toHaveLength(2)
    })

    it('two tabs migrating at once end with every entry once', async () => {
      mem[LEGACY] = [entry('E2', 2000), entry('E1', 1000)]
      const a = await freshCache()
      const b = await freshCache()
      await settle()
      expect(LEGACY in mem).toBe(false)
      expect(ids()).toEqual(['E2', 'E1'])
      expect(a.cache.list()).toHaveLength(2)
      expect(b.cache.list()).toHaveLength(2)
    })

    it('a failed write keeps the old key; the entries stay usable and the next load retries', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      mem[LEGACY] = [entry('E1', 1000)]
      quotaWhenOver = -1
      const { cache, sto } = await freshCache()
      await settle()
      expect(LEGACY in mem).toBe(true)
      expect(KEY in mem).toBe(false)
      expect(await cache.mount('E1')).toBe(true)
      expect(sto.result).toHaveLength(1)

      quotaWhenOver = Infinity
      await freshCache()
      await settle()
      expect(LEGACY in mem).toBe(false)
      expect(ids()).toEqual(['E1'])
    })
  })
})

describe('CacheView', () => {
  it('tags an entry saved from an incomplete crawl', async () => {
    const { CacheView } = await import('../src/setting/pages/cache')
    const { lang } = await import('../src/Language')
    // The same module instance the view imports (earlier suites reset modules)
    const { crawlCache: cache } = await import('../src/download/CrawlCache')
    const view = new CacheView({ reapplySearch: () => {} } as any)
    const list = fakeEl()
    ;(view as any).cacheList = list
    vi.spyOn(cache, 'list').mockReturnValue([
      { ...summaryOf('A'), incomplete: true },
      summaryOf('B'),
    ])
    view.render()
    const titles = list.children.map(
      (card: any) => card.children[0].textContent
    )
    expect(titles).toEqual([`A ${lang.transl('_cacheIncompleteTag')}`, 'B'])
  })

  function summaryOf(id: string) {
    return {
      id,
      title: id,
      service: 'patreon',
      creatorId: 'u1',
      creator: 'artist',
      host: 'kemono.su',
      postCount: 1,
      fileCount: 1,
      createdAt: 1000,
    }
  }
})

describe('mergeEntries', () => {
  const e = (id: string, createdAt: number, title = id): CacheEntry => ({
    id,
    title,
    service: 's',
    creatorId: 'c',
    creator: 'c',
    host: 'h',
    postCount: 1,
    fileCount: 1,
    createdAt,
    results: [],
    metas: [],
  })
  const none = new Set<string>()
  const names = (list: CacheEntry[]) => list.map((x) => `${x.id}:${x.title}`)

  it('returns the stored list newest first when nothing changed locally', () => {
    const stored = [e('a', 1), e('b', 3), e('c', 2)]
    expect(names(mergeEntries(stored, stored, none, none))).toEqual([
      'b:b',
      'c:c',
      'a:a',
    ])
  })

  it('drops deleted ids', () => {
    const stored = [e('a', 3), e('b', 2), e('c', 1)]
    expect(names(mergeEntries(stored, [], none, new Set(['b']))).join()).toBe(
      'a:a,c:c'
    )
  })

  it('lets a dirty local entry replace its stored copy', () => {
    const stored = [e('a', 3, 'old'), e('b', 2)]
    const local = [e('a', 3, 'new'), e('b', 2)]
    expect(names(mergeEntries(stored, local, new Set(['a']), none))).toEqual([
      'a:new',
      'b:b',
    ])
  })

  it('inserts a dirty local entry that storage does not have', () => {
    const stored = [e('b', 2), e('a', 1)]
    const local = [e('n', 5), e('a', 1)]
    expect(names(mergeEntries(stored, local, new Set(['n']), none))).toEqual([
      'n:n',
      'b:b',
      'a:a',
    ])
  })

  it('keeps stored data for entries that are not dirty and drops stored-less ones', () => {
    const stored = [e('a', 2, 'stored title')]
    const local = [e('a', 2, 'stale local title'), e('gone', 1)]
    expect(names(mergeEntries(stored, local, none, none))).toEqual([
      'a:stored title',
    ])
  })

  it('puts dirty local entries ahead of stored ones on equal timestamps, in local order', () => {
    const stored = [e('s1', 10), e('s2', 10)]
    const local = [e('n2', 10), e('n1', 10)]
    expect(
      names(mergeEntries(stored, local, new Set(['n1', 'n2']), none))
    ).toEqual(['n2:n2', 'n1:n1', 's1:s1', 's2:s2'])
  })

  it('a deleted id wins over a dirty one', () => {
    const stored = [e('a', 1)]
    const local = [e('a', 1, 'edited')]
    expect(mergeEntries(stored, local, new Set(['a']), new Set(['a']))).toEqual(
      []
    )
  })

  it('caps at MAX_ENTRIES by dropping the oldest', () => {
    const stored = Array.from({ length: MAX_ENTRIES }, (_, i) =>
      e(`s${i}`, 1000 - i)
    )
    const local = [e('new', 5000)]
    const merged = mergeEntries(stored, local, new Set(['new']), none)
    expect(merged).toHaveLength(MAX_ENTRIES)
    expect(merged[0].id).toBe('new')
    expect(merged.map((x) => x.id)).not.toContain(`s${MAX_ENTRIES - 1}`)
  })
})
