import { describe, expect, it, vi } from 'vitest'
import type { EVT as EVTType } from '../src/EVT'
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

function file(id: string, creator: string, overrides: Partial<Result> = {}) {
  return {
    id,
    postKey: `patreon/${creator}/1`,
    service: 'patreon',
    creator,
    creatorId: creator,
    postId: '1',
    title: 't',
    published: '2024-01-02T03:04:05',
    fileCount: 1,
    pending: false,
    fileUrl: 'https://x/1.png',
    fileName: '1.png',
    ext: 'png',
    kind: 'image',
    previewOnly: false,
    textData: '',
    fileIndex: 0,
    ...overrides,
  } as Result
}

const flush = () => new Promise((r) => setTimeout(r, 20))

let evt: typeof EVTType

/** 重新載入所有模組（EVT 匯流排、單例都重建），並把下載控制換成假的 */
async function fresh(creators = ['a', 'b', 'c']) {
  vi.resetModules()
  const mem: Record<string, any> = {}
  const g = globalThis as any
  g.chrome.storage.local = {
    get: async (k: string) => (k in mem ? { [k]: mem[k] } : {}),
    set: async (obj: Record<string, any>) => {
      Object.assign(mem, obj)
    },
  }
  g.chrome.runtime.onMessage = { addListener: () => {} }
  g.document.createElement = () => fakeEl()
  g.document.body = fakeEl()
  delete g.window.confirm

  evt = (await import('../src/EVT')).EVT
  const st = (await import('../src/store/States')).states
  const sto = (await import('../src/store/Store')).store
  const cache = (await import('../src/download/CrawlCache')).crawlCache
  const dc = (await import('../src/download/DownloadControl')).downloadControl
  const tst = (await import('../src/Toast')).toast
  const q = (await import('../src/download/DownloadQueue')).downloadQueue
  st.settingInitialized = true
  for (const k of ['show', 'success', 'error', 'warning'] as const) {
    vi.spyOn(tst, k).mockImplementation(() => {})
  }
  // 假的下載：開始＝發 downloadStart；停止＝發 downloadStop
  const start = vi
    .spyOn(dc, 'startDownload')
    .mockImplementation(async () => evt.fire('downloadStart'))
  const stop = vi
    .spyOn(dc, 'stopDownload')
    .mockImplementation(() => evt.fire('downloadStop'))

  const ids: string[] = []
  for (const c of creators) {
    sto.resultMeta = [file(`patreon/${c}/1`, c)]
    sto.result = [file(`patreon/${c}/1#0`, c)]
    const s = await cache.autoSave({ silent: true })
    ids.push(s!.id)
  }
  sto.result = []
  sto.resultMeta = []
  return { st, sto, cache, dc, q, start, stop, ids, mem }
}

const statuses = (q: { list(): Array<{ status: string }> }) =>
  q.list().map((i) => i.status)

describe('normalizeQueue', () => {
  it('濾掉壞資料、去重、下載中退回等待', async () => {
    await fresh([])
    const { normalizeQueue } = await import('../src/download/DownloadQueue')
    expect(
      normalizeQueue([
        { cacheId: 'a', title: 'A', status: 'running' },
        { cacheId: 'a', title: 'dup', status: 'done' },
        { cacheId: '', title: 'x', status: 'done' },
        null,
        'junk',
        { cacheId: 'b', title: 'B', status: 'weird' },
        { cacheId: 'c', status: 'partial' },
      ])
    ).toEqual([
      { cacheId: 'a', title: 'A', status: 'waiting' },
      { cacheId: 'b', title: 'B', status: 'waiting' },
      { cacheId: 'c', title: 'c', status: 'partial' },
    ])
    expect(normalizeQueue(undefined)).toEqual([])
  })
})

describe('downloadQueue', () => {
  it('加入：重複加入拒絕；已結束的重新加入會排到最後', async () => {
    const { q, ids } = await fresh()
    expect(await q.add(ids[0])).toBe(true)
    expect(await q.add(ids[0])).toBe(false)
    expect(await q.add(ids[1])).toBe(true)
    expect(await q.add('nope')).toBe(false)
    expect(q.has(ids[0])).toBe(true)
    expect(q.list().map((i) => i.title)).toEqual(['a', 'b'])
    await q.start()
    evt.fire('downloadComplete')
    await flush()
    evt.fire('downloadComplete')
    await flush()
    expect(q.has(ids[0])).toBe(false)
    expect(await q.add(ids[0])).toBe(true)
    expect(q.list().map((i) => [i.title, i.status])).toEqual([
      ['b', 'done'],
      ['a', 'waiting'],
    ])
  })

  it('依序掛載並下載，全部完成後停下', async () => {
    const { q, ids, cache, start, sto } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    expect(await q.start()).toBe(true)
    expect(q.isRunning()).toBe(true)
    expect(cache.isMounted(ids[0])).toBe(true)
    expect(sto.result[0].creator).toBe('a')
    expect(start).toHaveBeenCalledTimes(1)
    expect(statuses(q)).toEqual(['running', 'waiting'])

    evt.fire('downloadComplete')
    await flush()
    expect(statuses(q)).toEqual(['done', 'running'])
    expect(cache.isMounted(ids[1])).toBe(true)
    expect(start).toHaveBeenCalledTimes(2)

    evt.fire('downloadComplete')
    await flush()
    expect(statuses(q)).toEqual(['done', 'done'])
    expect(q.isRunning()).toBe(false)
  })

  it('重試用完：標成部分失敗、安靜停掉、換下一筆', async () => {
    const { q, ids, stop, start } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await q.start()
    evt.fire('downloadGiveUp')
    await flush()
    expect(stop).toHaveBeenCalledWith({ quiet: true })
    expect(statuses(q)).toEqual(['partial', 'running'])
    expect(start).toHaveBeenCalledTimes(2)
    expect(q.isRunning()).toBe(true)
  })

  it('使用者手動停止下載：目前那筆回到等待、佇列暫停', async () => {
    const { q, ids, start } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await q.start()
    evt.fire('downloadStop')
    await flush()
    expect(statuses(q)).toEqual(['waiting', 'waiting'])
    expect(q.isRunning()).toBe(false)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('暫停佇列：目前那筆下載完，不接下一筆', async () => {
    const { q, ids, start } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await q.start()
    q.pause()
    evt.fire('downloadComplete')
    await flush()
    expect(statuses(q)).toEqual(['done', 'waiting'])
    expect(start).toHaveBeenCalledTimes(1)
    expect(q.isRunning()).toBe(false)
  })

  it('快取已刪除：標成找不到並略過', async () => {
    const { q, ids, cache, start } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await cache.remove(ids[0])
    await q.start()
    expect(statuses(q)).toEqual(['missing', 'running'])
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('開始下載的前置檢查沒過：標成無法開始並換下一筆', async () => {
    const { q, ids, start } = await fresh()
    // 第一次不發 downloadStart（模擬 prepareStart 失敗），第二次正常
    start.mockImplementationOnce(async () => {})
    await q.add(ids[0])
    await q.add(ids[1])
    await q.start()
    await flush()
    expect(statuses(q)).toEqual(['failed', 'running'])
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('下載中的那筆不能移除；其他可以；可上下移', async () => {
    const { q, ids } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await q.add(ids[2])
    await q.start()
    expect(await q.remove(ids[0])).toBe(false)
    expect(q.move(ids[2], -1)).toBe(true)
    expect(q.list().map((i) => i.cacheId)).toEqual([ids[0], ids[2], ids[1]])
    expect(q.move(ids[0], -1)).toBe(false)
    expect(await q.remove(ids[1])).toBe(true)
    expect(q.list()).toHaveLength(2)
  })

  it('清除已結束：只留等待與下載中', async () => {
    const { q, ids } = await fresh()
    await q.add(ids[0])
    await q.add(ids[1])
    await q.add(ids[2])
    await q.start()
    evt.fire('downloadComplete')
    await flush()
    q.clearFinished()
    expect(statuses(q)).toEqual(['running', 'waiting'])
  })

  it('有任務進行中時不能開始；沒有等待項目時不能開始', async () => {
    const { q, ids, st } = await fresh()
    expect(await q.start()).toBe(false)
    await q.add(ids[0])
    st.downloading = true
    expect(await q.start()).toBe(false)
    expect(q.isRunning()).toBe(false)
  })

  it('抓取開始：佇列暫停、目前那筆回到等待', async () => {
    const { q, ids } = await fresh()
    await q.add(ids[0])
    await q.start()
    evt.fire('crawlStart')
    expect(q.isRunning()).toBe(false)
    expect(statuses(q)).toEqual(['waiting'])
  })

  it('持久化：寫入 storage；重新載入時下載中退回等待', async () => {
    const { q, ids, mem } = await fresh()
    await q.add(ids[0])
    await q.start()
    await new Promise((r) => setTimeout(r, 300))
    const saved = mem['pawchiveProDownloadQueue']
    expect(saved).toEqual([{ cacheId: ids[0], title: 'a', status: 'running' }])
    const { normalizeQueue } = await import('../src/download/DownloadQueue')
    expect(normalizeQueue(saved)[0].status).toBe('waiting')
  })
})
