/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/download/DownloadRecord.ts
 *          record shape + export/import/clear concept
 *          (xuejianxianzun)
 * changes: schema redesigned — chrome.storage.local records keyed by
 *          per-file result id (`${postKey}#${index}`), spread over 64
 *          shard keys by a hash of the post key (PBD's 9 numeric ID shards
 *          don't fit Kemono string keys); no IndexedDB (not shared between
 *          the Kemono and Pawchive origins). d = published
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

/** The records before they were split into shards (read once to migrate) */
const LEGACY_KEY = 'pawchiveProDownloadRecord'
/** Records are spread over this many storage keys by a hash of the post key,
 * so a save rewrites only the shards it touched and the change event other
 * tabs get carries only those shards. */
export const SHARD_COUNT = 64
const SHARD_KEYS = Array.from(
  { length: SHARD_COUNT },
  (_, i) => `${LEGACY_KEY}:${String(i).padStart(2, '0')}`
)
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

/** FNV-1a 32-bit hash */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The hash in base 36: short and stable, for the file identity */
function shortHash(text: string): string {
  return fnv1a(text).toString(36)
}

/** The post key of a record id (`${postKey}#${index}`), or null */
function postKeyOf(id: string): string | null {
  const hash = id.lastIndexOf('#')
  return hash < 0 ? null : id.slice(0, hash)
}

/** Shard of a post: every record of a post lives in the same shard */
function shardOfPost(postKey: string): number {
  return fnv1a(postKey) % SHARD_COUNT
}

/** Shard of a record id (an id without a post key is hashed whole) */
export function shardOf(id: string): number {
  return shardOfPost(postKeyOf(id) ?? id)
}

/** Storage key of the shard that holds `id` */
export function shardKeyOf(id: string): string {
  return SHARD_KEYS[shardOf(id)]
}

/** Shard number of a storage key, or -1 when it is not a shard key */
function shardOfKey(key: string): number {
  return SHARD_KEYS.indexOf(key)
}

type RecordMap = Record<string, RecordItem>

/** A stored record map, or null when the value is not one */
function asRecordMap(value: unknown): RecordMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordMap)
    : null
}

/** Split records by shard */
function groupByShard(items: Iterable<RecordItem>): Map<number, RecordMap> {
  const out = new Map<number, RecordMap>()
  for (const item of items) {
    const shard = shardOf(item.id)
    let map = out.get(shard)
    if (!map) {
      map = {}
      out.set(shard, map)
    }
    map[item.id] = item
  }
  return out
}

const emptyShards = (): RecordMap[] =>
  Array.from({ length: SHARD_COUNT }, () => ({}))

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

  /** In-memory copy of every shard: stored records plus this tab's pending */
  private shards: RecordMap[] = emptyShards()
  /** Records added or updated in this tab that are not in storage yet. The
   * content script runs once per tab, so a save must merge these into what
   * storage holds now instead of overwriting it with this tab's snapshot. */
  private pending = new Map<string, RecordItem>()
  /** A clear is waiting to be written: the next save starts every shard from
   * {} rather than from the stored records, so cleared records are not merged
   * back. */
  private resetPending = false
  /** Per shard: postKey → the post's records (for hasPost and matchInPost,
   * so a post does not scan every record). Built lazily, dropped when its
   * shard is replaced. */
  private postIndexes: Array<Map<string, RecordItem[]> | null> = new Array(
    SHARD_COUNT
  ).fill(null)
  private loadPromise: Promise<void> | null = null
  /** The first load finished; storage change events are ignored before it. */
  private loaded = false
  private saveTimer = 0
  /** Writes are chained so that two read-merge-write cycles never overlap. */
  private writeChain: Promise<void> = Promise.resolve()

  /** This tab's pending records that belong to `shard` */
  private pendingIn(shard: number): RecordMap {
    const out: RecordMap = {}
    for (const [id, item] of this.pending) {
      if (shardOf(id) === shard) {
        out[id] = item
      }
    }
    return out
  }

  /** Replace one shard in memory; this tab's pending records stay on top */
  private setShard(shard: number, stored: RecordMap): void {
    this.shards[shard] = { ...stored, ...this.pendingIn(shard) }
    this.postIndexes[shard] = null
  }

  /** 單例門：冷啟動時併發呼叫共用同一次載入，避免後寫入的記錄被讀回的舊資料覆寫 */
  private load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const data = await chrome.storage.local.get([
            ...SHARD_KEYS,
            LEGACY_KEY,
          ])
          // Records not migrated yet sit under the shards: the shards are newer
          const legacy = asRecordMap(data[LEGACY_KEY])
          const fromLegacy = groupByShard(Object.values(legacy ?? {}))
          for (let i = 0; i < SHARD_COUNT; i++) {
            this.setShard(i, {
              ...fromLegacy.get(i),
              ...asRecordMap(data[SHARD_KEYS[i]]),
            })
          }
          if (legacy) {
            this.writeChain = this.writeChain.then(() => this.migrate())
          }
        } catch (e) {
          console.error('[Better Pawchive] load download record failed', e)
        } finally {
          this.loaded = true
        }
      })()
    }
    return this.loadPromise
  }

  /** Move the records from the old single key into the shards. The old key
   * is removed only after the shards read back with every record in them; a
   * failure leaves it for the next load. Two tabs migrating at once is fine:
   * each merges the old records under what the shards hold. */
  private async migrate(): Promise<void> {
    try {
      const data = await chrome.storage.local.get([...SHARD_KEYS, LEGACY_KEY])
      const legacy = asRecordMap(data[LEGACY_KEY])
      if (!legacy) {
        // Another tab finished it, or a clear removed it
        return
      }
      const out: Record<string, RecordMap> = {}
      for (const [shard, items] of groupByShard(Object.values(legacy))) {
        const key = SHARD_KEYS[shard]
        out[key] = { ...items, ...asRecordMap(data[key]) }
      }
      await chrome.storage.local.set(out)
      const check = await chrome.storage.local.get(Object.keys(out))
      const missing = Object.keys(legacy).find(
        (id) => !(id in (asRecordMap(check[shardKeyOf(id)]) ?? {}))
      )
      if (missing !== undefined) {
        throw new Error(`record ${missing} did not reach its shard`)
      }
      await chrome.storage.local.remove(LEGACY_KEY)
    } catch (e) {
      console.error('[Better Pawchive] migrate download record failed', e)
    }
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
    this.shards[shardOf(item.id)][item.id] = item
    this.pending.set(item.id, item)
    this.indexRecord(item)
  }

  /** Keep the post index current without rebuilding it: a batch adds a record
   * per file and every one would otherwise throw the whole index away. */
  private indexRecord(item: RecordItem): void {
    const postKey = postKeyOf(item.id)
    const index = this.postIndexes[shardOf(item.id)]
    if (postKey === null || !index) {
      return
    }
    const list = index.get(postKey)
    if (!list) {
      index.set(postKey, [item])
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

  /** Read-merge-write of the shards this tab has pending records in: other
   * tabs may have saved records since this tab loaded, so merge into the
   * stored ones. After a clear every shard is written from {} instead (and
   * the old single key, if still there, is removed). */
  private async write(): Promise<void> {
    const reset = this.resetPending
    this.resetPending = false
    const snapshot = new Map(this.pending)
    if (!reset && snapshot.size === 0) {
      return
    }
    try {
      const changed = groupByShard(snapshot.values())
      const targets = reset ? SHARD_KEYS.map((_, i) => i) : [...changed.keys()]
      const stored: Record<string, unknown> = reset
        ? {}
        : await chrome.storage.local.get(targets.map((i) => SHARD_KEYS[i]))
      const out: Record<string, RecordMap> = {}
      for (const shard of targets) {
        const key = SHARD_KEYS[shard]
        out[key] = { ...asRecordMap(stored[key]), ...changed.get(shard) }
      }
      await chrome.storage.local.set(out)
      if (reset) {
        await chrome.storage.local.remove(LEGACY_KEY)
      }
      // An entry updated while the write was in flight stays pending
      for (const [id, item] of snapshot) {
        if (this.pending.get(id) === item) {
          this.pending.delete(id)
        }
      }
      // A clear during the write means the merged records are already stale
      const cleared = this.resetPending
      for (const shard of targets) {
        this.setShard(shard, cleared ? {} : out[SHARD_KEYS[shard]])
      }
      this.saveFailedNotified = false
    } catch (e) {
      if (reset) {
        this.resetPending = true
      }
      console.error('[Better Pawchive] save record failed', e)
      if (!this.saveFailedNotified) {
        this.saveFailedNotified = true
        const msg = lang.transl('_recordStoreFailed')
        log.error(msg)
        toast.error(msg)
      }
    }
  }

  /** Another tab (or this one) changed stored shards: follow them, keeping
   * this tab's unsaved records on top. Never writes. */
  private onStorageChanged(
    changes: Record<string, chrome.storage.StorageChange>
  ): void {
    if (!this.loaded) {
      return
    }
    for (const [key, change] of Object.entries(changes)) {
      const shard = shardOfKey(key)
      if (shard >= 0) {
        this.setShard(shard, asRecordMap(change.newValue) ?? {})
      }
    }
  }

  /** Every record (stored and pending), across all shards */
  private allRecords(): RecordItem[] {
    return this.shards.flatMap((s) => Object.values(s))
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
    return this.shards[shardOf(id)][id] ?? null
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
    const postKey = postKeyOf(result.id)
    const siblings = postKey === null ? undefined : this.postRecords(postKey)
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

  /** The records of one post, from its shard's post index (built on first
   * use, dropped when the shard is replaced) */
  private postRecords(postKey: string): RecordItem[] | undefined {
    const shard = shardOfPost(postKey)
    let index = this.postIndexes[shard]
    if (!index) {
      index = new Map()
      for (const item of Object.values(this.shards[shard])) {
        const key = postKeyOf(item.id)
        if (key === null) {
          continue
        }
        const list = index.get(key)
        if (list) {
          list.push(item)
        } else {
          index.set(key, [item])
        }
      }
      this.postIndexes[shard] = index
    }
    return index.get(postKey)
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
    for (const r of this.postRecords(postKey) ?? []) {
      if (r.d === published) {
        matched++
      }
    }
    return matched > 0 && matched >= expectedCount
  }

  public async count(): Promise<number> {
    await this.load()
    return this.shards.reduce((n, s) => n + Object.keys(s).length, 0)
  }

  public async clear(silent = false): Promise<void> {
    await this.load()
    // Removal path: drop unsaved records too and write exactly {} next save
    this.pending.clear()
    for (let i = 0; i < SHARD_COUNT; i++) {
      this.setShard(i, {})
    }
    this.resetPending = true
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
    // The anchor stays detached: nothing is added to the page DOM, so the
    // page cannot observe the blob URL or the click.
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  private bindEvents() {
    // Records saved by other tabs show up without a reload
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local') {
        this.onStorageChanged(changes)
      }
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
        // Same file format as before the shards: one flat array of records
        const all = this.allRecords()
        this.downloadJson(`pawchive-record-${Date.now()}.json`, all)
        toast.show(lang.transl('_recordExported', String(all.length)))
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
