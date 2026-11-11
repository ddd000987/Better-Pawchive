import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadRecord } from '../src/download/DownloadRecord'
import { settings } from '../src/setting/Settings'
import type { Result } from '../src/store/StoreType'

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

describe('downloadRecord', () => {
  beforeEach(async () => {
    settings.set('skipDownloaded', 'record')
    settings.set(
      'namingRule',
      'kemono/{service}/{creator}-{creator_id}/{post_id}-{title}/{index}-{file_name}.{ext}'
    )
    await downloadRecord.clear(true)
  })

  it('未記錄不重複；登記後重複（只認 id）', async () => {
    const r = file('patreon/u1/999#0')
    expect(await downloadRecord.checkDeduplication(r)).toBe(false)
    await downloadRecord.addRecord(r)
    expect(await downloadRecord.checkDeduplication(r)).toBe(true)
  })

  it('不按記錄跳過（none／folder）總是放行；record／both 才比對', async () => {
    const r = file('patreon/u1/999#0')
    await downloadRecord.addRecord(r)
    for (const mode of ['none', 'folder'] as const) {
      settings.set('skipDownloaded', mode)
      expect(await downloadRecord.checkDeduplication(r)).toBe(false)
    }
    for (const mode of ['record', 'both'] as const) {
      settings.set('skipDownloaded', mode)
      expect(await downloadRecord.checkDeduplication(r)).toBe(true)
    }
  })

  it('命名規則改了仍認 id（不重下）', async () => {
    const r = file('patreon/u1/999#0')
    await downloadRecord.addRecord(r)
    settings.set('namingRule', '{post_id}/{index}.{ext}')
    expect(await downloadRecord.checkDeduplication(r)).toBe(true)
  })

  it('發布日期變了視為新檔', async () => {
    const r = file('patreon/u1/999#0')
    await downloadRecord.addRecord(r)
    expect(
      await downloadRecord.checkDeduplication(
        file('patreon/u1/999#0', { published: '2024-02-02T00:00:00' })
      )
    ).toBe(false)
  })

  it('hasPost：檔齊才算整帖下完（檔名集合比對）', async () => {
    const r0 = file('patreon/u1/999#0')
    const r1 = file('patreon/u1/999#1', { fileIndex: 1, fileName: '2.png' })
    const { fileName } = await import('../src/filename/FileName')
    const n0 = fileName.createFileName(r0)
    const n1 = fileName.createFileName(r1)
    const published = '2024-01-02T03:04:05'
    await downloadRecord.addRecord(r0)
    expect(
      await downloadRecord.hasPost('patreon/u1/999', published, [n0, n1])
    ).toBe(false)
    await downloadRecord.addRecord(r1)
    expect(
      await downloadRecord.hasPost('patreon/u1/999', published, [n0, n1])
    ).toBe(true)
    expect(await downloadRecord.hasPost('patreon/u1/999', published, [])).toBe(
      false
    )
    // 發布日期變了：舊記錄不算數
    expect(
      await downloadRecord.hasPost('patreon/u1/999', '2024-03-03T00:00:00', [
        n0,
        n1,
      ])
    ).toBe(false)
  })

  it('hasPost：只看數量，不比對檔名', async () => {
    const postKey = 'patreon/u1/999'
    const published = '2024-01-02T03:04:05'
    const r = file('patreon/u1/999#0')
    const { fileName } = await import('../src/filename/FileName')
    const name = fileName.createFileName(r)
    await downloadRecord.addRecord(r)

    expect(
      await downloadRecord.hasPost(postKey, published, ['other.png'])
    ).toBe(true)
    expect(await downloadRecord.hasPost(postKey, published, [name])).toBe(true)
    // 期望數量多於記錄數：不算整帖下完
    expect(
      await downloadRecord.hasPost(postKey, published, [name, 'other.png'])
    ).toBe(false)
  })

  it('hasPost：新增記錄後索引會更新', async () => {
    const postKey = 'patreon/u1/999'
    const published = '2024-01-02T03:04:05'
    const r0 = file('patreon/u1/999#0')
    const r1 = file('patreon/u1/999#1', { fileIndex: 1, fileName: '2.png' })
    const { fileName } = await import('../src/filename/FileName')
    const n0 = fileName.createFileName(r0)
    const n1 = fileName.createFileName(r1)
    await downloadRecord.addRecord(r0)
    expect(await downloadRecord.hasPost(postKey, published, [n0, n1])).toBe(
      false
    )
    await downloadRecord.addRecord(r1)
    expect(await downloadRecord.hasPost(postKey, published, [n0, n1])).toBe(
      true
    )
  })

  it('切換 textContent 後不位移誤判（形狀變了退回檔名比對）', async () => {
    settings.set('textContent', 'txt')
    const r = file('patreon/u1/999#0')
    await downloadRecord.addRecord(r)
    // 同形狀：認 id，通過
    expect(await downloadRecord.checkDeduplication(r)).toBe(true)
    // 切換形狀：退回檔名比對，同名仍判重複（不誤判新檔）
    settings.set('textContent', 'none')
    expect(await downloadRecord.checkDeduplication(r)).toBe(true)
    // 檔名真變了（規則改了）才視為新檔
    settings.set(
      'namingRule',
      'kemono/{service}/{creator}-{creator_id}/{post_id}-{title}/x-{file_name}.{ext}'
    )
    expect(await downloadRecord.checkDeduplication(r)).toBe(false)
    settings.set('textContent', 'txt')
  })

  it('冷啟動併發 addRecord 不覆寫舊記錄', async () => {
    vi.resetModules()
    let resolveGet: (value: any) => void = () => {}
    const pendingGet = new Promise((resolve) => {
      resolveGet = resolve
    })
    const oldRecord = {
      id: 'patreon/u1/888#0',
      n: 'old.png',
      d: '2024-01-01T00:00:00',
    }
    ;(globalThis as any).chrome.storage.local.get = vi.fn(() => pendingGet)
    const { downloadRecord: fresh } =
      await import('../src/download/DownloadRecord')

    // 兩次呼叫在 storage 回傳前就開始，共用同一次載入
    const p1 = fresh.addRecord(file('patreon/u1/999#0'))
    const p2 = fresh.addRecord(file('patreon/u1/999#1', { fileIndex: 1 }))
    resolveGet({ pawchiveProDownloadRecord: { [oldRecord.id]: oldRecord } })
    await Promise.all([p1, p2])

    expect(await fresh.getRecord(oldRecord.id)).not.toBeNull()
    expect(await fresh.getRecord('patreon/u1/999#0')).not.toBeNull()
    expect(await fresh.getRecord('patreon/u1/999#1')).not.toBeNull()
    expect(await fresh.count()).toBe(3)
  })

  it('clear 清空', async () => {
    await downloadRecord.addRecord(file('patreon/u1/999#0'))
    expect(await downloadRecord.count()).toBe(1)
    await downloadRecord.clear(true)
    expect(await downloadRecord.count()).toBe(0)
  })
})

describe('downloadRecord across tabs', () => {
  const KEY = 'pawchiveProDownloadRecord'
  const rec = (id: string) => ({ id, n: `${id}.png`, d: '2024-01-02T03:04:05' })
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const settle = () => wait(300)

  let mem: Record<string, any>
  let changeListeners: Array<(changes: any, area: string) => void>
  let setCalls: Array<Record<string, any>>
  let active: number
  let maxActive: number
  let failNextSet: boolean
  let gate: Promise<void> | null

  /** The other tab writes straight into storage, bypassing this instance */
  function otherTabWrites(records: Record<string, any>) {
    mem[KEY] = records
  }
  function emitChange(newValue: unknown) {
    for (const fn of changeListeners) {
      fn({ [KEY]: { newValue } }, 'local')
    }
  }

  async function fresh() {
    vi.resetModules()
    const { downloadRecord: r } = await import('../src/download/DownloadRecord')
    const { settings: st } = await import('../src/setting/Settings')
    const { EVT: evt } = await import('../src/EVT')
    st.set('skipDownloaded', 'record')
    return { r, evt }
  }

  beforeEach(() => {
    mem = {}
    changeListeners = []
    setCalls = []
    active = 0
    maxActive = 0
    failNextSet = false
    gate = null
    const g = globalThis as any
    g.chrome.storage.onChanged = {
      addListener: (fn: any) => changeListeners.push(fn),
    }
    g.chrome.storage.local = {
      get: async (k: string) => {
        active++
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active--
        return k in mem ? { [k]: JSON.parse(JSON.stringify(mem[k])) } : {}
      },
      set: async (obj: Record<string, any>) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
          if (gate) await gate
          if (failNextSet) {
            failNextSet = false
            throw new Error('write failed')
          }
          setCalls.push(obj)
          Object.assign(mem, JSON.parse(JSON.stringify(obj)))
        } finally {
          active--
        }
      },
    }
  })

  it('keeps a record another tab wrote after our load, and ours too', async () => {
    const { r } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    await settle()
    otherTabWrites({ ...mem[KEY], 'patreon/u1/2#0': rec('patreon/u1/2#0') })
    await r.addRecord(file('patreon/u1/3#0'))
    await settle()
    expect(Object.keys(mem[KEY]).sort()).toEqual([
      'patreon/u1/1#0',
      'patreon/u1/2#0',
      'patreon/u1/3#0',
    ])
  })

  it('sees a record added by another tab after a storage change', async () => {
    const { r } = await fresh()
    const { fileName } = await import('../src/filename/FileName')
    const other = file('patreon/u1/2#0')
    expect(await r.checkDeduplication(other)).toBe(false)
    const stored = {
      [other.id]: {
        id: other.id,
        n: fileName.createFileName(other),
        d: other.published,
      },
    }
    otherTabWrites(stored)
    emitChange(stored)
    expect(await r.checkDeduplication(other)).toBe(true)
    expect(await r.hasPost('patreon/u1/2', other.published, ['x'])).toBe(true)
    // the change event itself must not write the record store
    await settle()
    expect(setCalls.filter((c) => KEY in c)).toHaveLength(0)
  })

  it('keeps unsaved local records when a storage change arrives', async () => {
    const { r } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    otherTabWrites({ 'patreon/u1/2#0': rec('patreon/u1/2#0') })
    emitChange(mem[KEY])
    expect(await r.count()).toBe(2)
    await settle()
    expect(Object.keys(mem[KEY]).sort()).toEqual([
      'patreon/u1/1#0',
      'patreon/u1/2#0',
    ])
  })

  it('ignores storage changes that arrive before the first load', async () => {
    let release: (v: any) => void = () => {}
    ;(globalThis as any).chrome.storage.local.get = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const { r } = await fresh()
    const first = r.count()
    emitChange({ 'patreon/u1/9#0': rec('patreon/u1/9#0') })
    release({ [KEY]: { 'patreon/u1/1#0': rec('patreon/u1/1#0') } })
    expect(await first).toBe(1)
    expect(setCalls.filter((c) => KEY in c)).toHaveLength(0)
  })

  it('clear really removes records, including ones another tab wrote', async () => {
    const { r } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    await settle()
    otherTabWrites({ ...mem[KEY], 'patreon/u1/2#0': rec('patreon/u1/2#0') })
    await r.clear(true)
    await settle()
    expect(mem[KEY]).toEqual({})
    expect(await r.count()).toBe(0)
  })

  it('records added after a clear are kept, cleared ones do not come back', async () => {
    const { r } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    await settle()
    await r.clear(true)
    await r.addRecord(file('patreon/u1/2#0'))
    await settle()
    expect(Object.keys(mem[KEY])).toEqual(['patreon/u1/2#0'])
    expect(await r.getRecord('patreon/u1/1#0')).toBeNull()
  })

  it('a clear during an in-flight write is not undone by it', async () => {
    const { r, evt } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    let open: () => void = () => {}
    gate = new Promise((resolve) => {
      open = resolve
    })
    evt.fire('downloadComplete')
    await wait(20)
    await r.clear(true)
    gate = null
    open()
    await settle()
    expect(mem[KEY]).toEqual({})
    expect(await r.count()).toBe(0)
  })

  it('import adds to the stored records instead of replacing them', async () => {
    const { r, evt } = await fresh()
    const { toast } = await import('../src/Toast')
    const { log } = await import('../src/Log')
    vi.spyOn(toast, 'show').mockImplementation(() => {})
    vi.spyOn(log, 'success').mockImplementation(() => {})
    await r.count()
    otherTabWrites({ 'patreon/u1/0#0': rec('patreon/u1/0#0') })

    // Drive the real import handler with a stubbed file picker and reader
    const doc = (globalThis as any).document
    const origCreate = doc.createElement
    const origReader = (globalThis as any).FileReader
    const picked: Record<string, () => void> = {}
    doc.createElement = () => ({
      files: [{}],
      addEventListener: (type: string, fn: () => void) => {
        picked[type] = fn
      },
      click: () => {},
    })
    ;(globalThis as any).FileReader = class {
      result = JSON.stringify([rec('patreon/u1/1#0'), rec('patreon/u1/2#0')])
      onload: () => void = () => {}
      readAsText() {
        this.onload()
      }
    }
    try {
      evt.fire('importDownloadRecord')
      picked.change()
      await settle()
    } finally {
      doc.createElement = origCreate
      ;(globalThis as any).FileReader = origReader
    }
    expect(Object.keys(mem[KEY]).sort()).toEqual([
      'patreon/u1/0#0',
      'patreon/u1/1#0',
      'patreon/u1/2#0',
    ])
    expect(await r.count()).toBe(3)
  })

  it('a record added while a write is in flight is not lost', async () => {
    const { r, evt } = await fresh()
    await r.addRecord(file('patreon/u1/1#0'))
    otherTabWrites({ 'patreon/u1/0#0': rec('patreon/u1/0#0') })
    let open: () => void = () => {}
    gate = new Promise((resolve) => {
      open = resolve
    })
    evt.fire('downloadComplete')
    await wait(20)
    // the first write is blocked; add another record meanwhile
    await r.addRecord(file('patreon/u1/2#0'))
    expect(await r.getRecord('patreon/u1/2#0')).not.toBeNull()
    gate = null
    open()
    await wait(20)
    expect(await r.getRecord('patreon/u1/2#0')).not.toBeNull()
    await settle()
    expect(Object.keys(mem[KEY]).sort()).toEqual([
      'patreon/u1/0#0',
      'patreon/u1/1#0',
      'patreon/u1/2#0',
    ])
    // read-merge-write cycles never overlap
    expect(maxActive).toBe(1)
  })

  it('a failed write keeps the pending records and retries on the next save', async () => {
    const { r, evt } = await fresh()
    await r.count()
    const { toast } = await import('../src/Toast')
    const err = vi.spyOn(toast, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    otherTabWrites({ 'patreon/u1/0#0': rec('patreon/u1/0#0') })
    await r.addRecord(file('patreon/u1/1#0'))
    failNextSet = true
    evt.fire('downloadComplete')
    await wait(20)
    expect(err).toHaveBeenCalledTimes(1)
    expect(Object.keys(mem[KEY])).toEqual(['patreon/u1/0#0'])
    // another tab saves meanwhile; the next save still carries our record
    otherTabWrites({ ...mem[KEY], 'patreon/u1/2#0': rec('patreon/u1/2#0') })
    await r.addRecord(file('patreon/u1/3#0'))
    await settle()
    expect(Object.keys(mem[KEY]).sort()).toEqual([
      'patreon/u1/0#0',
      'patreon/u1/1#0',
      'patreon/u1/2#0',
      'patreon/u1/3#0',
    ])
  })
})
