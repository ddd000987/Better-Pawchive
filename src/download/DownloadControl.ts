/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/download/DownloadControl.ts
 *          (xuejianxianzun)
 * changes: slot UI (useSlot/addBtn/Show* helpers,
 *          BookmarkAfterDL, mobile warnings) removed — SettingsCenter owns
 *          the buttons and calls this module's public API. chrome.* messaging.
 *          Core kept: thread pool, taskBatch, success/skip routing,
 *          USER_CANCELED skip, error retry loop, waitingIdList drain,
 *          per-post completion ledger (DownloadedKeys).
 */

import { Config } from '../Config'
import { EVT } from '../EVT'
import { fileName } from '../filename/FileName'
import { lang } from '../Language'
import { log } from '../Log'
import { toast } from '../Toast'
import { store } from '../store/Store'
import { states } from '../store/States'
import { sleep } from '../Tools'
import { Download } from './Download'
import { downloadRecord } from './DownloadRecord'
import { localFileCheck } from './LocalFileCheck'
import { downloadStates } from './DownloadStates'
import {
  downloadArgument,
  DownloadSuccessData,
  DownloadSkipData,
  DownloadedMsg,
  TaskList,
} from './DownloadType'
import { precheckExisting } from './Precheck'
import { progressBar } from './ProgressBar'
import { settings } from '../setting/Settings'
import { skipByFolder, skipByRecord } from '../setting/skipMode'

class DownloadControl {
  constructor() {
    this.bindEvents()
  }

  private thread = Config.downloadThreadDefault

  private taskBatch = 0 // 標記任務批次，每次重新下載時改變它的值
  private taskList: TaskList = {} // 下載任務列表

  /** 有檔案下載失敗時，保存 id */
  private errorIdList: string[] = []

  /**
   * Consecutive saveRequestFailed replies in the current batch. Three in a row
   * look systemic (e.g. the naming rule makes every name illegal), so the
   * batch pauses instead of skipping everything.
   */
  private saveRequestFailStreak = 0
  /**
   * Files given up on in the current batch (browser refused to save them,
   * save dialog cancelled, HTTP 4xx). They count as finished, but the
   * completion message must say they were not saved. Survives pause, resume
   * and auto-retry rounds; cleared when a new batch begins.
   */
  private failedSkipCount = 0
  /** Max consecutive saveRequestFailed replies before the batch pauses */
  private static readonly SAVE_REQUEST_FAIL_MAX = 3

  /** 失敗批次的自動重試次數（退避重試，見 checkCompleteWithError） */
  private errorRetryCount = 0
  /** 自動重試的最大次數 */
  private static readonly ERROR_RETRY_MAX = 3

  /**
   * Save retries used so far, per file id. A transient save failure is retried
   * in place up to SAVE_RETRY_MAX times; this is separate from errorRetryCount,
   * which is the budget of the batch-level retry rounds.
   */
  private saveRetryCounts = new Map<string, number>()
  /** Max in-place retries of one file after a failed save */
  private static readonly SAVE_RETRY_MAX = 3
  /** 自動重試的退避等待（ms），按次數遞增 */
  private static readonly ERROR_RETRY_DELAYS = [30000, 60000, 120000]
  /** 重試世代：新抓取開始時遞增，舊的重試等待直接作廢 */
  private retryGeneration = 0
  /** 是否正處於自動重試的退避等待中 */
  private retryWait = false
  /** 退避等待期間用戶是否按過暫停（醒後保持暫停，不自動續跑） */
  private pauseRequested = false

  private downloaded = 0 // 已下載的任務數量
  private stop = false // 是否已經停止下載

  private pause = false // 是否已經暫停下載

  /** 當前批次是否為全部重下（跳過去重記錄）。createDownload 快照進 argument */
  private forceBatch = false

  /** 交給瀏覽器存檔後的逾時提醒：檔案 id → 計時器 */
  private saveTimers = new Map<string, number>()
  /** Ids handed over as direct (browser-fetched) downloads: no stuck timer */
  private directSaveIds = new Set<string>()
  /** The batch for which the "files were renamed" warning was already shown */
  private renameWarnedBatch = 0

  /**
   * Ids handed to the browser whose save receipt has not arrived yet, mapped
   * to the taskBatch they were sent under. File ids repeat across crawls, so a
   * receipt only counts when its taskBatch matches.
   */
  private savingIds = new Map<string, number>()
  /**
   * Saves that were in flight when the batch was paused and that the resumed
   * batch still counts as in progress (state 0), mapped to the old taskBatch
   * whose receipt is awaited. settleCarried handles that receipt. Cleared
   * whenever a batch is abandoned, completed or started from scratch.
   */
  private carriedIds = new Map<string, number>()
  /** True while startDownload waits for the background's answer on a resume */
  private resumeQuerying = false

  /** How long a resume waits for the background to report running saves (ms) */
  private static readonly QUERY_SAVING_TIMEOUT = 3000
  /** Reminder delay for a save that never reports back (ms) */
  private static readonly SAVE_STUCK_MS = 300000

  /** 等待隊列的排程器（避免多個事件同時觸發、重複排入下一輪） */
  private drainTimer: undefined | number = undefined

  // 類型守衛：只處理後台的下載回執（click_icon 等其他消息擋在外面）
  private isDownloadedMsg(msg: unknown): msg is DownloadedMsg {
    if (!msg || typeof msg !== 'object') return false
    const type = (msg as { msg?: unknown }).msg
    return type === 'downloaded' || type === 'download_err'
  }

  private bindEvents() {
    EVT.on(EVT.list.crawlStart, () => {
      this.reset()
      // 新抓取 → 重試計數歸零（reset 不再清它，見 checkCompleteWithError）
      this.errorRetryCount = 0
      this.carriedIds.clear()
      this.savingIds.clear()
      this.resetFailureCounters()
    })

    // 抓取被停止時，下載管線也停：不再接受新任務。
    // 若正在下載，補發 downloadStop 讓 States/Store 同步收尾，
    // 也讓在途 Download 透過 states.downloading 感知取消。
    EVT.on(EVT.list.stopCrawl, () => {
      this.stop = true
      this.pause = false
      this.resetFailureCounters()
      if (states.downloading) {
        EVT.fire('downloadStop')
      }
      // 用戶主動停止：排隊中的任務一併取消，避免下一輪抓取清掉保留的部分結果
      if (store.waitingIdList.length > 0 || store.waitingFullCrawl) {
        store.waitingIdList = []
        store.waitingFullCrawl = false
        log.warning(lang.transl('_queuedCancelled'))
      }
    })

    // crawlComplete 不在這裡處理：由 CrawlCache 決定是否掛載新結果後，
    // 再呼叫 readyDownload／drainAfterCrawl
    EVT.on(EVT.list.resultChange, () => {
      // 讓開始下載的方法進入事件佇列，以便其他監聽的模組先執行完畢
      window.setTimeout(() => {
        this.readyDownload()
      }, 0)
    })

    EVT.on(EVT.list.skipDownload, (ev: CustomEventInit) => {
      // 跳過下載的檔案不會觸發 downloadSuccess 事件
      const data = ev.detail.data as DownloadSkipData
      // A skip caused by a failure (not a duplicate/excluded/size skip) was
      // not saved, so the completion message must report it
      if (
        this.taskList[data.id] &&
        DownloadControl.FAILURE_SKIP_REASONS.includes(data.reason)
      ) {
        this.failedSkipCount++
      }
      this.downloadOrSkipAFile(data)
    })

    EVT.on(EVT.list.downloadError, (ev: CustomEventInit) => {
      const id = ev.detail.data as string
      this.downloadError(id)
    })

    // 保存檔案失敗事件原本有發無收；補全域監聽轉成提示
    EVT.on(EVT.list.saveFileError, () => {
      toast.error(lang.transl('_saveFileErrorToast'))
    })

    EVT.on(EVT.list.requestPauseDownload, () => {
      // 請求暫停下載
      this.pauseDownload()
    })

    // 瀏覽器保存檔案後長時間無回應（常見於另存為視窗卡住），提示用戶。
    // 多執行緒下要逐檔計時，否則別的檔案成功就會把卡住的檔案一起清掉
    EVT.on(EVT.list.sendBrowserDownload, (ev: CustomEventInit) => {
      const data = ev.detail?.data as
        { id?: string; fileName?: string; direct?: boolean } | undefined
      if (!data?.id) {
        return
      }
      const id = data.id
      const name = data.fileName ?? ''
      this.savingIds.set(id, this.taskBatch)
      // A direct download is fetched by the browser itself, and no progress
      // reaches this side: a big file on a slow link would trip the
      // "stuck" reminder falsely, so only blob saves get the timer
      if (data.direct) {
        this.directSaveIds.add(id)
        return
      }
      this.directSaveIds.delete(id)
      this.armSaveTimer(id, name)
    })

    // 單檔結束：只清該檔的計時器
    EVT.on(EVT.list.downloadError, (ev: CustomEventInit) => {
      this.clearSaveTimer(ev.detail?.data as string)
    })
    EVT.on(EVT.list.downloadSuccess, (ev: CustomEventInit) => {
      this.clearSaveTimer((ev.detail?.data as { id?: string } | undefined)?.id)
    })
    // 整批結束／暫停／停止：全部清掉
    const clearAllSaveTimersList = [
      EVT.list.downloadComplete,
      EVT.list.downloadPause,
      EVT.list.downloadStop,
      EVT.list.crawlStart,
    ]
    clearAllSaveTimersList.forEach((evt) => {
      EVT.on(evt, () => {
        this.clearAllSaveTimers()
      })
    })

    // 監聽瀏覽器返回的訊息
    chrome.runtime.onMessage.addListener((msg: unknown) => {
      if (!this.isDownloadedMsg(msg)) {
        return
      }

      // 回執到了就解除該檔的逾時提醒（不分批次，舊批次的計時器也要收掉）
      this.clearSaveTimer(msg.data?.id)
      // Only the receipt of the batch the save was sent under ends it: an older
      // batch (or the quick-download channel) may reuse the same file id
      if (
        msg.data?.id &&
        this.savingIds.get(msg.data.id) === msg.data.taskBatch
      ) {
        this.savingIds.delete(msg.data.id)
      }

      // 停止／換批後瀏覽器才存完的檔案：不動進度，但仍要登記下載記錄，
      // 否則下次開始會把這些已存好的檔案重下一遍
      if (
        msg.msg === 'downloaded' &&
        msg.data?.id &&
        (!this.taskBatch || msg.data.taskBatch !== this.taskBatch)
      ) {
        this.warnIfRenamed(msg.data)
        const work = store.findResult(msg.data.id)
        // A renamed file cannot be recognised later, so it gets no record
        if (work && !msg.data.uuid) {
          void downloadRecord.addRecord(work)
        }
      }

      // 舊批次的結果也需要釋放前台 Blob URL，但不能影響當前任務
      if (
        (msg.msg === 'downloaded' || msg.msg === 'download_err') &&
        msg.data?.blobURLFront
      ) {
        URL.revokeObjectURL(msg.data.blobURLFront)
      }

      // A save that was in flight when the batch was paused: the resumed batch
      // did not fetch it again, so settle it here
      // (only while a batch is active, and only for the batch it was sent under)
      if (
        this.taskBatch &&
        msg.data?.id &&
        this.carriedIds.get(msg.data.id) === msg.data.taskBatch &&
        msg.data.taskBatch !== this.taskBatch
      ) {
        this.settleCarried(msg)
        return
      }

      if (!this.taskBatch || msg.data?.taskBatch !== this.taskBatch) {
        return
      }

      // 檔案下載成功
      if (msg.msg === 'downloaded') {
        try {
          // 發送下載成功的事件
          EVT.fire('downloadSuccess', msg.data)
          this.saveRequestFailStreak = 0
          this.saveRetryCounts.delete(msg.data.id)
          this.warnIfRenamed(msg.data)
          // The file is saved, but under a name another extension chose: do
          // not record it, or the dedupe record would point at a name that
          // does not exist on disk
          this.downloadOrSkipAFile(msg.data, !msg.data.uuid)
        } catch (error) {
          console.error('downloaded 分支執行出錯', error)
        }
      } else if (msg.msg === 'download_err') {
        // 瀏覽器把檔案保存到本地失敗

        // The request to save was refused (illegal or too-long name, bad URL).
        // Retrying cannot help, so give up on this file and carry on. Several
        // in a row look systemic: pause so the user can fix the setting.
        if (msg.saveRequestFailed) {
          log.error(
            lang.transl(
              '_saveRequestFailed',
              msg.runtimeError || msg.err || 'unknown'
            )
          )
          this.saveRequestFailStreak++
          if (
            this.saveRequestFailStreak >= DownloadControl.SAVE_REQUEST_FAIL_MAX
          ) {
            // A resumed batch gets a fresh allowance
            this.saveRequestFailStreak = 0
            EVT.fire('saveFileError')
            this.pauseDownload()
            return
          }
          this.skipFailedFile(msg.data)
          return
        }

        // 用戶取消保存（另存為對話框取消等），跳過這個檔案（不記去重）
        if (msg.err === 'USER_CANCELED') {
          log.error(
            lang.transl('_userCanceledSave', msg.data.id),
            'userCanceledSave'
          )
          this.skipFailedFile(msg.data)
          return
        }

        // The disk is full or not writable: every further file would fail the
        // same way, so pause for the user to fix it instead of retrying
        if (DownloadControl.isDiskError(msg.err)) {
          this.pauseOnDiskError(msg.err, msg.data.id)
          return
        }

        // 其他原因，重試保存這個檔案
        log.error(
          lang.transl(
            '_saveFailedRetry',
            msg.data.id,
            msg.runtimeError || msg.err || 'unknown'
          ),
          'saveFailedRetry'
        )
        EVT.fire('saveFileError')
        this.saveFileError(msg.data)
      }
    })

    // 當下載完畢，或者抓取結果為空時，檢查是否有等待下載的任務
    const checkWaitingIdListEvents = [
      EVT.list.downloadComplete,
      EVT.list.crawlEmpty,
    ]
    checkWaitingIdListEvents.forEach((evt) => {
      EVT.on(evt, () => {
        // 如果有等待中的任務（ID 或整頁抓取），則開始下一輪
        if (store.waitingIdList.length === 0 && !store.waitingFullCrawl) {
          // 有結果才提示「下載完畢」：零結果（crawlEmpty）時不提示，避免誤解
          if (store.result.length > 0) {
            // failedSkipCount is not cleared by reset(), so it still holds this
            // batch's count here (the event fires after reset)
            if (this.failedSkipCount > 0) {
              toast.warning(
                lang.transl(
                  '_downloadFinishedWithFailed',
                  String(this.failedSkipCount)
                ),
                { position: 'center' }
              )
            } else {
              toast.success(lang.transl('_downloadFinishedToast'), {
                position: 'center',
              })
            }
          }

          // 通知後台清除保存的此標籤頁的 idList
          chrome.runtime.sendMessage({
            msg: 'clearDownloadsTempData',
          })
        } else {
          this.drainWaitingQueue()
        }
      })
    })
  }

  /** Skip reasons that mean the file was not saved because of a failure */
  private static readonly FAILURE_SKIP_REASONS: DownloadSkipData['reason'][] = [
    '4xx',
    '404',
    '500',
    'noUrl',
  ]

  /** chrome.downloads interrupt reasons that mean the disk cannot take files */
  private static readonly DISK_ERRORS = ['FILE_NO_SPACE', 'FILE_ACCESS_DENIED']

  private static isDiskError(err: string | undefined): err is string {
    return err !== undefined && DownloadControl.DISK_ERRORS.includes(err)
  }

  /** Report a disk error once and pause the batch so the user can fix it */
  private pauseOnDiskError(err: string, id: string) {
    // Several in-flight files fail together: say it once
    if (!this.pause) {
      const msg = lang.transl('_diskWriteFailedPaused', err, id)
      log.error(msg)
      toast.error(msg)
    }
    this.pauseDownload()
  }

  /**
   * Another extension renamed the saved file (the background saw a random
   * UUID name). Say so once per batch; the user has to disable that extension.
   */
  private warnIfRenamed(data: DownloadSuccessData) {
    if (!data.uuid || this.renameWarnedBatch === data.taskBatch) {
      return
    }
    this.renameWarnedBatch = data.taskBatch
    const msg = lang.transl('_filenameOverriddenByExtension')
    log.warning(msg)
    toast.warning(msg)
  }

  /** A new batch begins (or the batch is abandoned): forget failure counts */
  private resetFailureCounters() {
    this.saveRequestFailStreak = 0
    this.failedSkipCount = 0
    this.saveRetryCounts.clear()
  }

  /**
   * Give up on a file the browser could not save: mark it finished without a
   * dedupe record and count it, so the batch moves on and the completion
   * message reports it.
   */
  private skipFailedFile(data: DownloadSuccessData) {
    // Stale receipts are dropped by downloadOrSkipAFile; do not count them
    if (!this.taskList[data.id]) {
      return
    }
    // Count first: downloadOrSkipAFile may complete the batch
    this.failedSkipCount++
    this.downloadOrSkipAFile(data, false)
  }

  /** Remind the user when a save the browser took never reports back */
  private armSaveTimer(id: string, name: string) {
    this.clearSaveTimer(id)
    this.saveTimers.set(
      id,
      window.setTimeout(() => {
        this.saveTimers.delete(id)
        const stuck = lang.transl('_downloadStuck', id, name)
        log.warning(stuck, 'downloadStuck')
        // 用戶看不到 console，卡住要用 toast 提醒
        toast.warning(stuck)
      }, DownloadControl.SAVE_STUCK_MS)
    )
  }

  /** Re-arm the reminder of a carried save (the pause cleared all timers) */
  private armCarriedSaveTimer(id: string) {
    if (this.directSaveIds.has(id)) {
      return
    }
    const work = store.findResult(id)
    this.armSaveTimer(id, work ? fileName.createFileName(work) : '')
  }

  /**
   * Ask the background which of the saves we are waiting for are really still
   * running. Any failure, ill-formed reply or silence counts as "none", so the
   * files are fetched again (the behaviour before saves could be carried).
   */
  private async querySaving(): Promise<Map<string, number>> {
    const live = new Map<string, number>()
    if (this.savingIds.size === 0) {
      return live
    }
    let timer: number | undefined
    try {
      const reply: unknown = await Promise.race([
        chrome.runtime.sendMessage({
          msg: 'query_saving',
          ids: [...this.savingIds.keys()],
        }),
        new Promise<undefined>((resolve) => {
          timer = window.setTimeout(
            () => resolve(undefined),
            DownloadControl.QUERY_SAVING_TIMEOUT
          )
        }),
      ])
      const saving = (reply as { saving?: unknown } | null | undefined)?.saving
      if (!Array.isArray(saving)) {
        return live
      }
      for (const item of saving) {
        const { id, taskBatch } = (item ?? {}) as {
          id?: unknown
          taskBatch?: unknown
        }
        if (
          typeof id === 'string' &&
          typeof taskBatch === 'number' &&
          this.savingIds.get(id) === taskBatch
        ) {
          live.set(id, taskBatch)
        }
      }
    } catch {
      live.clear()
    } finally {
      window.clearTimeout(timer)
    }
    return live
  }

  private clearSaveTimer(id: string | undefined) {
    if (id === undefined) {
      return
    }
    const timer = this.saveTimers.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      this.saveTimers.delete(id)
    }
  }

  private clearAllSaveTimers() {
    for (const timer of this.saveTimers.values()) {
      window.clearTimeout(timer)
    }
    this.saveTimers.clear()
  }

  /** 取出等待隊列並排入下一輪；一次只排一個，避免整頁抓取與 ID 清單同時開跑 */
  private drainWaitingQueue(): boolean {
    if (this.drainTimer !== undefined) {
      return true
    }
    // 用戶已停止抓取：不接著開下一輪，保留現有部分結果
    // Tasks queued after the stop would otherwise survive into the user's next,
    // unrelated crawl and run after it, so drop them here
    if (states.stopCrawl) {
      if (store.waitingIdList.length > 0 || store.waitingFullCrawl) {
        store.waitingIdList = []
        store.waitingFullCrawl = false
        log.warning(lang.transl('_queuedCancelled'))
      }
      return false
    }
    if (store.waitingFullCrawl) {
      store.waitingFullCrawl = false
      this.drainTimer = window.setTimeout(() => {
        this.drainTimer = undefined
        EVT.fire('commandStartDefaultCrawl')
      }, 0)
      return true
    }
    if (store.waitingIdList.length === 0) {
      return false
    }
    const idList = [...store.waitingIdList]
    store.waitingIdList = []
    this.drainTimer = window.setTimeout(() => {
      this.drainTimer = undefined
      EVT.fire('crawlIdList', idList)
    }, 0)
    return true
  }

  /** 抓取完畢但不掛載新結果時：只處理等待中的下一輪（空結果則一併收起進度條） */
  public drainAfterCrawl() {
    if (states.busy || states.hasDownloadTask) {
      return
    }
    if (store.result.length === 0) {
      progressBar.reset(0)
    }
    this.drainWaitingQueue()
  }

  /** 抓取完畢之後更新狀態，並決定是否立即開始下載 */
  public readyDownload() {
    if (states.busy || states.hasDownloadTask) {
      return
    }
    if (store.result.length === 0) {
      progressBar.reset(0)
      // 排隊中的任務不能因為本輪空結果就一直卡住
      this.drainWaitingQueue()
      return
    }

    EVT.fire('readyDownload')

    this.setDownloaded()
    this.setDownloadThread()

    // 是否自動開始下載（用戶主動停止抓取後不自動開始，保留的部分結果由用戶手動下載）
    if (settings.get('autoStartDownload') && !states.stopCrawl) {
      this.startDownload()
    } else {
      // 不自動下載時，這輪抓取已經結束，直接處理等待中的下一輪
      this.drainWaitingQueue()
    }
  }

  /** 手動開始／重下共用的前置檢查 */
  private async prepareStart(): Promise<boolean> {
    // 等設定載入完成，否則執行緒數等會用預設值
    await states.waitSettingInitialized()
    if (states.busy) {
      toast.error(lang.transl('_taskBusy'))
      return false
    }

    if (store.result.length === 0) {
      toast.error(lang.transl('_noMountedCache'))
      return false
    }

    // 略過已存在檔案：手動點擊帶有使用者操作，可以彈出授權提示；
    // 自動開始沒有，prepare 會回 false，之後 exists() 只警告一次、照常下載
    if (skipByFolder(settings.get('skipDownloaded'))) {
      await localFileCheck.prepare(true)
    }

    return true
  }

  // 開始下載
  public async startDownload() {
    // A resume is waiting for the background: ignore a second click
    if (this.resumeQuerying) {
      return
    }
    if (!(await this.prepareStart())) {
      return
    }
    if (this.resumeQuerying) {
      return
    }

    let live = new Map<string, number>()
    if (this.pause) {
      this.resumeQuerying = true
      try {
        live = await this.querySaving()
      } finally {
        this.resumeQuerying = false
      }
    }

    // The user may have stopped the batch while the query was pending
    if (this.pause) {
      // 從上次中斷的位置繼續下載
      // Files the background confirms are still being saved stay "in progress"
      // and are not fetched again; their receipts carry the old taskBatch and
      // are handled by settleCarried. Everything else is fetched again.
      downloadStates.resume(new Set(live.keys()))
      this.carriedIds = new Map(
        [...live].filter(([id]) => {
          const index = downloadStates.findIndexById(id)
          return index !== -1 && downloadStates.states[index] === 0
        })
      )
      for (const id of [...this.savingIds.keys()]) {
        if (!live.has(id)) {
          this.savingIds.delete(id)
        }
      }
      // downloadPause cleared the reminders; carried saves still need one
      for (const id of this.carriedIds.keys()) {
        this.armCarriedSaveTimer(id)
      }
    } else {
      // 重新下載：初始化下載狀態列表
      downloadStates.init()
      this.carriedIds.clear()
      this.savingIds.clear()
      this.resetFailureCounters()
      // A fresh start drops force mode. Resuming a paused batch keeps it, so
      // a paused "restart all" does not fall back to skipping duplicates.
      this.forceBatch = false
    }

    // 手動開始：重試計數歸零
    this.errorRetryCount = 0
    void this.beginFreshDownload()
  }

  // 全部重下：忘記已下載進度，全部重新下載（暫停後亦然）
  public async restartDownload() {
    if (!(await this.prepareStart())) {
      return
    }

    // 無條件初始化狀態列表：已完成的 1 也回到 -1
    downloadStates.init()
    this.carriedIds.clear()
    this.savingIds.clear()
    this.resetFailureCounters()

    // 手動全部重下：重試計數歸零，本批跳過下載記錄去重
    this.errorRetryCount = 0
    this.forceBatch = true
    void this.beginFreshDownload()
  }

  /** 共用啟動流程：重置批次標記＋整批比對已存在檔案＋建立並發執行緒 */
  private async beginFreshDownload() {
    localFileCheck.beginBatch()
    this.reset()
    this.taskBatch = Date.now() // 修改本批下載任務的標記
    this.taskList = {} // 重置下載任務列表
    const batch = this.taskBatch

    // 先進入下載中：比對期間不會被重複開始，按鈕也立刻變成「停止」
    EVT.fire('downloadStart')

    // 全部重下不比對；兩個來源都關閉時也不用比
    const skipMode = settings.get('skipDownloaded')
    const useRecord = skipByRecord(skipMode)
    const useFolder = skipByFolder(skipMode)
    if (!this.forceBatch && (useRecord || useFolder)) {
      try {
        const { byRecord, byFolder } = await precheckExisting({
          results: store.result,
          states: downloadStates.states,
          useRecord,
          useFolder,
          checkRecord: (r) => downloadRecord.checkDeduplication(r),
          existsMany: (p) => localFileCheck.existsMany(p),
          nameOf: (r) => fileName.createFileName(r),
        })
        // 比對期間被停止／暫停／換批：不再建立執行緒
        if (this.taskBatch !== batch || this.stop || this.pause) {
          return
        }
        // 直接標成已完成（不寫下載記錄，行為與逐檔跳過一致）
        for (const i of [...byRecord, ...byFolder]) {
          downloadStates.setState(i, 1)
        }
        if (byRecord.length + byFolder.length > 0) {
          const summary = lang.transl(
            '_precheckSummary',
            String(byRecord.length),
            String(byFolder.length)
          )
          toast.show(summary)
          log.log(summary)
        }
      } catch (error) {
        // 比對失敗不能擋住下載：當作沒有任何命中，照常下載
        console.error('[PawchivePro] precheck failed', error)
        if (this.taskBatch !== batch || this.stop || this.pause) {
          return
        }
      }
    }

    this.setDownloaded()

    // 全部都已存在：setDownloaded 已觸發下載完成並 reset（downloaded 歸零），
    // 這裡直接收尾，不能再重設進度條（會顯示 0/N）、建執行緒或提示「開始下載」
    if (downloadStates.downloadedCount() >= store.result.length) {
      return
    }

    this.setDownloadThread()

    // 建立並發下載執行緒
    for (let i = 0; i < this.thread; i++) {
      window.setTimeout(() => {
        this.createDownload(i)
      }, 0)
    }

    toast.show(lang.transl('_downloadStarted'))
    log.log(lang.transl('_downloading'))
  }

  // 暫停下載
  public pauseDownload() {
    if (store.result.length === 0) {
      return
    }

    // 停止的優先級高於暫停
    if (this.stop === true) {
      return
    }

    if (this.pause === false) {
      // 如果正在下載中
      if (states.busy) {
        this.pause = true
        log.warning(lang.transl('_downloadPaused'))

        EVT.fire('downloadPause')
      } else {
        // 不在下載中的話不允許啟用暫停功能
        return
      }
    } else if (this.retryWait) {
      // 退避等待中已處於暫停態；記下用戶的暫停意圖，醒後不自動續跑
      this.pauseRequested = true
    }
  }

  /** 停止下載。quiet：不彈「停止後不保留中斷點」提示（下載佇列換下一筆時用） */
  public stopDownload(opts: { quiet?: boolean } = {}) {
    // 沒有下載任務時不處理，避免把已完成的進度歸零
    if (store.result.length === 0 || this.stop || !states.hasDownloadTask) {
      return
    }

    this.stop = true
    log.error(lang.transl('_downloadStopped'))
    this.pause = false

    EVT.fire('downloadStop')

    // 停止＝徹底停下：批次作廢（在途任務變成舊批次，遲到的回執不再動進度），
    // 狀態與進度全部歸零
    this.taskBatch = 0
    this.carriedIds.clear()
    this.savingIds.clear()
    this.resetFailureCounters()
    downloadStates.init()
    this.downloaded = 0
    store.remainingDownload = store.result.length
    progressBar.clear()
    // 停止後不保留中斷點：再次開始會重新處理未完成項目，明確提示用戶
    if (!opts.quiet) toast.warning(lang.transl('_downloadStopNoResume'))
  }

  /**
   * Receipt for a save that was carried over a pause/resume (old taskBatch).
   * The resumed batch never fetched this file again, and its worker chains keep
   * themselves going, so only the state and the progress are updated here. The
   * download record of a successful save was already added by the stale-receipt
   * branch of the message handler.
   */
  private settleCarried(msg: DownloadedMsg) {
    const id = msg.data.id
    this.carriedIds.delete(id)

    if (msg.msg === 'downloaded') {
      EVT.fire('downloadSuccess', msg.data)
      downloadStates.setStateById(id, 1) // false: the post was deleted
      this.setDownloaded()
      return
    }

    // The file was not saved and retrying cannot help: count it as skipped
    if (msg.saveRequestFailed) {
      log.error(
        lang.transl(
          '_saveRequestFailed',
          msg.runtimeError || msg.err || 'unknown'
        )
      )
    } else if (msg.err === 'USER_CANCELED') {
      log.error(lang.transl('_userCanceledSave', id), 'userCanceledSave')
    }
    if (msg.saveRequestFailed || msg.err === 'USER_CANCELED') {
      this.failedSkipCount++
      downloadStates.setStateById(id, 1)
      this.setDownloaded()
      return
    }

    // Disk full / not writable: pause. The file stays "in progress", so the
    // resumed batch fetches it again
    if (DownloadControl.isDiskError(msg.err)) {
      this.pauseOnDiskError(msg.err, id)
      return
    }

    // Any other failure: let the batch-level retry round fetch it again
    log.error(
      lang.transl(
        '_saveFailedRetry',
        id,
        msg.runtimeError || msg.err || 'unknown'
      ),
      'saveFailedRetry'
    )
    if (downloadStates.findIndexById(id) === -1) {
      this.setDownloaded()
      return
    }
    this.errorIdList.push(id)
    downloadStates.markFailedById(id)
    void this.checkCompleteWithError()
  }

  private downloadError(id: string) {
    // 舊批次殘留回執（taskList 已重建）直接丟棄，避免污染 errorIdList
    const task = this.taskList[id]
    if (!task) {
      return
    }
    // 下載中刪帖：回執已無對應結果，安全丟棄
    if (downloadStates.findIndexById(id) === -1) {
      delete this.taskList[id]
      // 被刪的可能是最後一個在途項目，仍要檢查是否已全部完成
      this.setDownloaded()
      return
    }
    this.errorIdList.push(id)
    // Let ordered downloads move past this file instead of waiting forever
    downloadStates.markFailedById(id)

    // 是否繼續下載
    const no = task.progressBarIndex
    if (this.checkContinueDownload()) {
      this.createDownload(no)
    } else {
      this.checkCompleteWithError()
    }
  }

  /** gaveUp: the batch ends because the auto-retry rounds ran out */
  private setDownloaded(gaveUp = false) {
    this.downloaded = downloadStates.downloadedCount()

    // 設置總下載進度條
    progressBar.setTotalProgress(this.downloaded)

    store.remainingDownload = store.result.length - this.downloaded

    // 所有檔案正常下載完畢（跳過下載的檔案也算正常下載）
    if (this.downloaded === store.result.length) {
      if (this.failedSkipCount > 0) {
        log.warning(
          lang.transl(
            '_downloadFinishedWithFailed',
            String(this.failedSkipCount)
          )
        )
      } else {
        log.success(lang.transl('_downloadFinished'))
      }

      window.setTimeout(() => {
        // 延後觸發下載完成的事件（派生事件晚於上游事件）
        if (gaveUp) {
          // The download queue marks the item as partly failed on this event.
          // It goes first so the downloadComplete right after finds no
          // current item and the queue advances only once.
          EVT.fire('downloadGiveUp')
        }
        EVT.fire('downloadComplete')
      }, 0)
      // The batch is over: a receipt that shows up later must not settle it
      this.carriedIds.clear()
      this.reset()
    }

    this.checkCompleteWithError()
  }

  // 設置下載執行緒數量
  private setDownloadThread() {
    const setThread = settings.get('downloadThread')
    if (
      setThread < 1 ||
      setThread > Config.downloadThreadMax ||
      isNaN(setThread)
    ) {
      // 防禦性回退（設定已在寫入時清洗，正常不會走到這裡）
      this.thread = Config.downloadThreadDefault
    } else {
      this.thread = setThread // 設置為用戶輸入的值
    }

    // 如果剩餘任務數量少於下載執行緒數
    if (store.result.length - this.downloaded < this.thread) {
      this.thread = store.result.length - this.downloaded
    }

    // 重設下載進度條
    progressBar.reset(this.thread, this.downloaded)
  }

  private async saveFileError(data: DownloadSuccessData) {
    if (this.pause || this.stop) {
      return false
    }

    // Each file gets its own retry allowance, so failures elsewhere in a big
    // batch do not use up the batch-level retry budget. When it runs out the
    // file counts as failed; dropping the entry lets a later batch-level retry
    // round give it a fresh allowance.
    const used = this.saveRetryCounts.get(data.id) ?? 0
    if (used >= DownloadControl.SAVE_RETRY_MAX) {
      this.saveRetryCounts.delete(data.id)
      this.downloadError(data.id)
      return false
    }
    this.saveRetryCounts.set(data.id, used + 1)

    const taskBatch = this.taskBatch
    await sleep(3000)
    // 等待期間可能暫停、停止或重新開始，不能繼續舊任務的重試
    if (this.pause || this.stop || this.taskBatch !== taskBatch) {
      return false
    }
    const task = this.taskList[data.id]
    if (!task) {
      return false
    }
    // 復位這個任務的狀態；刪帖後找不到 id 就丟棄
    if (!downloadStates.setStateById(data.id, -1)) {
      delete this.taskList[data.id]
      return false
    }
    // 建立下載任務，再次下載它
    this.createDownload(task.progressBarIndex)
  }

  private downloadOrSkipAFile(
    data: DownloadSuccessData | DownloadSkipData,
    record = true
  ) {
    // 舊批次殘留回執（taskList 已重建）直接丟棄，避免把新任務誤標完成
    const task = this.taskList[data.id]
    if (!task) {
      return
    }

    try {
      // 更改這個任務狀態為“已完成”；下載中刪帖則安全丟棄回執
      // （按 id 定位，避免刪掉前面的項目後索引錯位）
      if (!downloadStates.setStateById(data.id, 1)) {
        delete this.taskList[data.id]
        // 被刪的可能是最後一個在途項目，仍要檢查是否已全部完成
        this.setDownloaded()
        return
      }

      // 瀏覽器存檔成功的檔案才登記去重（skip 的帶 reason，不登記）
      if (record && !('reason' in data)) {
        const work = store.findResult(data.id)
        if (work) {
          void downloadRecord.addRecord(work)
        }
      }

      // 統計已下載數量
      this.setDownloaded()

      // 是否繼續下載
      const no = task.progressBarIndex
      if (this.checkContinueDownload()) {
        this.createDownload(no)
      }
    } catch (error) {
      // 捕獲推進任務時的異常，避免任務卡住卻沒有提示
      console.error('downloadOrSkipAFile 執行出錯', error)
    }
  }

  // 當一個檔案下載成功或失敗之後，檢查是否還有後續下載任務
  private checkContinueDownload() {
    // 如果沒有全部下載完畢
    if (this.downloaded < store.result.length) {
      // 如果任務已停止
      if (this.pause || this.stop) {
        return false
      }
      // 如果已完成的數量 加上 執行緒中未完成的數量，仍然沒有達到檔案總數，繼續添加任務
      if (this.downloaded + this.thread - 1 < store.result.length) {
        return true
      } else {
        return false
      }
    } else {
      return false
    }
  }

  // 查找需要進行下載的作品，建立下載
  private createDownload(progressBarIndex: number) {
    const index = downloadStates.getFirstDownloadItem()
    if (index === undefined) {
      // 當已經沒有需要下載的作品時，檢查是否帶著錯誤完成了下載
      return this.checkCompleteWithError()
    } else {
      const workData = store.result[index]
      const argument: downloadArgument = {
        id: workData.id,
        result: workData,
        index: index,
        progressBarIndex: progressBarIndex,
        taskBatch: this.taskBatch,
        force: this.forceBatch,
      }
      // 批次快照：後續 taskBatch 被新批次覆寫時，此任務即為殘留
      argument.cancelled = () => argument.taskBatch !== this.taskBatch

      // 保存任務信息
      this.taskList[workData.id] = {
        index,
        progressBarIndex: progressBarIndex,
      }

      // 建立下載
      new Download(progressBarIndex, argument, index)
    }
  }

  // 在有下載出錯的情況下，是否已經完成了下載
  private async checkCompleteWithError() {
    if (
      this.errorIdList.length > 0 &&
      this.downloaded + this.errorIdList.length === store.result.length
    ) {
      // 重試用完：報错並結束本批，不再無限重開（用戶可手動重新下載失敗的檔案）
      if (this.errorRetryCount >= DownloadControl.ERROR_RETRY_MAX) {
        log.error(
          lang.transl('_retryGiveUp', String(DownloadControl.ERROR_RETRY_MAX))
        )
        // End the batch as "complete with failures", once: the failed files
        // count as finished-but-not-saved, so the normal completion path runs
        // (downloadComplete, waiting work drains, temp data is cleared) and
        // nothing is left in the downloading state
        this.failedSkipCount += this.errorIdList.length
        for (const failedId of this.errorIdList) {
          downloadStates.setStateById(failedId, 1)
        }
        this.errorIdList = []
        this.setDownloaded(true)
        return
      }
      // 退避重試：常態 429 下固定 2 秒重開等於無限迴圈，這裡按次數退避
      this.errorRetryCount++
      const delay =
        DownloadControl.ERROR_RETRY_DELAYS[
          Math.min(
            this.errorRetryCount - 1,
            DownloadControl.ERROR_RETRY_DELAYS.length - 1
          )
        ]
      const generation = this.retryGeneration
      this.retryWait = true
      this.pauseRequested = false
      // 進入暫停狀態，等待一段時間後自動開始下載，重試下載出錯的檔案
      this.pauseDownload()
      log.log(
        lang.transl(
          '_retryFailedIn',
          String(this.errorIdList.length),
          String(delay / 1000),
          String(this.errorRetryCount),
          String(DownloadControl.ERROR_RETRY_MAX)
        )
      )
      await sleep(delay)
      this.retryWait = false
      const userPaused = this.pauseRequested
      this.pauseRequested = false
      // 等待期間用戶手動暫停／停止／開始了新抓取或新下載，舊的重試作廢
      if (userPaused || this.stop || generation !== this.retryGeneration) {
        return
      }
      // 自動重試走接續路徑（保留 errorRetryCount；若調 startDownload
      // 會被手動入口清零，ERROR_RETRY_MAX 永遠到不了）
      downloadStates.resume(new Set(this.carriedIds.keys()))
      void this.beginFreshDownload()
    }
  }

  private reset() {
    this.pause = false
    this.stop = false
    this.errorIdList = []
    this.downloaded = 0
    this.retryWait = false
    this.pauseRequested = false
    // 注意：不清 drainTimer。排程已把這批 id 從 waitingIdList 取出，
    // 若在此取消，遇到「排程後立刻開始新一輪」的窄窗口就會丟掉排隊任務。
    // 觸發時若引擎正忙，會由引擎重新排回等待隊列。
    // 舊批次的回執一律作廢：0 表示目前沒有有效批次
    this.taskBatch = 0
    // 注意：errorRetryCount 不在此清零，否則自動重試每次都從 0 開始、
    // ERROR_RETRY_MAX 永遠觸發不了。手動開始／重下／新抓取各自清零
    this.retryGeneration++
  }
}

const downloadControl = new DownloadControl()
export { downloadControl }
