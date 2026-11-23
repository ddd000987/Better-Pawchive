/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * 下載佇列：把多筆抓取快取排隊，依序「掛載 → 開始下載 → 結束後換下一筆」，
 * 例如睡前排好幾個作者讓它一次載完。
 * - 結束訊號：downloadComplete（完成）；downloadGiveUp（自動重試用完，緊接著
 *   還會有一個 downloadComplete）→ 標成部分失敗、換下一筆。已存好的檔案有下載記錄，重跑時會跳過。
 * - 使用者手動停止下載＝暫停佇列，目前那一筆回到等待。
 * - 「暫停佇列」只是不再接下一筆，目前那一筆照常下載完。
 * - 佇列項目（快取 id 與狀態）存在 chrome.storage.local；執行中旗標不存，
 *   重新整理後不會自動續跑，要使用者再按「開始」。
 * - 下載由這個分頁驅動：分頁要一直開著，電腦也不能睡眠。
 */

import { crawlCache } from './CrawlCache'
import { downloadControl } from './DownloadControl'
import { EVT } from '../EVT'
import { lang } from '../Language'
import { log } from '../Log'
import { states } from '../store/States'
import { toast } from '../Toast'

const STORE_KEY = 'pawchiveProDownloadQueue'

export type QueueItemStatus =
  /** 等待下載 */
  | 'waiting'
  /** 下載中 */
  | 'running'
  /** 完成 */
  | 'done'
  /** 自動重試用完仍有檔案失敗 */
  | 'partial'
  /** 快取已被刪除 */
  | 'missing'
  /** 無法掛載或開始下載 */
  | 'failed'

export interface QueueItem {
  cacheId: string
  /** 快取標題快照（快取改名時同步） */
  title: string
  status: QueueItemStatus
}

const STATUSES: QueueItemStatus[] = [
  'waiting',
  'running',
  'done',
  'partial',
  'missing',
  'failed',
]

/** 從 storage 讀回的資料可能是舊版或壞掉的：只留合法項目，下載中一律退回等待 */
export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: QueueItem[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const { cacheId, title, status } = x as Record<string, unknown>
    if (typeof cacheId !== 'string' || !cacheId || seen.has(cacheId)) continue
    seen.add(cacheId)
    const st = STATUSES.includes(status as QueueItemStatus)
      ? (status as QueueItemStatus)
      : 'waiting'
    out.push({
      cacheId,
      title: typeof title === 'string' ? title : cacheId,
      status: st === 'running' ? 'waiting' : st,
    })
  }
  return out
}

class DownloadQueue {
  private items: QueueItem[] = []
  private running = false
  /** 目前由佇列驅動下載的快取 id */
  private currentId: string | null = null
  private loadPromise: Promise<void> | null = null
  private saveTimer = 0
  private advanceTimer = 0

  constructor() {
    this.bindEvents()
    void this.ensureLoaded()
  }

  private bindEvents(): void {
    EVT.on(EVT.list.downloadComplete, () => {
      const item = this.current()
      if (!item) return
      item.status = 'done'
      this.currentId = null
      this.changed()
      this.scheduleNext()
    })

    EVT.on(EVT.list.downloadGiveUp, () => {
      const item = this.current()
      if (!item) return
      item.status = 'partial'
      this.currentId = null
      log.warning(lang.transl('_queueItemPartial', item.title))
      // No stopDownload here: DownloadControl ends the batch through the
      // normal downloadComplete right after this event (the item is no longer
      // current by then, so the queue advances only once)
      this.changed()
      this.scheduleNext()
    })

    EVT.on(EVT.list.downloadStop, () => {
      const item = this.current()
      if (item) {
        item.status = 'waiting'
        this.currentId = null
      }
      if (this.running) {
        this.running = false
        toast.warning(lang.transl('_queueStoppedByUser'))
      }
      this.changed()
    })

    // 抓取會清空 store：佇列不能接著跑
    EVT.on(EVT.list.crawlStart, () => {
      if (!this.running && !this.currentId) return
      const item = this.current()
      if (item) item.status = 'waiting'
      this.currentId = null
      this.running = false
      window.clearTimeout(this.advanceTimer)
      this.changed()
    })

    // 快取改名：同步標題快照
    EVT.on(EVT.list.cacheChange, () => {
      let dirty = false
      for (const item of this.items) {
        const s = crawlCache.summary(item.cacheId)
        if (s && s.title !== item.title) {
          item.title = s.title
          dirty = true
        }
      }
      if (dirty) this.changed()
    })

    // 其他分頁改了佇列：本分頁沒在跑時跟著同步
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !(STORE_KEY in changes)) return
      if (this.running || this.currentId) return
      this.items = normalizeQueue(changes[STORE_KEY].newValue)
      EVT.fire('queueChange')
    })
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const data = await chrome.storage.local.get(STORE_KEY)
          this.items = normalizeQueue(data[STORE_KEY])
          EVT.fire('queueChange')
        } catch (e) {
          console.error('[PawchivePro] load download queue failed', e)
        }
      })()
    }
    return this.loadPromise
  }

  private current(): QueueItem | null {
    if (!this.currentId) return null
    return this.items.find((i) => i.cacheId === this.currentId) ?? null
  }

  private changed(): void {
    this.persist()
    EVT.fire('queueChange')
  }

  private persist(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      void chrome.storage.local
        .set({ [STORE_KEY]: this.items })
        .catch((e: unknown) =>
          console.error('[PawchivePro] save download queue failed', e)
        )
    }, 200)
  }

  /** 目前佇列（淺拷貝） */
  public list(): QueueItem[] {
    return this.items.map((i) => ({ ...i }))
  }

  public isRunning(): boolean {
    return this.running
  }

  /** 該快取是否在佇列中等待或下載中 */
  public has(cacheId: string): boolean {
    return this.items.some(
      (i) =>
        i.cacheId === cacheId &&
        (i.status === 'waiting' || i.status === 'running')
    )
  }

  /** 加入佇列；已結束的同一筆會改回等待 */
  public async add(cacheId: string): Promise<boolean> {
    await this.ensureLoaded()
    const s = crawlCache.summary(cacheId)
    if (!s) return false
    const existing = this.items.find((i) => i.cacheId === cacheId)
    if (
      existing &&
      (existing.status === 'waiting' || existing.status === 'running')
    ) {
      toast.show(lang.transl('_queueAlready', s.title))
      return false
    }
    if (existing) {
      // 移到最後重新排隊
      this.items.splice(this.items.indexOf(existing), 1)
    }
    this.items.push({ cacheId, title: s.title, status: 'waiting' })
    this.changed()
    toast.show(lang.transl('_queueAdded', s.title))
    return true
  }

  /** 移出佇列（下載中的那一筆不能移） */
  public async remove(cacheId: string): Promise<boolean> {
    await this.ensureLoaded()
    const i = this.items.findIndex((x) => x.cacheId === cacheId)
    if (i < 0) return false
    if (this.currentId === cacheId) {
      toast.error(lang.transl('_queueRemoveRunning'))
      return false
    }
    this.items.splice(i, 1)
    this.changed()
    return true
  }

  /** 上移（-1）／下移（1） */
  public move(cacheId: string, dir: -1 | 1): boolean {
    const i = this.items.findIndex((x) => x.cacheId === cacheId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= this.items.length) return false
    ;[this.items[i], this.items[j]] = [this.items[j], this.items[i]]
    this.changed()
    return true
  }

  /** 清掉已結束的項目（完成、部分失敗、找不到、無法開始） */
  public clearFinished(): void {
    const before = this.items.length
    this.items = this.items.filter(
      (i) => i.status === 'waiting' || i.status === 'running'
    )
    if (this.items.length !== before) this.changed()
  }

  /** 開始依序下載等待中的項目 */
  public async start(): Promise<boolean> {
    await this.ensureLoaded()
    await states.waitSettingInitialized()
    if (this.running) return true
    if (!this.items.some((i) => i.status === 'waiting')) {
      toast.error(lang.transl('_queueEmpty'))
      return false
    }
    if (states.busy || states.hasDownloadTask) {
      toast.error(lang.transl('_queueBusy'))
      return false
    }
    // 佇列會自動換掛載：未存入快取的結果在這裡先確認，之後不再中途詢問
    if (crawlCache.getMounted()?.unsaved) {
      if (!window.confirm(lang.transl('_mountReplaceUnsaved'))) return false
    }
    this.running = true
    this.changed()
    log.log(lang.transl('_queueStarted'))
    await this.next()
    return true
  }

  /** 暫停佇列：目前這一筆照常下載完，但不再接下一筆 */
  public pause(): void {
    if (!this.running) return
    this.running = false
    window.clearTimeout(this.advanceTimer)
    this.changed()
    toast.show(lang.transl('_queuePaused'))
  }

  /** 讓 States 等其他監聽者先處理完結束事件，再換下一筆 */
  private scheduleNext(): void {
    window.clearTimeout(this.advanceTimer)
    this.advanceTimer = window.setTimeout(() => void this.next(), 0)
  }

  private async next(): Promise<void> {
    if (!this.running || this.currentId) return
    const item = this.items.find((i) => i.status === 'waiting')
    if (!item) {
      this.running = false
      this.changed()
      const msg = lang.transl('_queueFinished')
      log.success(msg)
      toast.success(msg, { position: 'center' })
      return
    }
    // 結束事件之後接著開了別的任務（例如排隊中的抓取）：佇列讓路
    if (states.busy || states.hasDownloadTask) {
      this.running = false
      this.changed()
      toast.warning(lang.transl('_queueBusyPaused'))
      return
    }
    const s = crawlCache.summary(item.cacheId)
    if (!s) {
      item.status = 'missing'
      log.warning(lang.transl('_queueItemMissing', item.title))
      this.changed()
      return this.next()
    }
    item.title = s.title
    if (!(await crawlCache.mount(item.cacheId, { auto: true }))) {
      item.status = 'failed'
      log.error(lang.transl('_queueItemFailed', item.title))
      this.changed()
      return this.next()
    }
    // 掛載期間被暫停：已掛載但不開始，這一筆留在等待
    if (!this.running) return
    item.status = 'running'
    this.currentId = item.cacheId
    this.changed()
    const pending = this.items.filter(
      (i) => i.status === 'waiting' || i.status === 'running'
    ).length
    const finished = this.items.filter(
      (i) => i.status !== 'waiting' && i.status !== 'running'
    ).length
    log.log(
      lang.transl(
        '_queueItemStart',
        String(finished + 1),
        String(finished + pending),
        item.title
      )
    )
    await downloadControl.startDownload()
    // 前置檢查沒過時不會進入下載中（成功時 downloadStart 已同步發出）
    if (this.currentId === item.cacheId && !states.hasDownloadTask) {
      item.status = 'failed'
      this.currentId = null
      log.error(lang.transl('_queueItemFailed', item.title))
      this.changed()
      this.scheduleNext()
    }
  }
}

const downloadQueue = new DownloadQueue()
export { downloadQueue }
