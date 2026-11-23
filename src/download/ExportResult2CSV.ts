/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/download/ExportResult2CSV.ts
 *          concept (xuejianxianzun)
 * changes: columns rewritten for Kemono resultMeta; downloaded via
 *          anchor (no background round-trip needed for a local blob).
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { log } from '../Log'
import { store } from '../store/Store'
import { downloadStates } from './DownloadStates'

function csvCell(value: string | number | boolean): string {
  let s = String(value)
  // A spreadsheet runs a text cell that starts like a formula; a leading
  // apostrophe makes it plain text
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

class ExportResult2CSV {
  constructor() {
    EVT.on(EVT.list.exportCSV, () => {
      this.export()
    })
  }

  private export() {
    if (store.resultMeta.length === 0) {
      log.warning(lang.transl('_noExportResults'))
      return
    }
    const header = [
      'service',
      'creator',
      'creatorId',
      'postId',
      'title',
      'published',
      'fileCount',
      'pending',
      'postKey',
      // 該帖附件的下載狀態（done/partial/pending），供對帳用；
      // 被過濾掉的帖從不入庫，不會出現在此表
      'status',
    ]
    const lines = [header.join(',')]
    const statuses = this.postStatuses()
    for (const r of store.resultMeta) {
      lines.push(
        [
          csvCell(r.service),
          csvCell(r.creator),
          csvCell(r.creatorId),
          csvCell(r.postId),
          csvCell(r.title),
          csvCell(r.published),
          csvCell(r.fileCount),
          csvCell(r.pending),
          csvCell(r.postKey),
          csvCell(statuses.get(r.postKey) ?? 'pending'),
        ].join(',')
      )
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pawchive-result-${Date.now()}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
    log.success(
      lang.transl('_exportedResults', String(store.resultMeta.length))
    )
  }

  /**
   * 每帖的下載狀態：附件全完成 done、部分完成 partial、否則 pending。
   * One pass over the results; a post without results is not in the map.
   */
  private postStatuses(): Map<string, string> {
    const counts = new Map<string, { total: number; done: number }>()
    for (let i = 0; i < store.result.length; i++) {
      const key = store.result[i].postKey
      let c = counts.get(key)
      if (!c) {
        c = { total: 0, done: 0 }
        counts.set(key, c)
      }
      c.total++
      if (downloadStates.states[i] === 1) {
        c.done++
      }
    }
    const statuses = new Map<string, string>()
    for (const [key, { total, done }] of counts) {
      statuses.set(
        key,
        done === 0 ? 'pending' : done === total ? 'done' : 'partial'
      )
    }
    return statuses
  }
}

new ExportResult2CSV()

export { csvCell }
