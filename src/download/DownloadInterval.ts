/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/download/DownloadInterval.ts
 *          (xuejianxianzun)
 * changes: dropped lang/log dependency (console + toast instead);
 *          rememberTheLastSaveLocation / mobile branches removed (always
 *          downloads API). Interval keys are Pawchive downloadInterval.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { log } from '../Log'
import { settings } from '../setting/Settings'

class DownloadInterval {
  constructor() {
    this.bindEvents()
  }

  /**允許開始下載的時間戳 */
  // 不管設置裡的值是多少，初始值都是 0，即允許第一次下載立即開始
  private allowDownloadTime = 0

  private bindEvents() {
    EVT.on(EVT.list.settingChange, (ev: CustomEventInit) => {
      const data = ev.detail.data as { key: string; value: unknown }
      if (data.key === 'downloadInterval') {
        if (data.value === 0) {
          this.reset()
        }
      }
    })

    const resetEvents = [
      EVT.list.crawlComplete,
      EVT.list.downloadStart,
      EVT.list.downloadPause,
      EVT.list.downloadStop,
      EVT.list.downloadComplete,
    ]
    resetEvents.forEach((evt) => {
      EVT.on(evt, () => {
        this.reset()
      })
    })

    EVT.on(EVT.list.downloadStart, () => {
      // 在開始下載時，如果應用了間隔時間，則顯示一條日誌提醒
      if (settings.get('downloadInterval') > 0) {
        log.warning(
          lang.transl('_intervalOn', String(settings.get('downloadInterval')))
        )
      }
    })
  }

  private reset() {
    this.allowDownloadTime = 0
    // Waiters computed their sleep from the old time (or from a cancel state
    // that just changed): let them re-check now
    this.wakeAll()
  }

  private addTime() {
    this.allowDownloadTime =
      Date.now() + settings.get('downloadInterval') * 1000
  }

  /** 檢查是否不符合啟用“添加下載間隔”的條件。true 表示不啟用 */
  public checkDisable() {
    return settings.get('downloadInterval') === 0
  }

  /** Waiters currently sleeping; each one wakes itself up and re-checks */
  private sleepers = new Set<() => void>()

  /** Wake every sleeping waiter so it re-checks cancel / the interval */
  private wakeAll() {
    for (const wake of [...this.sleepers]) {
      wake()
    }
  }

  /**
   * Sleep for `ms` in one timer (no polling, so a throttled background tab
   * does not stretch the wait), or until wakeAll() is called.
   */
  private sleepOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        window.clearTimeout(timer)
        this.sleepers.delete(wake)
        resolve()
      }
      const timer = window.setTimeout(wake, ms)
      this.sleepers.add(wake)
    })
  }

  /** 等待到下一個允許下載的時間。cancelled 回傳 true 時立刻結束並回傳 false */
  public async wait(cancelled: () => boolean = () => false) {
    while (true) {
      if (cancelled()) {
        return false
      }

      if (this.checkDisable()) {
        return true
      }

      // 可以立即開始下載
      const remaining = this.allowDownloadTime - Date.now()
      if (remaining <= 0) {
        this.addTime()
        return true
      }

      // Sleep exactly until the slot opens; a pause/stop/new batch wakes the
      // waiter early so it can notice the cancel without waiting it out
      await this.sleepOrWake(remaining)
    }
  }
}

const downloadInterval = new DownloadInterval()
export { downloadInterval }
