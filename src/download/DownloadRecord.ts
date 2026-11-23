/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/download/DownloadRecord.ts
 *          record shape + export/import/clear concept
 *          (xuejianxianzun)
 * changes: schema redesigned — single chrome.storage.local
 *          store keyed by per-file result id (`${postKey}#${index}`);
 *          no ID-shard stores (PBD's 9 numeric shards don't fit Kemono
 *          string keys), no IndexedDB (records are small). d = published
 *          date; matching is by id only (the old strict mode was dropped).
 *          Replaces the earlier DownloadedKeys store (deleted).
 */

import { EVT } from '../EVT'
import { fileName } from '../filename/FileName'
import { lang } from '../Language'
import { log } from '../Log'
import { settings } from '../setting/Settings'
import { skipByRecord } from '../setting/skipMode'
import { Result } from '../store/StoreType'
import { toast } from '../Toast'

const STORE_KEY = 'pawchiveProDownloadRecord'
/** Quiet time after the last new record before it is written */
const SAVE_DEBOUNCE_MS = 200
/** Longest a new record waits for its write while more keep arriving */
const SAVE_MAX_WAIT_MS = 2000

/** 單條下載記錄：{id 檔 id, n 檔名, d 發布日期, s 展開形狀指紋} */
export interface RecordItem {
  id: string
  n: string
  d: string
  /** 展開形狀指紋（textContent|noCoverFile）。缺失的舊記錄視為形狀未知，
   * 查詢時走檔名比對，切換設定後不會位移誤判 */
  s?: string
  /** Identity of the file inside its post: a short hash of the file URL path
   * ('#text' for the text file). Unlike the id it does not move when the
   * expand shape changes the file indices. Missing on older records. */
  p?: string
}

/** FNV-1a 32-bit hash in base 36: short and stable, for the file identity */
function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Identity of a result's file inside its post (see RecordItem.p). The host
 * and the thumbnail/data prefix are dropped: the same file can be reached
 * through several file servers and as a thumbnail. */
function fileIdentity(result: Pick<Result, 'kind' | 'fileUrl'>): string {
  if (result.kind === 'text') {
    return '#text'
  }
  let path = result.fileUrl
  try {
    path = new URL(result.fileUrl).pathname
  } catch {
    // Not an absolute URL: hash it as it is
  }
  path = path.replace(/^\/thumbnail(?=\/)/, '').replace(/^\/data(?=\/)/, '')
  return shortHash(path)
}

class DownloadRecord {
  constructor() {
    this.bindEvents()
  }

  private records: Record<string, RecordItem> = {}
  /** Records added or updated in this tab that are not in storage yet. The
   * content script runs once per tab, so a save must merge these into what
   * storage holds now instead of overwriting it with this tab's snapshot. */
  private pending = new Map<string, RecordItem>()
  /** A clear is waiting to be written: the next save starts from {} rather
   * than from the stored records, so cleared records are not merged back. */
  private resetPending = false
  /** postKey → 該帖記錄的索引（hasPost 用，避免每帖全表掃描） */
  private postIndex: Map<string, RecordItem[]> | null = null
  private loadPromise: Promise<void> | null = null
  /** The first load finished; storage change events are ignored before it. */
  private loaded = false
  private saveTimer = 0
  /** Writes are chained so that two read-merge-write cycles never overlap. */
  private writeChain: Promise<void> = Promise.resolve()

  /** 單例門：冷啟動時併發呼叫共用同一次載入，避免後寫入的記錄被讀回的舊資料覆寫 */
  private load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const data = await chrome.storage.local.get(STORE_KEY)
          const saved = data[STORE_KEY] as
            Record<string, RecordItem> | undefined
          if (saved && typeof saved === 'object') {
            this.records = { ...saved, ...Object.fromEntries(this.pending) }
            this.postIndex = null
          }
        } catch (e) {
          console.error('[PawchivePro] load download record failed', e)
        } finally {
          this.loaded = true
        }
      })()
    }
    return this.loadPromise
  }

  /** When the oldest unsaved record must be written at the latest (0 = none) */
  private saveDeadline = 0

  /** Debounced, but never put off past SAVE_MAX_WAIT_MS: files that finish in
   * quick succession would otherwise keep pushing the save back, and closing
   * the tab would lose every record since the last write. */
  private scheduleSave(): void {
    const now = Date.now()
    if (this.saveDeadline === 0) {
      this.saveDeadline = now + SAVE_MAX_WAIT_MS
    }
    const delay = Math.max(
      0,
      Math.min(SAVE_DEBOUNCE_MS, this.saveDeadline - now)
    )
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.persist(), delay)
  }

  /** 寫入失敗時只提醒一次，避免每個檔案都跳 toast */
  private saveFailedNotified = false

  /** Add or update one record: it is kept in memory and queued for the next
   * merge-save. */
  private setRecord(item: RecordItem): void {
    this.records[item.id] = item
    this.pending.set(item.id, item)
    this.indexRecord(item)
  }

  /** Keep the post index current without rebuilding it: a batch adds a record
   * per file and every one would otherwise throw the whole index away. */
  private indexRecord(item: RecordItem): void {
    if (!this.postIndex) {
      return
    }
    const hash = item.id.lastIndexOf('#')
    if (hash < 0) {
      return
    }
    const postKey = item.id.slice(0, hash)
    const list = this.postIndex.get(postKey)
    if (!list) {
      this.postIndex.set(postKey, [item])
      return
    }
    const at = list.findIndex((r) => r.id === item.id)
    if (at >= 0) {
      list[at] = item
    } else {
      list.push(item)
    }
  }

  private persist(): void {
    this.saveDeadline = 0
    const run = this.writeChain.then(() => this.write())
    this.writeChain = run
  }

  /** Read-merge-write: other tabs may have saved records since this tab
   * loaded, so merge this tab's unsaved records into the stored ones. After
   * a clear the stored records are discarded instead. */
  private async write(): Promise<void> {
    const reset = this.resetPending
    this.resetPending = false
    const snapshot = new Map(this.pending)
    if (!reset && snapshot.size === 0) {
      return
    }
    try {
      let base: Record<string, RecordItem> = {}
      if (!reset) {
        const data = await chrome.storage.local.get(STORE_KEY)
        const stored = data[STORE_KEY] as Record<string, RecordItem> | undefined
        if (stored && typeof stored === 'object') {
          base = stored
        }
      }
      const merged = { ...base, ...Object.fromEntries(snapshot) }
      await chrome.storage.local.set({ [STORE_KEY]: merged })
      // An entry updated while the write was in flight stays pending
      for (const [id, item] of snapshot) {
        if (this.pending.get(id) === item) {
          this.pending.delete(id)
        }
      }
      // A clear during the write means the merged records are already stale
      this.records = {
        ...(this.resetPending ? {} : merged),
        ...Object.fromEntries(this.pending),
      }
      this.postIndex = null
      this.saveFailedNotified = false
    } catch (e) {
      if (reset) {
        this.resetPending = true
      }
      console.error('[PawchivePro] save record failed', e)
      if (!this.saveFailedNotified) {
        this.saveFailedNotified = true
        const msg = lang.transl('_recordStoreFailed')
        log.error(msg)
        toast.error(msg)
      }
    }
  }

  /** Another tab (or this one) changed the stored records: follow it, keeping
   * this tab's unsaved records on top. Never writes. */
  private onStorageChanged(newValue: unknown): void {
    if (!this.loaded) {
      return
    }
    const stored =
      newValue && typeof newValue === 'object'
        ? (newValue as Record<string, RecordItem>)
        : {}
    this.records = { ...stored, ...Object.fromEntries(this.pending) }
    this.postIndex = null
  }

  /** 由抓取結果生成一條記錄 */
  private createRecord(result: Result): RecordItem {
    return {
      id: result.id,
      n: fileName.createFileName(result),
      d: result.published,
      s: this.expandShape(),
      p: fileIdentity(result),
    }
  }

  /** 展開形狀指紋：影響附件序號的兩個開關。序號變了舊記錄的位置鍵
   * 就不再可信，查詢時必須改走檔名比對 */
  private expandShape(): string {
    return `${settings.get('textContent')}|${settings.get('noCoverFile') ? 1 : 0}`
  }

  /** 下載成功後登記（記憶體同步寫入，storage 防抖持久化） */
  public async addRecord(result: Result): Promise<void> {
    await this.load()
    this.setRecord(this.createRecord(result))
    this.scheduleSave()
  }

  public async getRecord(id: string): Promise<RecordItem | null> {
    await this.load()
    return this.records[id] ?? null
  }

  /** 檢查單檔是否重複。true = 跳過 */
  public async checkDeduplication(result: Result): Promise<boolean> {
    // 未啟用「按下載記錄跳過」直接放行
    if (!skipByRecord(settings.get('skipDownloaded'))) {
      return false
    }

    const record = await this.getRecord(result.id)

    // Same expand shape: the id (post + file index) still points at the same
    // file. A changed publish date means a new file.
    if (record !== null && record.s === this.expandShape()) {
      // 只認 id（命名規則改了也不重下）
      return record.d === result.published
    }

    // The shape changed (or the record predates the fingerprint): file
    // indices moved, so the record under this id may belong to another file,
    // and this file's record may sit under another index. Look through the
    // records of the same post instead.
    return this.matchInPost(result)
  }

  /**
   * Is this file recorded under another index of its post? Matches by file
   * identity (and publish date); records that predate the identity fall back
   * to comparing the generated file name.
   */
  private matchInPost(result: Result): boolean {
    // The index is keyed by the id prefix, which is the post key
    const hash = result.id.lastIndexOf('#')
    const siblings =
      hash < 0 ? undefined : this.buildPostIndex().get(result.id.slice(0, hash))
    if (!siblings) {
      return false
    }
    const identity = fileIdentity(result)
    let name: string | undefined
    for (const r of siblings) {
      if (r.d !== result.published) {
        continue
      }
      if (r.p !== undefined) {
        if (r.p === identity) {
          return true
        }
        continue
      }
      name ??= fileName.createFileName(result)
      if (r.n === name) {
        return true
      }
    }
    return false
  }

  /** 建立 postKey → 記錄列表的索引（只建一次，記錄異動時作廢） */
  private buildPostIndex(): Map<string, RecordItem[]> {
    if (this.postIndex) {
      return this.postIndex
    }
    const index = new Map<string, RecordItem[]>()
    for (const key of Object.keys(this.records)) {
      const hash = key.lastIndexOf('#')
      if (hash < 0) {
        continue
      }
      const postKey = key.slice(0, hash)
      const list = index.get(postKey)
      if (list) {
        list.push(this.records[key])
      } else {
        index.set(postKey, [this.records[key]])
      }
    }
    this.postIndex = index
    return index
  }

  /** 整帖是否已下完：同帖同日期的記錄數量足夠即可，不比對檔名 */
  public async hasPost(
    postKey: string,
    published: string,
    expectedCount: number
  ): Promise<boolean> {
    await this.load()
    if (expectedCount <= 0) {
      return false
    }
    let matched = 0
    for (const r of this.buildPostIndex().get(postKey) ?? []) {
      if (r.d === published) {
        matched++
      }
    }
    return matched > 0 && matched >= expectedCount
  }

  public async count(): Promise<number> {
    await this.load()
    return Object.keys(this.records).length
  }

  public async clear(silent = false): Promise<void> {
    await this.load()
    // Removal path: drop unsaved records too and write exactly {} next save
    this.records = {}
    this.pending.clear()
    this.resetPending = true
    this.postIndex = null
    this.scheduleSave()
    // 不在此 fire clearDownloadRecord：監聽器會再調 clear()，造成無限遞迴
    if (!silent) {
      toast.show(lang.transl('_recordCleared'))
      log.warning(lang.transl('_recordCleared'))
    }
  }

  private downloadJson(filename: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  private bindEvents() {
    // Records saved by other tabs show up without a reload
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !(STORE_KEY in changes)) {
        return
      }
      this.onStorageChanged(changes[STORE_KEY].newValue)
    })

    // 下載完成即時落盤，避免防抖窗口內關頁面丟失尾部記錄
    // A paused or stopped batch is also a moment the tab may get closed
    const flushEvents = [
      EVT.list.downloadComplete,
      EVT.list.downloadPause,
      EVT.list.downloadStop,
    ]
    flushEvents.forEach((evt) => {
      EVT.on(evt, () => {
        window.clearTimeout(this.saveTimer)
        this.persist()
      })
    })

    EVT.on(EVT.list.exportDownloadRecord, () => {
      void (async () => {
        await this.load()
        this.downloadJson(
          `pawchive-record-${Date.now()}.json`,
          Object.values(this.records)
        )
        toast.show(
          lang.transl(
            '_recordExported',
            String(Object.keys(this.records).length)
          )
        )
      })()
    })

    EVT.on(EVT.list.importDownloadRecord, () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) {
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          void (async () => {
            try {
              const list = JSON.parse(reader.result as string) as RecordItem[]
              if (!Array.isArray(list)) {
                throw new Error('not an array')
              }
              await this.load()
              let n = 0
              for (const r of list) {
                if (r && typeof r.id === 'string') {
                  // Import only adds to the existing records
                  this.setRecord({
                    id: r.id,
                    n: String(r.n ?? ''),
                    d: String(r.d ?? ''),
                    s: typeof r.s === 'string' ? r.s : undefined,
                    p: typeof r.p === 'string' ? r.p : undefined,
                  })
                  n++
                }
              }
              this.scheduleSave()
              toast.show(lang.transl('_recordImported', String(n)))
              log.success(lang.transl('_recordImported', String(n)))
            } catch {
              toast.error(lang.transl('_recordImportFailed'))
            }
          })()
        }
        reader.readAsText(file)
      })
      input.click()
    })

    EVT.on(EVT.list.clearDownloadRecord, () => {
      void this.clear()
    })
  }
}

const downloadRecord = new DownloadRecord()
export { downloadRecord }
