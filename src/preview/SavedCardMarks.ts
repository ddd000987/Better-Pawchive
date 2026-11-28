/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* A gold star that stays on the corner of every favorited post card, where
 * the hover favorite button appears. Cards are re-checked when favorites
 * change, the page switches or the site renders more cards. */

import { EVT } from '../EVT'
import { settings } from '../setting/Settings'
import { favPosts } from '../watch/collectStore'
import { makeFavPostKey, siteOfHost } from '../watch/watchKey'
import { parsePostKey } from './previewAssets'
import { WorkThumbnail } from './WorkThumbnail'

const MARK_CLASS = 'pwpFavSavedCard'

class SavedCardMarks {
  private frame = 0

  constructor() {
    if (typeof document === 'undefined') return
    favPosts.onChange(() => this.schedule())
    void favPosts.ready().then(() => this.schedule())
    EVT.on(EVT.list.pageSwitch, () => this.schedule())
    EVT.on(EVT.list.settingChange, (ev: CustomEventInit) => {
      if (ev.detail?.data?.key === 'showDownloadBtnOnThumb') this.schedule()
    })
    new MutationObserver(() => this.schedule()).observe(
      document.documentElement,
      { childList: true, subtree: true }
    )
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }

  /** Post card (not a text link): it shows a cover or is a site post card */
  private isCard(a: HTMLAnchorElement): boolean {
    return !!a.closest('.post-card') || !!a.querySelector('img')
  }

  private update(): void {
    const site = siteOfHost(location.host)
    const on = !!site && settings.get('showDownloadBtnOnThumb')
    for (const a of document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/post/"]'
    )) {
      let saved = false
      if (site && on && this.isCard(a)) {
        const postKey = WorkThumbnail.parsePostKey(a.href)
        const parts = postKey ? parsePostKey(postKey) : null
        if (parts) {
          try {
            saved = favPosts.has(
              makeFavPostKey(site, parts.service, parts.creatorId, parts.postId)
            )
          } catch {
            saved = false
          }
        }
      }
      // Only touch the class when it changes: no mutation loop
      if (a.classList.contains(MARK_CLASS) !== saved) {
        a.classList.toggle(MARK_CLASS, saved)
      }
    }
  }
}

export const savedCardMarks = new SavedCardMarks()
