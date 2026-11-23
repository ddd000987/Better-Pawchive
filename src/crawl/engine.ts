/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/crawl/InitPageBase.ts
 *          state machine concept (xuejianxianzun)
 *          + Kemono-Downloader post-resource.ts pending semantics
 * changes: rewritten for Kemono — creator pages paginate
 *          api.posts (o+=50, probe until short page; Pawchive has no
 *          total); post pages fetch one detail. List-level quick screen
 *          before detail fetch saves 429 budget. 429 → backoff 60s retry.
 */

import { api, ApiHttpError } from '../kemono/api'
import {
  isErrorResponse,
  isPendingPost,
  KemonoService,
  ProfileApiResponse,
} from '../kemono/apiTypes'
import { expandPost, summarizeListItem } from '../kemono/expand'
import { detectPage, makePostKey } from '../kemono/pages'
import { EVT } from '../EVT'
import { filter, isPostIdOutOfRange } from '../filter/Filter'
import { lang } from '../Language'
import { log } from '../Log'
import { toast } from '../Toast'
import { parsePostKey } from '../preview/previewAssets'
import { settings } from '../setting/Settings'
import { store } from '../store/Store'
import { states } from '../store/States'
import { IDData, KemonoFileKind, PostMeta } from '../store/StoreType'
import { sleepAbortable } from '../Tools'
import { crawlPause } from './CrawlPause'
import { crawlProgress, formatExcluded } from './CrawlProgress'

/** 創作者頁每頁筆數（API 固定 50） */
const PAGE_SIZE = 50
/**
 * 探測迴圈的最後安全上限（頁數）。
 * 正常的防呆靠「整頁無新帖 id」的重複偵測；這個上限只防偵測也失效的極端情況，
 * 所以設得很高，避免截斷真正的大創作者（50 筆 × 5000 頁 = 25 萬帖）。
 */
const MAX_PAGES = 5000
/** 429 退避等待（ms） */
const BACKOFF_429 = 60000
/** 429 單點最大重試次數 */
const RETRY_429_MAX = 3
/** 詳情 429 退避等待（ms，比列表短：單帖失敗只影響一帖） */
const BACKOFF_DETAIL_429 = 30000
/** 詳情 429 最大重試次數 */
const RETRY_DETAIL_429_MAX = 2
/** 列表暫時性錯誤（5xx／網路）最大重試次數 */
const RETRY_TRANSIENT_MAX = 3
/** 詳情暫時性錯誤（5xx／網路）最大重試次數 */
const RETRY_DETAIL_TRANSIENT_MAX = 2
/** 暫時性錯誤退避基數（ms；第 n 次重試等 BACKOFF_TRANSIENT * n） */
const BACKOFF_TRANSIENT = 5000
/**
 * Consecutive requests that gave up on 429 after which the crawl stops,
 * instead of dropping every remaining post one backoff at a time.
 */
const RATE_LIMIT_HALT_AFTER = 3
/** Bounds (ms) for a wait the server asked for with Retry-After */
const RETRY_AFTER_MIN = 1000
const RETRY_AFTER_MAX = 5 * 60 * 1000

/** How one request is retried (see Engine.attempt) */
interface RetryPolicy {
  max429: number
  backoff429: number
  maxTransient: number
}
/** Creator profile and list pages: the larger budget */
const LIST_POLICY: RetryPolicy = {
  max429: RETRY_429_MAX,
  backoff429: BACKOFF_429,
  maxTransient: RETRY_TRANSIENT_MAX,
}
/** Post details: a failure only costs one post, so a smaller budget */
const DETAIL_POLICY: RetryPolicy = {
  max429: RETRY_DETAIL_429_MAX,
  backoff429: BACKOFF_DETAIL_429,
  maxTransient: RETRY_DETAIL_TRANSIENT_MAX,
}

/** Outcome of Engine.attempt */
type Attempt<T> =
  | { ok: true; value: T }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; error: unknown; status: number }

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function parseHttpStatus(e: unknown): number {
  if (e instanceof ApiHttpError) {
    return e.status
  }
  // A JSON parse message may contain position numbers like 403 or 5xx; never treat it as an HTTP status
  if (e instanceof SyntaxError) {
    return 0
  }
  const msg = e instanceof Error ? e.message : String(e)
  const m = msg.match(/\b(403|404|429|5\d\d)\b/)
  return m ? parseInt(m[1], 10) : 0
}

/** 是否為 fetch 的網路層失敗（斷線／DNS／CORS 等，fetch 以 TypeError 拒絕） */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError
}

/**
 * Whether an error is worth retrying: 5xx, a network-level failure, or a
 * response body that is not valid JSON (res.json() throws SyntaxError, e.g. a gateway error page).
 */
function isTransientError(e: unknown, status: number): boolean {
  return (
    status >= 500 ||
    (status === 0 && (isNetworkError(e) || e instanceof SyntaxError))
  )
}

/** How long to wait after a 429: the server's Retry-After when known (bounded), else the default */
function rateLimitWait(e: unknown, fallback: number): number {
  if (e instanceof ApiHttpError && e.retryAfterMs !== undefined) {
    return Math.min(Math.max(e.retryAfterMs, RETRY_AFTER_MIN), RETRY_AFTER_MAX)
  }
  return fallback
}

/** What a list item tells about a post before its detail is fetched */
interface ListInfo {
  title: string
  published: string
  fileCount: number
  kinds: Set<KemonoFileKind>
  pending: boolean
}

class Engine {
  /** 世代號：每輪抓取 +1，舊輪收尾時用來判斷是否已被取代 */
  private generation = 0
  /** 當前這輪抓取的中止控制器 */
  private controller: AbortController | null = null
  /** 當前這輪抓取的 promise（新一輪要等它收尾） */
  private running: Promise<void> | null = null
  /**
   * 1-based list page on which this run's creator list failed and cut the crawl short;
   * null when that did not happen. Reset at the start of every run and used at
   * finish time to tell a complete crawl from one truncated by a list failure.
   */
  private listFailedAtPage: number | null = null
  /** Message of an unexpected error that ended this run early; null when none */
  private runError: string | null = null
  /** Requests in a row that gave up on 429 (reset by any success) */
  private rateLimitGiveUps = 0
  /** This run was stopped by the engine itself because of repeated 429 */
  private rateLimitHalted = false

  constructor() {
    this.bindEvents()
  }

  private bindEvents() {
    // 縮圖下載鈕／等待佇列：給定 ID 列表，逐帖抓詳情入庫
    EVT.on(EVT.list.crawlIdList, (ev: CustomEventInit) => {
      const ids = ev.detail.data as IDData[]
      if (Array.isArray(ids) && ids.length > 0) {
        void this.crawlIds(ids)
      }
    })
    // Alt+Z：當前頁開始預設抓取
    EVT.on(EVT.list.commandStartDefaultCrawl, () => {
      void this.start()
    })
    // 停止抓取：立刻 abort 當前這輪（喚醒 sleep／fetch）
    EVT.on(EVT.list.stopCrawl, () => {
      this.controller?.abort()
    })
  }

  /**
   * 同一時間只允許一輪引擎執行：先等上一輪收尾，再開新世代。
   * body 內的停止判斷一律用 signal.aborted（新一輪的 crawlStart 會把
   * states.stopCrawl 改回 false，但舊 signal 永遠保持 aborted）。
   * onBusy：等完上一輪後若仍忙碌（別人搶先開跑）就走這裡排隊，
   * 且不動世代號與控制器，避免弄壞搶先者那一輪。
   */
  private async runExclusive(
    onBusy: () => void,
    body: (signal: AbortSignal, gen: number) => Promise<void>
  ): Promise<void> {
    // 迴圈等待：多個呼叫者同等一個 running 時，醒來後必須重新檢查
    while (this.running) {
      await this.running.catch(() => {})
    }
    // 以下到 body 啟動為止是同步區段（中間不可有 await），
    // 這樣檢查 busy、換世代、換控制器、登記 running 對其他呼叫者是原子的
    if (states.busy || states.hasDownloadTask) {
      onBusy()
      return
    }
    const gen = ++this.generation
    this.controller = new AbortController()
    const signal = this.controller.signal
    const running = body(signal, gen)
    this.running = running
    try {
      await running
    } finally {
      if (this.running === running) {
        this.running = null
      }
    }
  }

  /** Reset the per-run failure state (first thing in every run body) */
  private beginRun(): void {
    this.listFailedAtPage = null
    this.runError = null
    this.rateLimitGiveUps = 0
    this.rateLimitHalted = false
  }

  /**
   * Creator names already known from the results currently in the store.
   * Read before crawlStart clears the store: when a later profile request
   * fails, the old name keeps the files in the folder of earlier downloads.
   */
  private knownCreatorNames(): Map<string, string> {
    const names = new Map<string, string>()
    for (const meta of store.resultMeta) {
      if (meta.creator && meta.creator !== meta.creatorId) {
        names.set(`${meta.service}/${meta.creatorId}`, meta.creator)
      }
    }
    return names
  }

  /** 面板「開始抓取」入口 */
  public async start(): Promise<void> {
    // 等設定載入完成，否則會用預設值抓取（存檔的過濾條件被忽略）
    await states.waitSettingInitialized()
    if (states.busy || states.hasDownloadTask) {
      // 忙碌時統一排隊：目前任務（抓取或下載）結束後再開始整頁抓取
      store.waitingFullCrawl = true
      toast.show(lang.transl('_queuedCrawl'))
      return
    }
    const page = detectPage()
    if (page.kind === 'other') {
      toast.error(lang.transl('_unsupportedPage'))
      return
    }

    await this.runExclusive(
      () => {
        store.waitingFullCrawl = true
        toast.show(lang.transl('_queuedCrawl'))
      },
      async (signal, gen) => {
        // 面板發起的完整抓取：快取要存（與縮圖單帖快抓區分，見 crawlIds）
        states.quickCrawl = false
        this.beginRun()
        const known = this.knownCreatorNames()
        EVT.fire('crawlStart')
        // crawlStart 會清零進度統計；之後才設目標（創作者名等 profile 回來再補）
        crawlProgress.setTarget(this.targetLabel(page.service, page.creatorId))
        log.log(
          lang.transl('_crawlStarted', `${location.host}${location.pathname}`)
        )

        try {
          if (page.kind === 'creator') {
            await this.crawlCreator(page.service, page.creatorId, signal, known)
          } else {
            await this.crawlPost(
              page.service,
              page.creatorId,
              page.postId,
              signal,
              known
            )
          }
        } catch (e) {
          if (!signal.aborted) {
            this.runError = errorText(e)
            log.error(lang.transl('_crawlAborted', this.runError))
          }
        }

        // 已被新一輪取代：不發收尾事件、不寫 store
        if (gen !== this.generation) {
          return
        }
        this.finishRun(signal)
      }
    )
  }

  /** 縮圖下載鈕入口：逐帖取詳情 → 入庫 → 走正常下載管線
   * opts.picked: the posts were picked by hand (manual pick mode). The filter
   * settings are skipped (now and when the result is downloaded), and the
   * result is saved to the crawl cache like a full crawl. Such a crawl is not
   * queued while busy: the waiting queue would replay it as a quick crawl, so
   * the caller keeps its selection and the user tries again later.
   * Returns the ids of the posts that were actually added to the result
   * (empty when the crawl did not run or was superseded). */
  public async crawlIds(
    idList: IDData[],
    opts: { picked?: boolean } = {}
  ): Promise<string[]> {
    const picked = opts.picked === true
    const onBusy = () => {
      if (picked) {
        toast.warning(lang.transl('_pickBusy'))
        return
      }
      // 忙碌中 → 排入等待佇列（下載完成後 DownloadControl 會重發 crawlIdList）
      store.waitingIdList.push(...idList)
      toast.show(lang.transl('_queuedN', String(idList.length)))
    }
    await states.waitSettingInitialized()
    if (states.busy || states.hasDownloadTask) {
      onBusy()
      return []
    }

    let doneIds: string[] = []
    await this.runExclusive(onBusy, async (signal, gen) => {
      // 縮圖單帖快抓／等待佇列：抓取快取跳過這類（只存完整抓取的整批結果）
      // A manual pick is saved like a full crawl
      states.quickCrawl = !picked
      this.beginRun()
      const known = this.knownCreatorNames()
      EVT.fire('crawlStart')
      // ID 列表型抓取：目標是「N 帖」，總數已知
      crawlProgress.setTargetPosts(idList.length)
      crawlProgress.setTotal(idList.length)
      log.log(lang.transl('_crawlStarted', `${idList.length} posts`))

      // 同一創作者只查一次 profile（檔名用；失敗用 ID 代替，不中斷）
      const names = new Map<string, string>()
      const done: IDData[] = []
      try {
        for (const item of idList) {
          if (signal.aborted) {
            break
          }
          const info = parsePostKey(item.id)
          if (!info) {
            crawlProgress.scan()
            crawlProgress.fail()
            log.warning(
              lang.transl('_postDetailFailed', item.id, 'bad postKey')
            )
            continue
          }
          const ck = `${info.service}/${info.creatorId}`
          let creatorName = names.get(ck)
          if (creatorName === undefined) {
            const creator = await this.resolveCreator(
              info.service,
              info.creatorId,
              signal,
              known
            )
            // 暫停中在這裡等；等待期間被停止就中止整輪
            if (!creator) {
              break
            }
            creatorName = creator.name
            names.set(ck, creatorName)
          }
          const added = await this.crawlOnePost(
            info.service,
            info.creatorId,
            info.postId,
            creatorName,
            undefined,
            signal,
            picked
          )
          if (added) {
            done.push(item)
          }
        }
      } catch (e) {
        if (!signal.aborted) {
          this.runError = errorText(e)
          log.error(lang.transl('_crawlAborted', this.runError))
        }
      }

      // 已被新一輪取代：不發收尾事件、不寫 store
      if (gen !== this.generation) {
        return
      }

      // 只登記實際處理過的 ID；停止時保留部分結果，但走中止收尾
      store.idList.push(...done)
      doneIds = done.map((item) => item.id)
      this.finishRun(signal)
    })
    return doneIds
  }

  /**
   * Close a run: pick the finish that matches how it ended. A run that lost
   * posts (failed details, a cut-short list, repeated 429, an unexpected
   * error) must not report "Crawl complete".
   */
  private finishRun(signal: AbortSignal): void {
    // The user pressed stop (the engine's own 429 halt aborts the signal too)
    if (signal.aborted && !this.rateLimitHalted) {
      log.warning(lang.transl('_crawlStoppedKeep'))
      this.finishStopped()
      return
    }
    const posts = String(store.resultMeta.length)
    const files = String(store.result.length)
    let incomplete: string | null = null
    let emptyMessage: string | undefined
    if (this.rateLimitHalted) {
      incomplete = lang.transl('_crawlRateLimitHalt', posts, files)
      emptyMessage = incomplete
    } else if (this.listFailedAtPage !== null) {
      // The list failed part-way: later pages were never fetched, so do not report success
      const page = String(this.listFailedAtPage)
      incomplete = lang.transl('_crawlIncomplete', page, posts, files)
      emptyMessage = lang.transl('_crawlListFailedEmpty', page)
    } else if (this.runError !== null) {
      incomplete = lang.transl(
        '_crawlIncompleteError',
        this.runError,
        posts,
        files
      )
      emptyMessage = incomplete
    } else if (crawlProgress.failed > 0) {
      // Posts dropped after their retries: the result lacks them
      incomplete = lang.transl(
        '_crawlIncompleteFailed',
        String(crawlProgress.failed),
        posts,
        files
      )
    }

    if (store.resultMeta.length === 0) {
      this.finishEmpty(emptyMessage)
    } else if (incomplete !== null) {
      this.finishIncomplete(incomplete)
    } else {
      this.finishDone()
    }
  }

  /** 抓取收尾：空結果 */
  private finishEmpty(message?: string): void {
    EVT.fire('crawlComplete')
    EVT.fire('crawlEmpty')
    // 依統計說明為什麼是空的：沒找到帖子／全被篩選排除／取詳情失敗
    // (callers that already know the reason pass it in, e.g. page 1 of the list failed)
    const msg = message ?? this.emptyMessage()
    log.warning(msg)
    // 不必翻日誌就能看到原因
    toast.warning(msg)
  }

  /** 抓取結果為空時的詳細說明（依 crawlProgress 統計） */
  private emptyMessage(): string {
    const { scanned, failed } = crawlProgress
    const excluded = crawlProgress.excludedTotal
    if (scanned === 0 || (excluded === 0 && failed === 0)) {
      return lang.transl('_crawlEmpty')
    }
    const detail = formatExcluded(crawlProgress.excluded)
    if (failed === 0) {
      return lang.transl('_crawlEmptyExcluded', String(scanned), detail)
    }
    if (excluded === 0) {
      return lang.transl('_crawlEmptyFailed', String(scanned))
    }
    return lang.transl(
      '_crawlEmptyMixed',
      String(scanned),
      String(excluded),
      detail,
      String(failed)
    )
  }

  /** 抓取目標的簡短標籤：有創作者名則「名字 (服務/ID)」，否則「服務/ID」 */
  private targetLabel(
    service: string,
    creatorId: string,
    name = creatorId
  ): string {
    const id = `${service}/${creatorId}`
    return name && name !== creatorId ? `${name} (${id})` : id
  }

  /** 抓取收尾：使用者中止（只發完成事件，讓 busy 收斂，不記成功） */
  private finishStopped(): void {
    EVT.fire('crawlComplete')
  }

  /** 抓取收尾：有結果 */
  private finishDone(): void {
    EVT.fire('crawlComplete')
    log.success(
      lang.transl(
        '_crawlComplete',
        String(store.resultMeta.length),
        String(store.result.length)
      )
    )
  }

  /** Finish: some results were kept, but the run lost posts or was cut short (msg says how) */
  private finishIncomplete(msg: string): void {
    // Downstream behaviour matches finishDone: crawlComplete fires and the kept results stay downloadable
    EVT.fire('crawlComplete')
    log.warning(msg)
    toast.warning(msg)
  }

  /**
   * One request with the shared retry rules: waits while paused, retries a
   * 429 (after the server's Retry-After when it sent one) and transient
   * errors within the policy, and reports every HTTP status. Repeated 429
   * give-ups in a row stop the whole run (see noteRateLimitGiveUp).
   */
  private async attempt<T>(
    call: () => Promise<T>,
    signal: AbortSignal,
    policy: RetryPolicy
  ): Promise<Attempt<T>> {
    const aborted: Attempt<T> = { ok: false, aborted: true }
    let backoffCount = 0
    let transientCount = 0
    for (;;) {
      // 暫停中在請求前等待（重試的 continue 也會回到這裡）
      if (!(await crawlPause.wait(signal))) {
        return aborted
      }
      try {
        const value = await call()
        this.rateLimitGiveUps = 0
        return { ok: true, value }
      } catch (e) {
        // 使用者中止造成的錯誤：安靜結束，不記失敗
        if (signal.aborted) {
          return aborted
        }
        const status = parseHttpStatus(e)
        if (status !== 0) {
          EVT.fire('requestStatusError', {
            status,
            url: e instanceof ApiHttpError ? e.url : errorText(e),
          })
        }
        if (status === 429 && backoffCount < policy.max429) {
          backoffCount++
          const wait = rateLimitWait(e, policy.backoff429)
          log.warning(
            lang.transl(
              '_rateLimitedIn',
              String(Math.round(wait / 1000)),
              String(backoffCount),
              String(policy.max429)
            )
          )
          if (!(await sleepAbortable(wait, signal))) {
            return aborted
          }
          continue
        }
        // 5xx／網路抖動：有限次數重試（4xx 直接失敗）
        if (
          isTransientError(e, status) &&
          transientCount < policy.maxTransient
        ) {
          transientCount++
          const delay = BACKOFF_TRANSIENT * transientCount
          log.warning(
            lang.transl(
              '_transientRetry',
              errorText(e),
              String(delay / 1000),
              String(transientCount),
              String(policy.maxTransient)
            )
          )
          if (!(await sleepAbortable(delay, signal))) {
            return aborted
          }
          continue
        }
        if (status === 429) {
          this.noteRateLimitGiveUp(signal)
        }
        return { ok: false, aborted: false, error: e, status }
      }
    }
  }

  /** A request gave up on 429: after several in a row, stop the run instead of dropping every remaining post */
  private noteRateLimitGiveUp(signal: AbortSignal): void {
    this.rateLimitGiveUps++
    if (
      this.rateLimitGiveUps >= RATE_LIMIT_HALT_AFTER &&
      !signal.aborted &&
      this.controller?.signal === signal
    ) {
      this.rateLimitHalted = true
      this.controller.abort()
    }
  }

  /**
   * Creator name for the file names (and the profile, when it loads). A
   * profile that cannot be fetched must not silently change the folder name:
   * the name from earlier results is reused when there is one, otherwise the
   * id is used and the user is warned. Returns null when the run was stopped.
   */
  private async resolveCreator(
    service: KemonoService,
    creatorId: string,
    signal: AbortSignal,
    known: Map<string, string>
  ): Promise<{ name: string; profile: ProfileApiResponse | null } | null> {
    const res = await this.attempt(
      async () => {
        const profile = await api.profile({ service, creatorId }, signal)
        if (isErrorResponse(profile)) {
          throw new Error(profile.error)
        }
        if (!profile || typeof profile !== 'object') {
          throw new Error('invalid profile response')
        }
        return profile
      },
      signal,
      LIST_POLICY
    )
    if (res.ok) {
      return { name: res.value.name || creatorId, profile: res.value }
    }
    if (res.aborted) {
      return null
    }
    const reason = errorText(res.error)
    const earlier = known.get(`${service}/${creatorId}`)
    if (earlier) {
      log.warning(lang.transl('_profileFailedReuse', reason, earlier))
      return { name: earlier, profile: null }
    }
    const msg = lang.transl('_profileFailedId', reason, creatorId)
    log.warning(msg)
    toast.warning(msg)
    return { name: creatorId, profile: null }
  }

  /** 創作者頁：分頁取列表 → 快篩 → 詳情 → 過濾 → 入庫 */
  private async crawlCreator(
    service: KemonoService,
    creatorId: string,
    signal: AbortSignal,
    known: Map<string, string>
  ): Promise<void> {
    // 服務過濾前置檢查：若當前服務被排除，直接中止，省掉整輪空跑
    const services = settings
      .get('filterServices')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    if (services.length > 0 && !services.includes(service.toLowerCase())) {
      toast.error(lang.transl('_serviceExcluded', service))
      log.warning(lang.transl('_serviceExcludedLog'))
      return
    }

    // 創作者名（檔名用）；暫停中會在發請求前等待，等待期間被停止就直接收尾
    const creator = await this.resolveCreator(service, creatorId, signal, known)
    if (!creator) {
      return
    }
    const creatorName = creator.name
    crawlProgress.setTarget(this.targetLabel(service, creatorId, creatorName))
    // Kemono 的 profile 有 post_count；Pawchive 沒有，維持未知
    const postCount = creator.profile?.post_count
    if (typeof postCount === 'number' && postCount > 0) {
      crawlProgress.setTotal(postCount)
    }

    let offset = 0
    let pageNo = 0
    // 本次列表已見過的帖子 id：API 若忽略 o= 會一直回同一頁，
    // 整頁都沒有新 id 就判定重複並停止，不必靠低頁數上限硬切
    const seenIds = new Set<string>()

    while (pageNo < MAX_PAGES) {
      if (signal.aborted) {
        return
      }

      const res = await this.attempt(
        async () => {
          const body = await api.posts(
            {
              service,
              creatorId,
              index: offset,
            },
            signal
          )
          if (isErrorResponse(body)) {
            throw new Error(body.error)
          }
          // null or an object is not a list; treat it as a failed request
          if (!Array.isArray(body)) {
            throw new Error('invalid posts response')
          }
          return body
        },
        signal,
        LIST_POLICY
      )
      if (!res.ok) {
        if (res.aborted) {
          return
        }
        log.error(lang.transl('_listFailed', errorText(res.error)))
        // Mark this run as cut short by the list failure (pageNo is 0-based, messages are 1-based)
        this.listFailedAtPage = pageNo + 1
        return
      }
      const items = res.value

      if (items.length === 0) {
        break
      }

      // 只處理沒見過的帖子（頁間若有重疊也不會重複入庫）
      const fresh = items.filter((it) => !seenIds.has(it.id))
      if (fresh.length === 0) {
        log.warning(lang.transl('_pageLoopDetected', String(offset)))
        return
      }
      for (const it of fresh) {
        seenIds.add(it.id)
      }
      crawlProgress.addPage()

      for (const it of fresh) {
        if (signal.aborted) {
          return
        }
        // File count and kinds come from the same helper as the full expansion
        const { fileCount, kinds } = summarizeListItem(it)
        const added = await this.crawlOnePost(
          it.service,
          it.user,
          it.id,
          creatorName,
          // 列表快篩資訊（省詳情請求）
          {
            title: it.title ?? '',
            published: it.published ?? '',
            fileCount,
            kinds,
            pending: isPendingPost(it),
          },
          signal
        )
        // idList 與 resultMeta 同口徑：只有真正入庫的帖子才登記
        if (added) {
          store.idList.push({
            id: makePostKey(it.service, it.user, it.id),
            type: 'post',
            title: it.title ?? '',
          })
        }
      }

      // 短頁 = 最後一頁
      if (items.length < PAGE_SIZE) {
        break
      }
      offset += PAGE_SIZE
      pageNo++
    }

    if (pageNo >= MAX_PAGES) {
      log.warning(lang.transl('_pageLimit', String(MAX_PAGES)))
    }
  }

  /** 帖子頁：單帖詳情 → 過濾 → 入庫 */
  private async crawlPost(
    service: KemonoService,
    creatorId: string,
    postId: string,
    signal: AbortSignal,
    known: Map<string, string>
  ): Promise<void> {
    crawlProgress.setTotal(1)
    // 暫停中會在發請求前等待；等待期間被停止就直接收尾
    const creator = await this.resolveCreator(service, creatorId, signal, known)
    if (!creator) {
      return
    }
    crawlProgress.setTarget(this.targetLabel(service, creatorId, creator.name))
    // 取 profile 期間可能已中止：不再發詳情請求
    if (signal.aborted) {
      return
    }
    const added = await this.crawlOnePost(
      service,
      creatorId,
      postId,
      creator.name,
      undefined,
      signal
    )
    if (added) {
      store.idList.push({
        id: makePostKey(service, creatorId, postId),
        type: 'post',
      })
    }
  }

  /** 單帖：列表快篩 → 詳情 → 完整過濾 → 入庫。回傳 true 表示真的入庫了 */
  private async crawlOnePost(
    service: KemonoService,
    creatorId: string,
    postId: string,
    creatorName: string,
    listInfo: ListInfo | undefined,
    signal: AbortSignal,
    /** Picked by hand: no filter applies */
    picked = false
  ): Promise<boolean> {
    // 進度統計：走到這裡就算檢查了一帖，之後必定落在 保留／排除／失敗 其中之一
    // （使用者中止的那一帖例外，不計）
    crawlProgress.scan()
    let postKey: string
    try {
      postKey = makePostKey(service, creatorId, postId)
    } catch (e) {
      // 未知 service 等非法零件：只跳過這一帖，不中斷整輪
      crawlProgress.fail()
      log.warning(
        lang.transl(
          '_postDetailFailed',
          `${service}/${creatorId}/${postId}`,
          errorText(e)
        )
      )
      return false
    }

    // 列表快篩：不通過則省一次詳情請求
    if (listInfo) {
      // 快篩只做同步條件（標題/日期/數量/種類開關/pending/ID 範圍），
      // 去重（需 storage I/O）留給完整過濾。服務條件已在 crawlCreator 前置檢查
      const reason = this.quickScreen(listInfo, postId)
      if (reason) {
        crawlProgress.exclude(reason)
        return false
      }
    }

    // 取詳情（429 退避重試；5xx／網路有限重試；其他錯誤跳過該帖，不中斷整輪）
    // The body is read once here, so it stays out of the api cache
    const res = await this.attempt(
      async () => {
        const body = await api.post({ service, creatorId, postId }, signal, {
          cache: false,
        })
        if (isErrorResponse(body)) {
          throw new Error(body.error)
        }
        return body
      },
      signal,
      DETAIL_POLICY
    )
    if (!res.ok) {
      if (res.aborted) {
        return false
      }
      crawlProgress.fail()
      log.error(lang.transl('_postDetailFailed', postKey, errorText(res.error)))
      return false
    }
    const data = res.value

    // fetch 期間用戶可能已按停止：回包後再檢查一次，避免多漏入一帖
    if (signal.aborted) {
      return false
    }

    // 展開 + 完整過濾
    const { pending, files } = expandPost(data, creatorName)
    const kinds = new Set(files.map((f) => f.kind))
    // Posts count their files without the text sidecar
    const fileCount = files.filter((f) => f.kind !== 'text').length

    // 入庫條目先建好：整帖去重的期望檔名與入庫用同一份，避免兩處展開不一致
    const meta: PostMeta = {
      postKey,
      service,
      creator: creatorName,
      creatorId,
      postId,
      title: data.post.title ?? '',
      published: data.post.published ?? '',
      fileCount,
      pending,
      // Carried into every file of the post (Store.addResult), so the download
      // skips the file type and size filters for it too
      ...(picked ? { picked: true } : {}),
    }
    const ok =
      picked ||
      filter.checkPost({
        service,
        postId,
        title: meta.title ?? '',
        published: meta.published ?? '',
        fileCount,
        kinds,
        pending,
      })
    if (!ok) {
      crawlProgress.exclude(filter.lastReason)
      return false
    }

    // 入庫前最後一次檢查：已中止就不入庫
    if (signal.aborted) {
      return false
    }

    // 入庫（Store 為每個檔案補上 id／fileIndex，並與 meta 合併）
    store.addResult(meta, files)
    crawlProgress.keep(files.length)
    return true
  }

  /** 列表快篩（同步條件 only；settings 直接讀，不碰 storage）。
   * 回傳排除原因（同 filter.lastReason 的命名），通過則回 null */
  private quickScreen(info: ListInfo, postId: string): string | null {
    const keyword = settings.get('filterTitle').trim().toLowerCase()
    if (keyword && !info.title.toLowerCase().includes(keyword)) {
      return 'title'
    }
    if (info.published) {
      const date = info.published.slice(0, 10)
      const from = settings.get('filterDateFrom')
      const to = settings.get('filterDateTo')
      if ((from && date < from) || (to && date > to)) {
        return 'date'
      }
    }
    const min = settings.get('filterMinFiles')
    const max = settings.get('filterMaxFiles')
    if (
      (min > 0 && info.fileCount < min) ||
      (max > 0 && info.fileCount > max)
    ) {
      return 'fileCount'
    }
    if (!filter.hasAllowedKind(info.kinds)) {
      return 'kind'
    }
    if (info.pending && settings.get('skipPendingPosts')) {
      return 'pending'
    }
    if (isPostIdOutOfRange(postId)) {
      return 'postId'
    }
    return null
  }
}

const engine = new Engine()
export { engine }
