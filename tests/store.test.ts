import { beforeEach, describe, expect, it } from 'vitest'
import { EVT } from '../src/EVT'
import { store } from '../src/store/Store'

const META = {
  postKey: 'patreon/u1/999',
  service: 'patreon',
  creator: 'artist',
  creatorId: 'u1',
  postId: '999',
  title: 't',
  published: '',
  fileCount: 2,
  pending: false,
}

const FILES = [
  {
    fileUrl: 'https://x/1.png',
    fileName: '1.png',
    ext: 'png',
    kind: 'image' as const,
  },
  {
    fileUrl: 'https://x/2.png',
    fileName: '2.png',
    ext: 'png',
    kind: 'image' as const,
  },
]

describe('store', () => {
  // setup.ts 的 beforeEach 會清空事件監聽（隔離測試），所以直接調 reset()
  beforeEach(() => {
    store.reset()
  })

  it('一帖展開為多條 Result，id 全域唯一', () => {
    store.addResult(META, FILES)
    expect(store.resultMeta).toHaveLength(1)
    expect(store.resultMeta[0].id).toBe('patreon/u1/999')
    expect(store.result.map((r) => r.id)).toEqual([
      'patreon/u1/999#0',
      'patreon/u1/999#1',
    ])
    expect(store.downloadCount['patreon/u1/999']).toBe(2)
  })

  it('重複 postKey 去重', () => {
    store.addResult(META, FILES)
    store.addResult(META, FILES)
    expect(store.resultMeta).toHaveLength(1)
    expect(store.result).toHaveLength(2)
  })

  it('addResult 觸發 addResult 事件', () => {
    let got = 0
    const listener = () => got++
    EVT.on('addResult', listener)
    store.addResult(META, FILES)
    EVT.off('addResult', listener)
    expect(got).toBe(1)
  })

  it('findResult looks up by id through every write path', () => {
    store.addResult(META, FILES)
    expect(store.findResult('patreon/u1/999#1')?.fileName).toBe('2.png')
    expect(store.findResult('patreon/u1/999#2')).toBeUndefined()

    // Replacing the array through the setter rebuilds the index
    const other = store.result.map((r) => ({ ...r, id: r.id + 'x' }))
    store.result = other
    expect(store.findResult('patreon/u1/999#1')).toBeUndefined()
    expect(store.findResult('patreon/u1/999#1x')).toBe(other[1])

    // loadSnapshot and reset keep it in sync
    const copy = JSON.parse(JSON.stringify(store.result))
    store.reset()
    expect(store.findResult('patreon/u1/999#1x')).toBeUndefined()
    store.loadSnapshot(copy, [])
    expect(store.findResult('patreon/u1/999#0x')).toBe(copy[0])
  })

  it('findResult still finds a result pushed into the array directly', () => {
    store.addResult(META, FILES)
    store.result.push({ ...store.result[0], id: 'manual#0' })
    expect(store.findResult('manual#0')?.id).toBe('manual#0')
  })

  it('dedupes many posts by postKey', () => {
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 200; k++) {
        store.addResult({ ...META, postKey: `patreon/u1/${k}` }, FILES)
      }
    }
    expect(store.resultMeta).toHaveLength(200)
    expect(store.result).toHaveLength(400)
  })

  it('loadSnapshot 重建去重表與下載計數', () => {
    store.addResult(META, FILES)
    const results = JSON.parse(JSON.stringify(store.result))
    const metas = JSON.parse(JSON.stringify(store.resultMeta))

    store.reset()
    store.loadSnapshot(results, metas)
    expect(store.result).toHaveLength(2)
    expect(store.resultMeta).toHaveLength(1)
    expect(store.downloadCount['patreon/u1/999']).toBe(2)

    // 去重表已同步：同 postKey 再加入應被忽略
    store.addResult(META, FILES)
    expect(store.resultMeta).toHaveLength(1)
    expect(store.result).toHaveLength(2)
  })

  it('reset keeps tasks queued behind the crawl that is starting', () => {
    store.waitingIdList = [{ id: 'patreon/u1/1000', type: 'post' }]
    store.waitingFullCrawl = true
    store.reset()
    expect(store.waitingIdList).toHaveLength(1)
    expect(store.waitingFullCrawl).toBe(true)

    // loadSnapshot replaces the results and drops what was queued
    store.loadSnapshot([], [])
    expect(store.waitingIdList).toHaveLength(0)
    expect(store.waitingFullCrawl).toBe(false)
  })

  it('reset 清空並記錄頁面類型', () => {
    store.addResult(META, FILES)
    store.reset()
    expect(store.result).toHaveLength(0)
    expect(store.pageType).toBe('other')
  })
})
