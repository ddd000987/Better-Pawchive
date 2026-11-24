/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Fixed bottom-left in-page notice shown when auto-scan discovers new posts. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { keepInBody } from '../PageRoots'
import type { ScanResult } from './scanner'
import { watchStore } from './watchStore'

const MAX_CREATOR_LINES = 3

class WatchNotice {
  private root: HTMLDivElement | null = null
  private lastResult: ScanResult | null = null

  constructor() {
    if (typeof document === 'undefined') return
    EVT.on(EVT.list.langChange, () => {
      if (this.root && !this.root.hidden && this.lastResult) {
        this.render(this.lastResult)
      }
    })
  }

  show(result: ScanResult): void {
    if (typeof document === 'undefined' || !document.body) return
    if (result.added.length === 0) return
    this.lastResult = result
    if (!this.root) {
      const el = document.createElement('div')
      el.id = 'pwpWatchNotice'
      el.setAttribute('role', 'status')
      el.setAttribute('aria-live', 'polite')
      keepInBody(el)
      document.body.appendChild(el)
      this.root = el
    }
    this.render(result)
    this.root.hidden = false
  }

  dismiss(): void {
    if (this.root) {
      this.root.hidden = true
    }
    this.lastResult = null
  }

  private render(result: ScanResult): void {
    if (!this.root) return
    this.root.lang = lang.htmlLang()
    this.root.replaceChildren()

    const header = document.createElement('div')
    header.className = 'pwpWN-head'

    const title = document.createElement('span')
    title.className = 'pwpWN-title'
    title.textContent = lang.transl('_wt_noticeTitle')

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'pwpWN-close'
    closeBtn.textContent = '×'
    closeBtn.title = lang.transl('_wt_noticeDismiss')
    closeBtn.setAttribute('aria-label', lang.transl('_wt_noticeDismiss'))
    closeBtn.addEventListener('click', () => this.dismiss())

    header.append(title, closeBtn)
    this.root.appendChild(header)

    const summary = document.createElement('div')
    summary.className = 'pwpWN-summary'
    summary.textContent = lang.transl(
      '_wt_noticeSummary',
      String(result.creatorsWithNew),
      String(result.added.length)
    )
    this.root.appendChild(summary)

    const counts = new Map<string, number>()
    for (const post of result.added) {
      counts.set(post.key, (counts.get(post.key) ?? 0) + 1)
    }

    const list = document.createElement('ul')
    list.className = 'pwpWN-list'
    let shown = 0
    for (const [key, count] of counts) {
      if (shown >= MAX_CREATOR_LINES) break
      const creator = watchStore.getCreator(key)
      const name = creator?.alias?.trim() || creator?.name || key
      const li = document.createElement('li')
      li.className = 'pwpWN-item'
      li.textContent = lang.transl('_wt_noticeLine', name, String(count))
      list.appendChild(li)
      shown++
    }
    if (shown > 0) {
      this.root.appendChild(list)
    }

    const actions = document.createElement('div')
    actions.className = 'pwpWN-actions'

    const viewBtn = document.createElement('button')
    viewBtn.type = 'button'
    viewBtn.className = 'pwpWN-view'
    viewBtn.textContent = lang.transl('_wt_noticeView')
    viewBtn.addEventListener('click', () => {
      void chrome.runtime
        .sendMessage({ msg: 'watch_open', hash: '#/feed' })
        .catch(() => {})
      this.dismiss()
    })

    actions.appendChild(viewBtn)
    this.root.appendChild(actions)
  }
}

export const watchNotice = new WatchNotice()
