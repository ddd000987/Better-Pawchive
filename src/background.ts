/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/serviceWorker/background.ts
 * changes:
 *   - browser.* → chrome.* (no webextension-polyfill)
 *   - DELETED: save_novel_*, save_novel_series_file, save_work_file_a_download
 *     (novel pipeline + ugoira a.download fast path not in scope)
 *   - KEPT: save_work_file + clearDownloadsTempData (download temp cleanup,
 *     NOT novel-specific) + batchNo/idList/dlData persistence for SW
 *     hibernation survival
 *   - DELETED: no_reply / save_description_file (nothing sends them)
 */

import './folder/folderService'
import './viewer/viewerService'

interface SaveFileMsg {
  msg: string
  fileName?: string
  id?: string
  taskBatch?: number
  blobURL?: string
  dataURL?: string
  /** 遠端檔案網址：大檔由瀏覽器直接下載（非 blob/data URL） */
  url?: string
  blob?: Blob
  conflictAction?: chrome.downloads.FilenameConflictAction
  /** 快下通道與主下載分開記錄批次／idList */
  channel?: 'quick'
}

interface DlRecord {
  blobURLFront?: string
  blobURLBack?: string
  id?: string
  tabId: number
  taskBatch?: number
  /** The saved file got a random UUID name that we did not ask for (another
   * extension overrode the name) */
  uuid?: boolean
  browserSetFilename?: string
  /** The file name we asked the browser to use */
  requestedName?: string
  /** batchNo/idList 的分槽鍵（重啟後仍能釋放正確的 id） */
  slot?: string
  /** When the record was created (ms). Missing on records from older versions */
  t?: number
}

type BatchNoMap = Record<string, number>
type IdListMap = Record<string, string[]>

let dlData: Record<string, DlRecord> = {}
let batchNo: BatchNoMap = {}
let idList: IdListMap = {}

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url || tab.id === undefined) return
  chrome.tabs
    .sendMessage(tab.id, { msg: 'click_icon' })
    .catch((e) => console.warn('Send click_icon failed', e))
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ batchNo: {}, idList: {} })
})

function setData(data: Record<string, unknown>): Promise<void> {
  return chrome.storage.local.set(data)
}

let restorePromise: Promise<void> | undefined
function restoreDownloadData(): Promise<void> {
  if (!restorePromise) {
    restorePromise = chrome.storage.local
      .get(['batchNo', 'idList', 'dlData'])
      .then((data) => {
        batchNo = (data.batchNo as BatchNoMap) || {}
        idList = (data.idList as IdListMap) || {}
        dlData = (data.dlData as Record<string, DlRecord>) || {}
      })
  }
  return restorePromise
}

let saveChain: Promise<void> = Promise.resolve()
function saveDLData(): Promise<void> {
  const save = () =>
    setData({ dlData }).catch((e) => console.error('save dlData failed', e))
  saveChain = saveChain.then(save, save)
  return saveChain
}

/** batchNo/idList 的分槽鍵：快下用 `${tabId}:quick`，其餘沿用純 tabId */
function slotOf(tabId: number, channel?: string): string {
  return channel === 'quick' ? `${tabId}:quick` : String(tabId)
}

async function releaseDownloadId(
  slot: string,
  taskBatch?: number,
  id?: string
) {
  if (id === undefined || batchNo[slot] !== taskBatch) return
  const ids = idList[slot]
  const idx = ids?.indexOf(id) ?? -1
  if (idx < 0) return
  ids.splice(idx, 1)
  await setData({ idList }).catch((e) => console.error('save idList failed', e))
}

function isMsg(msg: unknown): msg is SaveFileMsg {
  return (
    !!msg &&
    typeof msg === 'object' &&
    'msg' in (msg as Record<string, unknown>)
  )
}

function getFileURL(msg: SaveFileMsg): string {
  // 大檔直下優先：遠端網址直接交給 downloads API
  if (msg.url) return msg.url
  if (msg.dataURL) return msg.dataURL
  if (msg.blobURL) return msg.blobURL
  console.error('No usable download URL')
  return ''
}

/** URL schemes a save request may use: remote files, page blobs, data URLs */
const ALLOWED_URL_PROTOCOLS = new Set(['https:', 'blob:', 'data:'])

/**
 * Check a save_work_file request before it reaches chrome.downloads.
 * Returns why it is refused, or null when it is acceptable. The file name is
 * relative to the downloads folder: no absolute path, no ".." segment.
 */
function checkSaveRequest(msg: SaveFileMsg): string | null {
  const url = msg.url || msg.dataURL || msg.blobURL
  if (!url) {
    return 'No usable download URL'
  }
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    return 'Invalid download URL'
  }
  if (!ALLOWED_URL_PROTOCOLS.has(protocol)) {
    return `Download URL scheme not allowed: ${protocol}`
  }
  const name = msg.fileName
  if (typeof name !== 'string' || name.trim() === '') {
    return 'Invalid file name'
  }
  if (/^[\\/]/.test(name)) {
    return 'File name must be relative'
  }
  if (name.split(/[\\/]/).includes('..')) {
    return 'File name must not contain ".." segments'
  }
  return null
}

/** The record a download_err reply carries when no browser download exists */
function failureRecord(msg: SaveFileMsg, tabId: number): DlRecord {
  return {
    blobURLFront: msg.blobURL,
    blobURLBack: '',
    id: msg.id,
    tabId,
    taskBatch: msg.taskBatch,
    uuid: false,
    requestedName: msg.fileName,
    slot: slotOf(tabId, msg.channel),
    t: Date.now(),
  }
}

// Blob URLs are made by the page and revoked by it when the receipt arrives:
// a service worker has another origin, so revoking them here would do nothing.

chrome.runtime.onMessage.addListener((rawMsg, sender) => {
  if (!isMsg(rawMsg)) {
    console.warn('Invalid msg:', rawMsg)
    return false
  }
  // Answered by the query_saving listener below
  if (rawMsg.msg === 'query_saving') {
    return false
  }
  // Only this extension's own content scripts and pages
  if (sender.id !== chrome.runtime.id) {
    return false
  }
  const msg = rawMsg
  // 是否已回覆過 download_err，避免外層 catch 重複回執
  let replied = false
  ;(async () => {
    try {
      await restoreDownloadData()
      const tabId = sender.tab?.id
      if (tabId === undefined) return
      // Anything but the two known values falls back to the default
      const conflictAction =
        msg.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify'

      // 作品檔案下載
      if (msg.msg === 'save_work_file') {
        const problem = checkSaveRequest(msg)
        if (problem) {
          console.warn('Rejected save request:', problem)
          replied = true
          await chrome.tabs
            .sendMessage(tabId, {
              msg: 'download_err',
              data: failureRecord(msg, tabId),
              err: problem,
              // Same as a failed create: retrying cannot help
              saveRequestFailed: true,
            })
            .catch((e) => console.error('Reply download_err failed', e))
          return
        }
        const slot = slotOf(tabId, msg.channel)
        if (batchNo[slot] !== msg.taskBatch) {
          batchNo[slot] = msg.taskBatch as number
          idList[slot] = []
          setData({ batchNo, idList })
        }
        // storage 不一致或剛被 clearDownloadsTempData 清掉時補回陣列
        idList[slot] ??= []
        if (!idList[slot].includes(msg.id as string)) {
          idList[slot].push(msg.id as string)
          setData({ idList })
          const data: DlRecord = {
            // 直下模式沒有前台 blobURL；遠端 url 不記進這個欄位，
            // 避免完成回執時被當成 blob URL 處理
            blobURLFront: msg.blobURL,
            blobURLBack: '',
            id: msg.id,
            tabId,
            taskBatch: msg.taskBatch,
            uuid: false,
            requestedName: msg.fileName,
            slot,
            t: Date.now(),
          }
          try {
            const url = getFileURL(msg)
            const downloadId = await chrome.downloads.download({
              url,
              filename: msg.fileName,
              conflictAction,
              saveAs: false,
            })
            dlData[downloadId] = data
            await saveDLData()
          } catch (error) {
            console.error('Create download failed', error)
            await releaseDownloadId(slot, data.taskBatch, data.id)
            const runtimeError =
              error instanceof Error ? error.message : String(error)
            replied = true
            await chrome.tabs
              .sendMessage(tabId, {
                msg: 'download_err',
                data,
                err: runtimeError,
                // 建立請求即失敗（非法檔名／非法 URL 等）重試也不會好，
                // 前台收到後直接暫停（見 DownloadControl 的 saveRequestFailed 分支）
                saveRequestFailed: true,
              })
              .catch((e) => console.error('Reply download_err failed', e))
          }
        }
      }

      if (msg.msg === 'clearDownloadsTempData') {
        if (sender.tab?.id !== undefined) {
          // 只清主下載槽；快下槽由 quickDownload 自己的回執清理
          const tid = String(sender.tab.id)
          delete idList[tid]
          delete batchNo[tid]
          setData({ batchNo, idList })
        }
      }
    } catch (error) {
      // 外層兜底：避免 async IIFE 的例外變成無人處理的 rejection（下載無聲丟失）
      console.error('Handle message failed', error)
      const tabId = sender.tab?.id
      if (msg.msg === 'save_work_file' && !replied && tabId !== undefined) {
        const runtimeError =
          error instanceof Error ? error.message : String(error)
        chrome.tabs
          .sendMessage(tabId, {
            msg: 'download_err',
            data: failureRecord(msg, tabId),
            err: runtimeError,
            saveRequestFailed: true,
          })
          .catch((e) => console.error('Reply download_err failed', e))
      }
    }
  })()
  return false
})

/**
 * Which of the given file ids does the browser still have a download in
 * progress for? Asked by a tab that is resuming a paused batch, so it only
 * carries saves that can still report back.
 */
interface QuerySavingMsg {
  msg: 'query_saving'
  ids: string[]
}

function isQuerySavingMsg(msg: unknown): msg is QuerySavingMsg {
  if (!msg || typeof msg !== 'object') return false
  const m = msg as { msg?: unknown; ids?: unknown }
  return (
    m.msg === 'query_saving' &&
    Array.isArray(m.ids) &&
    m.ids.every((id) => typeof id === 'string')
  )
}

chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
  if (
    !rawMsg ||
    typeof rawMsg !== 'object' ||
    (rawMsg as { msg?: unknown }).msg !== 'query_saving'
  ) {
    return false
  }
  // Only this extension's own content scripts and pages
  if (sender.id !== chrome.runtime.id) {
    return false
  }
  const tabId = sender.tab?.id
  if (!isQuerySavingMsg(rawMsg) || tabId === undefined) {
    sendResponse({ saving: [] })
    return false
  }
  const wanted = new Set(rawMsg.ids)
  ;(async () => {
    try {
      await restoreDownloadData()
      const saving: { id: string; taskBatch: number }[] = []
      for (const [downloadId, rec] of Object.entries(dlData)) {
        if (
          rec.tabId !== tabId ||
          rec.id === undefined ||
          rec.taskBatch === undefined ||
          !wanted.has(rec.id)
        ) {
          continue
        }
        const items = await chrome.downloads.search({ id: Number(downloadId) })
        if (items?.[0]?.state === 'in_progress') {
          saving.push({ id: rec.id, taskBatch: rec.taskBatch })
        }
      }
      sendResponse({ saving })
    } catch (error) {
      console.error('Handle query_saving failed', error)
      sendResponse({ saving: [] })
    }
  })()
  return true
})

const UUIDNameRegexp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]*)?$/i

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? ''
}

/**
 * The saved file is named like a random UUID although we asked for another
 * name: some other extension's onDeterminingFilename overrode ours. A file
 * whose requested name is a UUID itself (taken from the post) does not count.
 */
function isOverriddenByUuid(saved: string, requested?: string): boolean {
  const name = baseName(saved)
  if (!UUIDNameRegexp.test(name)) return false
  return requested === undefined || baseName(requested) !== name
}

chrome.downloads.onChanged.addListener(async (detail) => {
  await restoreDownloadData()
  const rec = dlData[detail.id]
  if (!rec) return
  let msg = ''
  let err = ''
  if (detail.filename?.current) {
    if (isOverriddenByUuid(detail.filename.current, rec.requestedName)) {
      rec.uuid = true
    }
    rec.browserSetFilename = detail.filename.current
  }
  if (detail.state?.current === 'complete') msg = 'downloaded'
  if (detail.error?.current) {
    msg = 'download_err'
    err = detail.error.current
    await releaseDownloadId(
      rec.slot ?? String(rec.tabId),
      rec.taskBatch,
      rec.id
    )
  }
  if (msg) {
    chrome.tabs
      .sendMessage(rec.tabId, { msg, data: rec, err })
      .catch((e) => console.error('Send download result failed', e))
    delete dlData[detail.id]
  }
  await saveDLData()
})

/** Records younger than this are never pruned: their events may still come */
const DL_RECORD_GRACE_MS = 60_000

/**
 * Drop dlData entries that can never be answered: the tab is gone (ids are
 * reused after a restart) or the browser no longer has the download in
 * progress (e.g. it was interrupted by a crash, so no event will come).
 * When the state cannot be read the entry is kept.
 */
async function pruneDlData() {
  const tabAlive = new Map<number, boolean>()
  let changed = false
  for (const [key, rec] of Object.entries(dlData)) {
    if (rec.t !== undefined && Date.now() - rec.t < DL_RECORD_GRACE_MS) {
      continue
    }
    let stale = false
    try {
      let alive = tabAlive.get(rec.tabId)
      if (alive === undefined) {
        alive = await chrome.tabs.get(rec.tabId).then(
          () => true,
          () => false
        )
        tabAlive.set(rec.tabId, alive)
      }
      if (!alive) {
        stale = true
      } else {
        const items = await chrome.downloads.search({ id: Number(key) })
        stale = items?.[0]?.state !== 'in_progress'
      }
    } catch {
      continue
    }
    // The change event may have answered and removed it while we looked
    if (stale && dlData[key] === rec) {
      delete dlData[key]
      changed = true
    }
  }
  if (changed) {
    await saveDLData()
  }
}

async function clearData() {
  await restoreDownloadData()
  for (const key of Object.keys(idList)) {
    const tabId = parseInt(key, 10)
    try {
      await chrome.tabs.get(tabId)
    } catch {
      // 用原字串 key 刪除，避免 '12:quick' 被當成 12 而誤刪主槽
      delete idList[key]
      delete batchNo[key]
    }
  }
  await setData({ batchNo, idList })
  await pruneDlData()
}

// MV3 service worker 的 setInterval 會在休眠時被清掉、不可靠；
// 改為每次 SW 啟動時做一次惰性清理（喚醒頻率足以涵蓋孤兒標籤頁）
void clearData().catch((e) => console.error('clear stale tabs failed', e))
