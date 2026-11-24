/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * 抓取快取：crawlComplete 有結果時自動把本輪 store 快照一筆
 * （chrome.storage.local 持久化），用戶可稍後從抓取頁的快取列表「掛載」並下載。
 * 動機：新一輪抓取的 crawlStart 會清空 store，快取是那之前的逃生艙。
 * 掛載＝把某筆快取載入 store 當作目前下載目標；開始下載由用戶到下載頁手動按。
 * 本模組同時擁有「抓取完成後要不要掛載新結果」的決定權。
 */

import { downloadControl } from './DownloadControl'
import { downloadStates } from './DownloadStates'
import { progressBar } from './ProgressBar'
import { EVT } from '../EVT'
import { lang } from '../Language'
import { log } from '../Log'
import { settings } from '../setting/Settings'
import { store } from '../store/Store'
import { states } from '../store/States'
import type { Result } from '../store/StoreType'
import { toast } from '../Toast'

/** All entries in one array, before the index/body split (read to migrate) */
const LEGACY_KEY = 'pawchiveProCrawlCache'
/** The ordered entry summaries (no result arrays) */
const INDEX_KEY = 'pawchiveProCrawlCache:index'
/** One key per entry for its result arrays, so saving or renaming one entry
 * never rewrites the others and listing them never reads the arrays */
const BODY_PREFIX = 'pawchiveProCrawlCache:entry:'
const bodyKey = (id: string) => BODY_PREFIX + id

/** 快取上限筆數（大創作者單筆就可能很大） */
const MAX_ENTRIES = 20

export interface CacheEntry {
  id: string
  /** 可改名；預設創作者名 */
  title: string
  service: string
  creatorId: string
  creator: string
  host: string
  postCount: number
  fileCount: number
  createdAt: number
  /** Saved from a crawl that lost posts or was cut short */
  incomplete?: boolean
  results: Result[]
  metas: Result[]
}

/** 不含大陣列的快取摘要（給 UI 頻繁刷新用，避免深拷貝整批結果） */
export type CacheSummary = Omit<CacheEntry, 'results' | 'metas'>

/** The result arrays of an entry, stored under its own key */
export type CacheBody = Pick<CacheEntry, 'results' | 'metas'>

function toSummary(entry: CacheEntry): CacheSummary {
  const { results: _r, metas: _m, ...summary } = entry
  return summary
}

/** Keep only well-formed full entries (the old single-key format) */
function normalizeEntries(saved: unknown): CacheEntry[] {
  if (!Array.isArray(saved)) {
    return []
  }
  return saved.filter(
    (e): e is CacheEntry =>
      !!e && typeof e.id === 'string' && Array.isArray(e.results)
  )
}

/** Keep only well-formed summaries from whatever storage returned */
function normalizeSummaries(saved: unknown): CacheSummary[] {
  if (!Array.isArray(saved)) {
    return []
  }
  return saved
    .filter(
      (e): e is CacheSummary =>
        !!e && typeof e === 'object' && typeof e.id === 'string'
    )
    .map((e) => toSummary(e as CacheEntry))
}

function normalizeBody(saved: unknown): CacheBody | null {
  const b = saved as Partial<CacheBody> | null | undefined
  if (!b || !Array.isArray(b.results)) {
    return null
  }
  return { results: b.results, metas: Array.isArray(b.metas) ? b.metas : [] }
}

/** Merge this tab's changes into the entries another tab may have saved.
 * Start from the stored list, drop deleted ids, let each dirty local entry
 * replace its stored copy (or be inserted), order newest first by createdAt
 * (a stable sort: ties keep dirty local entries ahead of stored ones) and
 * drop the oldest beyond MAX_ENTRIES. */
export function mergeEntries<T extends CacheSummary>(
  stored: T[],
  local: T[],
  dirtyIds: ReadonlySet<string>,
  deletedIds: ReadonlySet<string>
): T[] {
  const dirtyLocal = local.filter(
    (e) => dirtyIds.has(e.id) && !deletedIds.has(e.id)
  )
  const dirtyById = new Map(dirtyLocal.map((e) => [e.id, e]))
  const keptStored = stored.filter(
    (e) => !deletedIds.has(e.id) && !dirtyById.has(e.id)
  )
  return [...dirtyLocal, ...keptStored]
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, MAX_ENTRIES)
}

/** 目前掛載狀態：entry 為已存入快取的那筆；unsaved＝store 裡是沒進快取的結果 */
export interface MountedInfo {
  entry: CacheSummary | null
  unsaved: boolean
}

class CrawlCache {
  /** Entry summaries, newest first; the result arrays stay in storage */
  private entries: CacheSummary[] = []
  /** Result arrays held in memory: entries not written yet, and entries of
   * the old format until the migration is written */
  private bodies = new Map<string, CacheBody>()
  /** The old single key was found and is not migrated yet */
  private legacyPending = false
  private loadPromise: Promise<void> | null = null
  private saveTimer = 0
  /** The first load finished; storage change events are ignored before it */
  private loaded = false
  /** Entries added or modified in this tab since the last successful write */
  private dirtyIds = new Set<string>()
  /** Entries deleted in this tab since the last successful write */
  private deletedIds = new Set<string>()
  /** Ids touched since the current write began: they stay dirty/deleted */
  private touchedIds = new Set<string>()
  /** Writes are chained so that two read-merge-write cycles never overlap */
  private writeChain: Promise<void> = Promise.resolve()
  /** 目前掛載的快取 id */
  private mountedId: string | null = null
  /** store 裡的結果沒有對應快取（單帖快抓、中途停止、快取已滿） */
  private mountedUnsaved = false
  /** crawlStart 前掛載的快取 id：不自動掛載新結果時要還原它 */
  private prevMountedId: string | null = null

  constructor() {
    this.bindEvents()
    void this.ensureLoaded()
  }

  private bindEvents() {
    // Entries saved or deleted by other tabs show up without a reload
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !(INDEX_KEY in changes) || !this.loaded) {
        return
      }
      this.applyEntries(
        mergeEntries(
          normalizeSummaries(changes[INDEX_KEY].newValue),
          this.entries,
          this.dirtyIds,
          this.deletedIds
        )
      )
    })

    // 新一輪抓取會清空 store，原本掛載的結果隨之消失
    EVT.on(EVT.list.crawlStart, () => {
      if (this.mountedId) {
        this.prevMountedId = this.mountedId
      }
      this.mountedId = null
      this.mountedUnsaved = false
      this.fireMountChange(false)
    })
    EVT.on(EVT.list.crawlComplete, () => {
      // quickCrawl／stopCrawl 必須在任何 await 之前同步擷取：之後旗標可能已被下一輪改寫
      void this.onCrawlComplete(states.quickCrawl, states.stopCrawl)
    })
  }

  private fireMountChange(manual: boolean): void {
    EVT.fire('mountChange', { manual })
  }

  /** 抓取完成：先存快取，再決定新結果要不要掛載，最後交還給下載流程 */
  private async onCrawlComplete(
    quick: boolean,
    stopped: boolean
  ): Promise<void> {
    const autoMount = settings.get('autoMountCache')
    const prevId = this.prevMountedId
    this.prevMountedId = null
    // 不自動掛載時由這裡提示「未掛載」，autoSave 不重複彈 toast
    const entry = await this.autoSave({ quick, stopped, silent: !autoMount })

    if (store.result.length === 0) {
      // 這輪什麼都沒抓到：還原原本掛載的快取，不要讓下載區平白變空
      const prev = prevId ? await this.loadEntry(prevId) : null
      if (prev) {
        this.applyToStore(prev.results, prev.metas, prev.title, true)
        this.mountedId = prev.id
        this.mountedUnsaved = false
        this.fireMountChange(false)
        // 不走 readyDownload：那會對還原的快取自動開始下載
        downloadControl.drainAfterCrawl()
        return
      }
      this.mountedId = null
      this.mountedUnsaved = false
      this.fireMountChange(false)
      // 空結果的收尾（收進度條、排下一輪）交給 DownloadControl
      downloadControl.readyDownload()
      return
    }

    if (entry && !autoMount) {
      // 新結果只留在快取：還原原本掛載的快取，沒有就清空下載區
      const prev = prevId ? await this.loadEntry(prevId) : null
      if (prev) {
        this.applyToStore(prev.results, prev.metas, prev.title, true)
        this.mountedId = prev.id
      } else {
        this.applyToStore([], [], document.title, true)
        this.mountedId = null
      }
      this.mountedUnsaved = false
      this.fireMountChange(false)
      toast.show(lang.transl('_cacheSavedNotMounted', entry.title))
      downloadControl.drainAfterCrawl()
      return
    }

    // 自動掛載，或結果沒能存進快取（一律直接掛載避免遺失）：store 已是這批結果
    this.mountedId = entry?.id ?? null
    this.mountedUnsaved = !entry
    this.fireMountChange(false)
    downloadControl.readyDownload()
  }

  /** 把一批結果換進 store（深拷貝）並重建下載狀態；keepQueue 時保留等待中的抓取任務 */
  private applyToStore(
    results: Result[],
    metas: Result[],
    title: string,
    keepQueue: boolean
  ): void {
    const r: Result[] = JSON.parse(JSON.stringify(results))
    const m: Result[] = JSON.parse(JSON.stringify(metas))
    if (keepQueue) {
      store.replaceResults(r, m)
    } else {
      // loadSnapshot 另外清等待佇列，否則舊任務會接在這批結果後面開跑
      store.loadSnapshot(r, m)
    }
    store.title = title
    // 狀態列表長度跟著新結果走，並收起舊的逐檔進度條；
    // 不發 resultChange：那會觸發 readyDownload 的自動開始下載
    downloadStates.init()
    progressBar.reset(0)
  }

  /** 目前掛載狀態；什麼都沒掛載回傳 null（entry 為不含大陣列的摘要） */
  public getMounted(): MountedInfo | null {
    if (this.mountedId) {
      const summary = this.summary(this.mountedId)
      if (summary) {
        return { entry: summary, unsaved: false }
      }
    }
    if (this.mountedUnsaved && store.result.length > 0) {
      return { entry: null, unsaved: true }
    }
    return null
  }

  public isMounted(id: string): boolean {
    return this.mountedId === id
  }

  /** 單例門：併發呼叫共用同一次載入，避免構造器預載與首次快照互相覆寫 */
  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const data = await chrome.storage.local.get([INDEX_KEY, LEGACY_KEY])
          const index = normalizeSummaries(data[INDEX_KEY])
          this.entries = index
          if (data[LEGACY_KEY] !== undefined) {
            this.adoptLegacy(index, normalizeEntries(data[LEGACY_KEY]))
          }
        } catch (e) {
          console.error('[PawchivePro] load crawl cache failed', e)
        } finally {
          this.loaded = true
        }
      })()
    }
    return this.loadPromise
  }

  /** Entries of the old single key that the index lacks join the list as
   * unsaved, so the next save writes them in the new layout; that save then
   * checks them and removes the old key. Another tab doing the same at once
   * writes the same entries, which merges cleanly. */
  private adoptLegacy(index: CacheSummary[], legacy: CacheEntry[]): void {
    const known = new Set(index.map((e) => e.id))
    const added = legacy.filter((e) => !known.has(e.id))
    for (const e of added) {
      this.bodies.set(e.id, { results: e.results, metas: e.metas })
      this.markDirty(e.id)
    }
    this.entries = mergeEntries(
      index,
      added.map(toSummary),
      new Set(added.map((e) => e.id)),
      new Set()
    )
    this.legacyPending = true
    this.persist()
  }

  /** 目前快取的摘要（新在前；回傳拷貝，防外部竄改快取內容） */
  public list(): CacheSummary[] {
    return this.entries.map((e) => ({ ...e }))
  }

  /** The result arrays of an entry: from memory when not written yet, else
   * read from its own key. Null when missing or unreadable. */
  private async loadBody(id: string): Promise<CacheBody | null> {
    const held = this.bodies.get(id)
    if (held) {
      return held
    }
    try {
      const key = bodyKey(id)
      const data = await chrome.storage.local.get(key)
      return normalizeBody(data[key])
    } catch (e) {
      console.error('[PawchivePro] load crawl cache entry failed', e)
      return null
    }
  }

  /** One full entry (summary and result arrays, a deep copy), or null */
  public async loadEntry(id: string): Promise<CacheEntry | null> {
    await this.ensureLoaded()
    const summary = this.summary(id)
    const body = summary ? await this.loadBody(id) : null
    if (!summary || !body) {
      return null
    }
    return JSON.parse(JSON.stringify({ ...summary, ...body }))
  }

  /** 抓取完成自動快照（空結果／縮圖單帖快抓不存；滿了擋下請用戶先刪舊的）。
   * 成功回傳該筆摘要，沒存回傳 null；silent 時不彈「已存入」提示 */
  public async autoSave(
    opts: { quick?: boolean; stopped?: boolean; silent?: boolean } = {}
  ): Promise<CacheSummary | null> {
    // 必須在任何 await 之前同步擷取：之後旗標可能已被下一輪改寫
    const quick = opts.quick ?? states.quickCrawl
    const stopped = opts.stopped ?? states.stopCrawl
    const incomplete = states.crawlIncomplete
    await this.ensureLoaded()
    // 縮圖單帖快抓、用戶中途停止的不完整結果都不存
    if (quick || stopped) {
      return null
    }
    if (store.result.length === 0) {
      return null
    }
    if (this.entries.length >= MAX_ENTRIES) {
      toast.warning(lang.transl('_cacheFull', String(MAX_ENTRIES)))
      return null
    }
    const first = store.result[0]
    const summary: CacheSummary = {
      id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`,
      title: first.creator || first.creatorId,
      service: first.service,
      creatorId: first.creatorId,
      creator: first.creator,
      host: location.host,
      postCount: store.resultMeta.length,
      fileCount: store.result.length,
      createdAt: Date.now(),
      ...(incomplete ? { incomplete: true } : {}),
    }
    this.bodies.set(summary.id, {
      results: JSON.parse(JSON.stringify(store.result)),
      metas: JSON.parse(JSON.stringify(store.resultMeta)),
    })
    this.entries.unshift(summary)
    this.markDirty(summary.id)
    this.persist()
    EVT.fire('cacheChange', { id: summary.id })
    if (!opts.silent) {
      toast.show(lang.transl('_cacheSaved', summary.title))
    }
    return { ...summary }
  }

  public async rename(id: string, title: string): Promise<boolean> {
    await this.ensureLoaded()
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) {
      return false
    }
    const t = title.trim()
    if (!t) {
      return false
    }
    entry.title = t
    this.markDirty(id)
    this.persist()
    EVT.fire('cacheChange', { id })
    if (this.mountedId === id) {
      store.title = t
      this.fireMountChange(false)
    }
    return true
  }

  public async remove(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const i = this.entries.findIndex((e) => e.id === id)
    if (i < 0) {
      return false
    }
    const mounted = this.mountedId === id
    // 正在下載（含暫停）的快取不能刪，否則下載目標憑空消失
    if (mounted && (states.busy || states.hasDownloadTask)) {
      toast.error(lang.transl('_cacheDeleteMountedBusy'))
      return false
    }
    this.entries.splice(i, 1)
    this.bodies.delete(id)
    this.markDeleted(id)
    this.persist()
    EVT.fire('cacheChange', { id })
    if (mounted) {
      // 刪掉掛載中的快取：一併清空下載區，避免留著已無對應快取的結果
      this.applyToStore([], [], document.title, false)
      this.mountedId = null
      this.mountedUnsaved = false
      this.fireMountChange(false)
    }
    return true
  }

  /** 單筆摘要（拷貝）；不存在回 null */
  public summary(id: string): CacheSummary | null {
    const e = this.entries.find((x) => x.id === id)
    return e ? { ...e } : null
  }

  /** 掛載：載入 store 當作目前下載目標，不自動開始下載。
   * 下載中（含暫停）／抓取中拒絕；目前掛載的是未存入快取的結果時先確認。
   * auto：下載佇列自動掛載——不確認（佇列開始時已確認過）、不彈成功提示、
   * 不把面板帶到下載頁 */
  public async mount(
    id: string,
    opts: { auto?: boolean } = {}
  ): Promise<boolean> {
    const auto = !!opts.auto
    await this.ensureLoaded()
    const summary = this.summary(id)
    if (!summary) {
      return false
    }
    // Read before the checks below, so nothing awaits between them and the
    // mount itself
    const body = await this.loadBody(id)
    if (!body) {
      if (!auto) toast.error(lang.transl('_cacheEntryMissing'))
      return false
    }
    if (body.results.length === 0) {
      return false
    }
    const entry = { ...summary, ...body }
    await states.waitSettingInitialized()
    if (states.busy || states.hasDownloadTask) {
      toast.error(lang.transl('_mountBusy'))
      return false
    }
    if (this.mountedId === id) {
      if (!auto) toast.show(lang.transl('_alreadyMounted'))
      return true
    }
    if (!auto && this.mountedUnsaved && store.result.length > 0) {
      if (!window.confirm(lang.transl('_mountReplaceUnsaved'))) {
        return false
      }
    }
    // 去重表、等待佇列、下載計數都會跟著重建，否則後續 addResult 去重
    // 會對不上這批結果
    this.applyToStore(entry.results, entry.metas, entry.title, false)
    this.mountedId = id
    this.mountedUnsaved = false
    this.fireMountChange(!auto)
    if (!auto) toast.success(lang.transl('_mounted', entry.title))
    return true
  }

  /** 卸載：清空下載區（快取本身保留），釋放記憶體。
   * 下載中（含暫停）／抓取中拒絕；未存入快取的結果卸載後就沒了，先確認 */
  public async unmount(): Promise<boolean> {
    await this.ensureLoaded()
    if (!this.mountedId && !(this.mountedUnsaved && store.result.length > 0)) {
      return false
    }
    if (states.busy || states.hasDownloadTask) {
      toast.error(lang.transl('_unmountBusy'))
      return false
    }
    if (this.mountedUnsaved && store.result.length > 0) {
      if (!window.confirm(lang.transl('_unmountUnsavedConfirm'))) {
        return false
      }
    }
    this.applyToStore([], [], document.title, false)
    this.mountedId = null
    this.mountedUnsaved = false
    // manual=false：manual 會把面板帶到下載頁，卸載不需要
    this.fireMountChange(false)
    toast.show(lang.transl('_unmounted'))
    return true
  }

  private markDirty(id: string): void {
    this.dirtyIds.add(id)
    this.deletedIds.delete(id)
    this.touchedIds.add(id)
  }

  private markDeleted(id: string): void {
    this.dirtyIds.delete(id)
    this.deletedIds.add(id)
    this.touchedIds.add(id)
  }

  /** Replace the in-memory list. Fires cacheChange when the visible list
   * changed, and demotes the mounted entry to "unsaved" if it is gone. */
  private applyEntries(next: CacheSummary[]): void {
    const sign = (list: CacheSummary[]) =>
      JSON.stringify(list.map((e) => [e.id, e.title]))
    const changed = sign(this.entries) !== sign(next)
    this.entries = next
    if (changed) {
      EVT.fire('cacheChange', { id: '' })
    }
    // 掛載中的結果還在 store，改記成未存入快取
    if (this.mountedId && !next.some((e) => e.id === this.mountedId)) {
      this.mountedId = null
      this.mountedUnsaved = true
      this.fireMountChange(false)
    }
  }

  private persist(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.writeChain = this.writeChain.then(() => this.saveEntries())
    }, 200)
  }

  /** Read-merge-write of the index: other tabs may have saved entries since
   * this tab loaded, so merge this tab's changes into the stored list. The
   * index and the bodies of new entries go in one write, so the stored index
   * never names a body that is not there. */
  private async saveEntries(): Promise<void> {
    if (
      this.dirtyIds.size === 0 &&
      this.deletedIds.size === 0 &&
      !this.legacyPending
    ) {
      return
    }
    const dirty = new Set(this.dirtyIds)
    const deleted = new Set(this.deletedIds)
    const migrating = this.legacyPending
    this.touchedIds = new Set()
    let merged: CacheSummary[] = this.entries
    try {
      const data = await chrome.storage.local.get(INDEX_KEY)
      const stored = normalizeSummaries(data[INDEX_KEY])
      // Taken before the write: an entry another tab saves meanwhile reaches
      // this.entries through a change event and must keep its results
      const known = [...stored, ...this.entries].map((e) => e.id)
      merged = mergeEntries(stored, this.entries, dirty, deleted)
      const out: Record<string, unknown> = { [INDEX_KEY]: merged }
      const written: string[] = []
      for (const e of merged) {
        const body = dirty.has(e.id) ? this.bodies.get(e.id) : undefined
        if (body) {
          out[bodyKey(e.id)] = body
          written.push(e.id)
        }
      }
      await chrome.storage.local.set(out)
      // Bodies of entries the index no longer has: deleted here, deleted by
      // another tab, or dropped by the cap
      const kept = new Set(merged.map((e) => e.id))
      const gone = new Set([...deleted, ...known].filter((id) => !kept.has(id)))
      if (gone.size > 0) {
        await chrome.storage.local.remove([...gone].map(bodyKey))
      }
      if (migrating) {
        await this.finishMigration(written)
      }
      // Anything touched while the write was in flight stays pending
      for (const id of dirty) {
        if (!this.touchedIds.has(id)) this.dirtyIds.delete(id)
      }
      for (const id of deleted) {
        if (!this.touchedIds.has(id)) this.deletedIds.delete(id)
      }
      // Written bodies are read back from storage when needed
      for (const id of written) {
        this.bodies.delete(id)
      }
      // Merge again over what storage holds now, not over the written list:
      // another tab may have saved since, and its change event has already
      // been applied. Keeps entries added here meanwhile too.
      const latest = await chrome.storage.local
        .get(INDEX_KEY)
        .then((d) => normalizeSummaries(d[INDEX_KEY]))
        .catch(() => merged)
      this.applyEntries(
        mergeEntries(latest, this.entries, this.dirtyIds, this.deletedIds)
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 配額不足：由舊到新丟棄，直到能寫入（最新一筆優先保留）
      if (/quota/i.test(msg) && merged.length > 1) {
        const removed = merged[merged.length - 1]
        // Recorded as deleted so the next merge does not bring it back
        this.markDeleted(removed.id)
        this.bodies.delete(removed.id)
        // Free its space now, or the retry would not fit either
        await chrome.storage.local
          .remove(bodyKey(removed.id))
          .catch(() => undefined)
        this.applyEntries(
          mergeEntries(merged, this.entries, this.dirtyIds, this.deletedIds)
        )
        log.warning(lang.transl('_cacheEvicted', removed.title))
        this.persist()
        return
      }
      // 常見於單筆過大（內文 textData 多）超過配額：
      // 本筆仍留記憶體可下載，只是重開瀏覽器後消失
      console.error('[PawchivePro] save crawl cache failed', e)
      toast.warning(lang.transl('_cacheStoreFailed'))
      log.warning(lang.transl('_cacheStoreFailed'))
    }
  }

  /** The old entries are written in the new layout: read them back, then
   * remove the old key. A failure keeps the old key for the next load. */
  private async finishMigration(written: string[]): Promise<void> {
    const check = await chrome.storage.local.get([
      INDEX_KEY,
      ...written.map(bodyKey),
    ])
    const indexed = new Set(
      normalizeSummaries(check[INDEX_KEY]).map((e) => e.id)
    )
    const missing = written.find(
      (id) => !indexed.has(id) || !normalizeBody(check[bodyKey(id)])
    )
    if (missing !== undefined) {
      throw new Error(`crawl cache entry ${missing} did not reach storage`)
    }
    await chrome.storage.local.remove(LEGACY_KEY)
    this.legacyPending = false
  }
}

const crawlCache = new CrawlCache()
export { crawlCache, MAX_ENTRIES }
