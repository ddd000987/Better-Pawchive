/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader
 *          src/ts/buttonsOnThumb/ButtonsOnArtworkThumbOnPC.ts (mechanics,
 *          xuejianxianzun): hover show/hide with delay, doNotShowBtn
 *          click guard, pageSwitch/crawlStart hiding, scroll-compensated
 *          absolute positioning.
 * changes: single download button only (no zoom/copy);
 *          no icon sprite (text glyph); position top-right of card;
 *          click → crawlIdList (busy → waitingIdList, drained by
 *          DownloadControl); visibility gated by showDownloadBtnOnThumb.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { settings } from '../setting/Settings'
import { states } from '../store/States'
import { store } from '../store/Store'
import type { IDData } from '../store/StoreType'
import { toast } from '../Toast'
import { hasOriginalFiles } from './previewAssets'
import { workThumbnail, WorkThumbnail } from './WorkThumbnail'
import { keepInBody } from '../PageRoots'

/** 帖子縮圖上的下載按鈕（hover 卡片時在右上角顯示，點擊下載整帖） */
class ThumbDownloadButton {
  private btn: HTMLButtonElement
  private currentPostKey = ''
  /** The card the button was last shown on */
  private card: HTMLAnchorElement | null = null

  private hideTimer = 0
  private delay = 100
  // 點擊後短暫不顯示：避免按鈕消失後滑鼠下方露出卡片，立刻又觸發顯示
  private noShow = false

  private readonly btnSize = 32

  constructor() {
    this.btn = document.createElement('button')
    this.btn.id = 'pwpThumbDownloadBtn'
    this.btn.className = 'btnOnThumb'
    this.btn.textContent = '⬇'
    this.btn.dataset.xztitle = '_downloadPost'
    this.btn.title = lang.transl('_downloadPost')
    // The glyph alone says nothing to a screen reader
    this.btn.setAttribute('aria-label', lang.transl('_downloadPost'))
    EVT.on(EVT.list.langChange, () => {
      this.btn.setAttribute('aria-label', lang.transl('_downloadPost'))
    })
    lang.register(this.btn)
    document.body.appendChild(this.btn)
    keepInBody(this.btn)

    workThumbnail.onEnter((el, postKey) => {
      this.currentPostKey = postKey
      this.show(el)
    })
    workThumbnail.onLeave(() => {
      this.hideDelay()
    })
    // The cursor on the button is still on its card (see findCardUnderCursor)
    workThumbnail.registerOverlay(this.btn, () => this.cardUnderButton())
    this.bindKeyboard()

    this.btn.addEventListener('mouseenter', () => {
      window.clearTimeout(this.hideTimer)
    })
    this.btn.addEventListener('mouseleave', () => {
      this.hideDelay()
    })
    this.btn.addEventListener('click', () => {
      this.download()
    })

    EVT.on(EVT.list.pageSwitch, () => {
      // 切頁後到按鈕隱藏前（鬼影期）點擊不可再下載舊頁的帖子
      this.currentPostKey = ''
      this.hideDelay()
    })
    EVT.on(EVT.list.crawlStart, () => {
      this.hideDelay()
    })
  }

  /** The card the visible button belongs to (null while it is hidden) */
  public cardUnderButton(): HTMLAnchorElement | null {
    const card = this.card
    if (!card || !card.isConnected || this.btn.style.display === 'none') {
      return null
    }
    return card
  }

  /** Keyboard access: the button sits at the end of <body>, outside the tab
   * order of the cards, so show it when its card gets focus and let Tab step
   * from the card to the button and on to whatever follows the card. */
  private bindKeyboard(): void {
    document.addEventListener(
      'focusin',
      (ev) => {
        const t = ev.target
        if (t === this.btn) {
          window.clearTimeout(this.hideTimer)
          return
        }
        if (!(t instanceof HTMLAnchorElement) || t.dataset.pwp !== '1') return
        const key = WorkThumbnail.parsePostKey(t.href)
        if (!key) return
        this.currentPostKey = key
        this.show(t)
      },
      true
    )
    document.addEventListener(
      'focusout',
      (ev) => {
        const to = ev.relatedTarget
        if (to === this.btn || to === this.card) return
        if (ev.target === this.btn || ev.target === this.card) this.hideDelay()
      },
      true
    )
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== 'Tab' || ev.ctrlKey || ev.altKey || ev.metaKey) return
        const card = this.cardUnderButton()
        if (!card) return
        if (ev.target === card && !ev.shiftKey) {
          ev.preventDefault()
          this.btn.focus()
        } else if (ev.target === this.btn) {
          // Back to the card; a forward Tab then continues after the card
          if (ev.shiftKey) ev.preventDefault()
          card.focus()
        }
      },
      true
    )
  }

  private show(card: HTMLAnchorElement): void {
    // No downloads on Kemono (its original files are gone)
    if (
      this.noShow ||
      !settings.get('showDownloadBtnOnThumb') ||
      !hasOriginalFiles()
    ) {
      return
    }
    this.card = card
    window.clearTimeout(this.hideTimer)
    const rect = card.getBoundingClientRect()
    this.btn.style.left =
      window.scrollX + rect.left + rect.width - this.btnSize + 'px'
    this.btn.style.top = window.scrollY + rect.top + 'px'
    this.btn.style.display = 'flex'
  }

  private hideDelay(): void {
    window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      this.btn.style.display = 'none'
    }, this.delay)
  }

  private hideNow(): void {
    this.noShow = true
    window.setTimeout(() => {
      this.noShow = false
    }, 100)
    window.clearTimeout(this.hideTimer)
    this.btn.style.display = 'none'
  }

  private download(): void {
    const card = this.card
    const hadFocus = document.activeElement === this.btn
    this.hideNow()
    // A hidden button cannot keep focus: hand it back to the card
    if (hadFocus) card?.focus()
    if (!this.currentPostKey) {
      return
    }
    const idData: IDData = { id: this.currentPostKey, type: 'post' }
    if (states.busy || states.hasDownloadTask) {
      store.waitingIdList.push(idData)
      toast.show(lang.transl('_queuedN', '1'))
    } else {
      EVT.fire('crawlIdList', [idData])
    }
  }
}

const thumbDownloadButton = new ThumbDownloadButton()

export { thumbDownloadButton }
