/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader ShowBorderOnDownloadedWorks concept
 *          (xuejianxianzun)
 * changes: Kemono cards carry data-postkey (see WorkThumbnail); a post
 *          counts as downloaded only when ALL its result files are
 *          recorded (sibling count from store, no guessing). Re-scans on
 *          crawl/download completion, after each saved file and (delayed)
 *          SPA page switches; scans are debounced and never overlap.
 */

import { EVT } from '../EVT'
import { downloadRecord } from './DownloadRecord'
import { store } from '../store/Store'

const DONE_CLASS = 'pwp-downloaded'
/** Quiet time after the last trigger before a scan runs */
const SCAN_DEBOUNCE_MS = 1000
/** Longest a scan waits while triggers keep arriving (files finishing in a
 * steady stream would otherwise push it back until the batch ends) */
const SCAN_MAX_WAIT_MS = 5000

class ShowBorderOnDownloadedWorks {
  constructor() {
    this.bindEvents()
  }

  private timer = 0
  /** When the oldest unserved trigger must be served at the latest (0 = none) */
  private deadline = 0
  private scanning = false
  /** A trigger arrived during a scan: scan once more afterwards */
  private again = false

  private bindEvents() {
    for (const ev of [
      EVT.list.crawlComplete,
      EVT.list.downloadComplete,
      EVT.list.downloadSuccess,
      // SPA 切換後卡片晚渲染，延遲掃描
      EVT.list.pageSwitch,
    ]) {
      EVT.on(ev, () => {
        this.schedule()
      })
    }
  }

  /** Trailing debounce with a maximum wait */
  private schedule(): void {
    if (this.scanning) {
      this.again = true
      return
    }
    const now = Date.now()
    if (this.deadline === 0) {
      this.deadline = now + SCAN_MAX_WAIT_MS
    }
    const delay = Math.max(0, Math.min(SCAN_DEBOUNCE_MS, this.deadline - now))
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.run(), delay)
  }

  /** Runs one scan at a time; triggers during a scan queue one more */
  private async run(): Promise<void> {
    this.deadline = 0
    this.scanning = true
    try {
      await this.scan()
    } catch (e) {
      console.error('[PawchivePro] mark downloaded posts failed', e)
    } finally {
      this.scanning = false
      if (this.again) {
        this.again = false
        this.schedule()
      }
    }
  }

  private async scan(): Promise<void> {
    const cards =
      document.querySelectorAll<HTMLAnchorElement>('a[data-postkey]')
    if (cards.length === 0) {
      return
    }
    const byKey = new Map<string, HTMLAnchorElement[]>()
    for (const card of cards) {
      const key = card.dataset.postkey
      if (!key) {
        continue
      }
      const list = byKey.get(key)
      if (list) {
        list.push(card)
      } else {
        byKey.set(key, [card])
      }
    }
    if (byKey.size === 0) {
      return
    }

    // File count and publish date per post, from one pass over the results.
    // A post counts as done when all its result files are recorded.
    const posts = new Map<string, { count: number; published: string }>()
    for (const r of store.result) {
      if (!byKey.has(r.postKey)) {
        continue
      }
      const post = posts.get(r.postKey)
      if (post) {
        post.count++
      } else {
        posts.set(r.postKey, { count: 1, published: r.published })
      }
    }

    for (const [key, post] of posts) {
      if (await downloadRecord.hasPost(key, post.published, post.count)) {
        for (const card of byKey.get(key) ?? []) {
          card.classList.add(DONE_CLASS)
        }
      }
    }
  }
}

new ShowBorderOnDownloadedWorks()
