/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader
 *          src/ts/buttonsOnThumb/ButtonsOnArtworkThumbOnPC.ts (mechanics,
 *          xuejianxianzun): hover show/hide with delay, doNotShowBtn
 *          click guard, pageSwitch/crawlStart hiding, scroll-compensated
 *          absolute positioning.
 *          PixStash src/content/thumbStashButton.ts (MIT, ddd000987): tap
 *          to favorite / unfavorite, press-hold or drag for the radial menu.
 * changes: one favorite button at the card's top-right corner (text glyph,
 *          no icon sprite); the radial menu also downloads the whole post
 *          (crawlIdList, or waitingIdList while busy, drained by
 *          DownloadControl); visibility gated by showDownloadBtnOnThumb.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { keepInBody } from '../PageRoots'
import { settings } from '../setting/Settings'
import { states } from '../store/States'
import { store } from '../store/Store'
import type { IDData } from '../store/StoreType'
import { toast } from '../Toast'
import { favPosts } from '../watch/collectStore'
import {
  folderDisplayName,
  makeFavPostTarget,
  removePostFromFav,
  savePostToFolder,
  type FavPostTarget,
} from '../watch/favPostActions'
import { openFolderMenu } from '../watch/folderMenu'
import { sortedFolders } from '../watch/watchData'
import { siteOfHost } from '../watch/watchKey'
import { UNSORTED_FOLDER_ID } from '../watch/watchTypes'
import { attachPressGesture } from './pressGesture'
import { hasOriginalFiles, parsePostKey } from './previewAssets'
import { HOLD_MS, type Point } from './radialGeometry'
import {
  isRadialMenuOpen,
  openRadialMenu,
  type RadialChoice,
  type RadialMenuController,
} from './radialMenu'
import { workThumbnail, WorkThumbnail } from './WorkThumbnail'

/** On the card while the button is shown over it (hides its saved star) */
const BTN_ON_CLASS = 'pwpFavBtnOn'

/** Favorite button on post cards (top-right on hover). Tap: favorite into
 * Unsorted, or unfavorite. Shift+tap: folder list. Hold or drag: radial
 * menu with folders, download and remove. */
class ThumbFavButton {
  private btn: HTMLButtonElement
  private currentPostKey = ''
  /** The card the button was last shown on */
  private card: HTMLAnchorElement | null = null

  private hideTimer = 0
  private delay = 100
  // 點擊後短暫不顯示：避免按鈕消失後滑鼠下方露出卡片，立刻又觸發顯示
  private noShow = false

  private menu: RadialMenuController | null = null
  private closeFolderMenuFn: (() => void) | null = null

  private readonly btnSize = 32

  constructor() {
    this.btn = document.createElement('button')
    this.btn.type = 'button'
    this.btn.id = 'pwpThumbFavBtn'
    this.btn.className = 'btnOnThumb'
    this.btn.setAttribute('aria-haspopup', 'menu')
    document.body.appendChild(this.btn)
    keepInBody(this.btn)
    this.updateButton()

    EVT.on(EVT.list.langChange, () => this.updateButton())
    favPosts.onChange(() => this.updateButton())
    void favPosts.ready().then(() => this.updateButton())

    workThumbnail.onEnter((el, postKey) => {
      if (this.isBusy()) return
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

    attachPressGesture(this.btn, {
      holdMs: () => HOLD_MS,
      onTap: ({ shiftKey }) => {
        if (shiftKey) this.openFolderList()
        else void this.toggle()
      },
      onOpen: (pt) => this.openMenu(pt),
      onMove: (pt) => this.menu?.move(pt),
      onRelease: (pt) => this.menu?.release(pt),
    })

    EVT.on(EVT.list.pageSwitch, () => {
      // 切頁後到按鈕隱藏前（鬼影期）點擊不可再操作舊頁的帖子
      this.currentPostKey = ''
      this.menu?.close()
      this.closeFolderMenu()
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

  /** A menu of this button is open: keep the button where it is */
  private isBusy(): boolean {
    return this.menu !== null || this.closeFolderMenuFn !== null
  }

  private target(): FavPostTarget | null {
    const site = siteOfHost(location.host)
    const parts = this.currentPostKey ? parsePostKey(this.currentPostKey) : null
    if (!site || !parts) return null
    try {
      return makeFavPostTarget(
        site,
        parts.service,
        parts.creatorId,
        parts.postId
      )
    } catch {
      return null
    }
  }

  private updateButton(): void {
    const target = this.target()
    const saved = target ? favPosts.get(target.key) : undefined
    this.btn.textContent = saved ? '★' : '☆'
    this.btn.classList.toggle('is-saved', Boolean(saved))
    const label = saved
      ? lang.transl(
          '_tf_saved',
          folderDisplayName(
            favPosts.data.folders.find((f) => f.id === saved.folderId)
          )
        )
      : lang.transl('_tf_save')
    this.btn.title = label
    this.btn.setAttribute('aria-label', label)
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
        if (this.isBusy()) return
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
    if (
      this.noShow ||
      !settings.get('showDownloadBtnOnThumb') ||
      !siteOfHost(location.host)
    ) {
      return
    }
    if (this.card !== card) this.releaseCard()
    this.card = card
    // The button takes over the card's saved star while it is shown
    card.classList.add(BTN_ON_CLASS)
    // Cards that lift on hover move after the first measure: follow them
    card.addEventListener('transitionend', this.place)
    window.clearTimeout(this.hideTimer)
    this.place()
    this.btn.style.display = 'flex'
    this.updateButton()
  }

  /** Pin the button to the card's top-right corner */
  private readonly place = (): void => {
    const card = this.card
    if (!card || !card.isConnected) return
    const rect = card.getBoundingClientRect()
    this.btn.style.left =
      window.scrollX + rect.left + rect.width - this.btnSize + 'px'
    this.btn.style.top = window.scrollY + rect.top + 'px'
  }

  private releaseCard(): void {
    this.card?.classList.remove(BTN_ON_CLASS)
    this.card?.removeEventListener('transitionend', this.place)
  }

  private hideBtn(): void {
    this.btn.style.display = 'none'
    this.releaseCard()
  }

  private hideDelay(): void {
    window.clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      if (this.isBusy()) return
      this.hideBtn()
    }, this.delay)
  }

  private hideNow(): void {
    this.noShow = true
    window.setTimeout(() => {
      this.noShow = false
    }, 100)
    window.clearTimeout(this.hideTimer)
    // A hidden button cannot keep focus: hand it back to the card
    if (document.activeElement === this.btn) this.card?.focus()
    this.hideBtn()
  }

  /** Tap: favorite into Unsorted, or unfavorite when already saved */
  private async toggle(): Promise<void> {
    const target = this.target()
    if (!target) return
    await favPosts.ready()
    if (favPosts.has(target.key)) {
      await removePostFromFav(target)
    } else {
      await savePostToFolder(
        target,
        UNSORTED_FOLDER_ID,
        lang.transl('_w_unsorted')
      )
    }
  }

  private openMenu(point: Point): void {
    const target = this.target()
    if (!target || isRadialMenuOpen()) return
    this.closeFolderMenu()
    const saved = favPosts.get(target.key)
    this.menu = openRadialMenu({
      center: point,
      folders: sortedFolders(favPosts.data).map((f) => ({
        id: f.id,
        name: folderDisplayName(f),
      })),
      savedFolderId: saved?.folderId ?? null,
      savedRating: saved?.rating ?? null,
      canDownload: hasOriginalFiles(),
      onChoose: (choice) => {
        void this.onChoose(target, choice)
      },
      onClose: () => {
        this.menu = null
        this.hideDelay()
      },
    })
  }

  private async onChoose(
    target: FavPostTarget,
    choice: RadialChoice
  ): Promise<void> {
    switch (choice.kind) {
      case 'folder':
        await savePostToFolder(
          target,
          choice.folderId,
          choice.label,
          choice.rating
        )
        return
      case 'newFolder': {
        let folderId: string
        try {
          folderId = (await favPosts.addFolder(choice.name)).id
        } catch (err) {
          toast.error(lang.transl('_ws_saveFailed', String(err)))
          return
        }
        const folder = favPosts.data.folders.find((f) => f.id === folderId)
        await savePostToFolder(target, folderId, folderDisplayName(folder))
        return
      }
      case 'download':
        this.download(target)
        return
      case 'more':
        this.openFolderList(target)
        return
      case 'remove':
        await removePostFromFav(target)
        return
    }
  }

  /** The folder list popover (the same one the post page button opens) */
  private openFolderList(target = this.target()): void {
    if (!target) return
    this.closeFolderMenu()
    window.clearTimeout(this.hideTimer)
    this.btn.style.display = 'flex'
    const saved = favPosts.get(target.key)
    this.btn.setAttribute('aria-expanded', 'true')
    this.closeFolderMenuFn = openFolderMenu({
      anchor: this.btn,
      folders: sortedFolders(favPosts.data),
      currentFolderId: saved?.folderId ?? null,
      unsortedLabel: lang.transl('_w_unsorted'),
      removeLabel: lang.transl('_fs_removeFav'),
      onPick: (folderId, label) => savePostToFolder(target, folderId, label),
      onCreateFolder: async (name) => (await favPosts.addFolder(name)).id,
      onRemove: saved ? () => removePostFromFav(target) : undefined,
      extraItems: [
        {
          label: lang.transl('_fs_openFavPosts'),
          onClick: () => {
            void chrome.runtime.sendMessage({
              msg: 'watch_open',
              hash: '#/posts',
            })
          },
        },
      ],
      onError: (err) => {
        toast.error(lang.transl('_ws_saveFailed', String(err)))
      },
      onClose: () => {
        this.closeFolderMenuFn = null
        this.hideDelay()
      },
    })
  }

  private closeFolderMenu(): void {
    this.closeFolderMenuFn?.()
    this.closeFolderMenuFn = null
  }

  private download(target: FavPostTarget): void {
    this.hideNow()
    const postKey = `${target.service}/${target.creatorId}/${target.postId}`
    const idData: IDData = { id: postKey, type: 'post' }
    if (states.busy || states.hasDownloadTask) {
      store.waitingIdList.push(idData)
      toast.show(lang.transl('_queuedN', '1'))
    } else {
      EVT.fire('crawlIdList', [idData])
    }
  }
}

const thumbFavButton = new ThumbFavButton()

export { thumbFavButton }
