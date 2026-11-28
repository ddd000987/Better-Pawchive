/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Per-image favorite button overlaid on post page thumbnails. Tap: favorite
 * into Unsorted, or unfavorite. Shift+tap: folder list. Hold or drag: the
 * radial menu (folders, more, remove; no download for a single image). */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import { detectPage } from '../kemono/pages'
import { attachPressGesture } from '../preview/pressGesture'
import { HOLD_MS, type Point } from '../preview/radialGeometry'
import {
  isRadialMenuOpen,
  openRadialMenu,
  type RadialChoice,
  type RadialMenuController,
} from '../preview/radialMenu'
import { favImages } from './collectStore'
import {
  removeImageFromFav,
  saveImageToFolder,
  type FavImageTarget,
} from './favImageActions'
import { folderDisplayName } from './favPostActions'
import { openFolderMenu } from './folderMenu'
import { extractFileNameFromUrl, type PostTarget } from './postMeta'
import { sortedFolders } from './watchData'
import { makeFavImageKey, parseImagePathFromUrl, siteOfHost } from './watchKey'
import { UNSORTED_FOLDER_ID } from './watchTypes'

interface BoundFigure {
  btn: HTMLButtonElement
  target: FavImageTarget
  detach: () => void
}

class ImageFavOverlay {
  private gen = 0
  private current: PostTarget | null = null
  private entries = new Map<HTMLElement, BoundFigure>()
  private busyKeys = new Set<string>()
  private observer: MutationObserver | null = null
  private observedRoot: Node | null = null
  private scanFrame = 0
  private menu: RadialMenuController | null = null
  private closeFolderMenuFn: (() => void) | null = null

  constructor() {
    if (typeof document === 'undefined') return
    EVT.on(EVT.list.pageSwitch, () => this.onPage())
    EVT.on(EVT.list.langChange, () => this.updateAllButtons())
    favImages.onChange(() => this.updateAllButtons())
    this.onPage()
  }

  private onPage(): void {
    const gen = ++this.gen
    this.cleanup()
    this.current = null

    const page = detectPage()
    const site = siteOfHost(location.host)
    if (page.kind !== 'post' || !site) return

    const target: PostTarget = {
      site,
      service: page.service,
      creatorId: page.creatorId,
      postId: page.postId,
    }
    this.current = target
    void favImages.ready().then(() => {
      if (gen === this.gen) this.updateAllButtons()
    })
    this.scan(target)
    this.startObserver(gen, target)
  }

  private startObserver(gen: number, target: PostTarget): void {
    const root =
      document.querySelector('.post__body') ||
      document.querySelector('.post__files') ||
      document.documentElement
    this.observedRoot = root

    const observer = new MutationObserver(() => {
      if (gen !== this.gen) {
        observer.disconnect()
        return
      }
      // Once .post__body appears on an SPA transition, narrow observation to it
      if (this.observedRoot === document.documentElement) {
        const postBody = document.querySelector('.post__body')
        if (postBody) {
          observer.disconnect()
          this.observedRoot = postBody
          observer.observe(postBody, { childList: true, subtree: true })
        }
      }
      this.scheduleScan(gen, target)
    })
    this.observer = observer
    observer.observe(root, { childList: true, subtree: true })
  }

  private scheduleScan(gen: number, target: PostTarget): void {
    if (this.scanFrame) return
    this.scanFrame = window.requestAnimationFrame(() => {
      this.scanFrame = 0
      if (gen !== this.gen) return
      this.scan(target)
    })
  }

  private scan(target: PostTarget): void {
    for (const [figure, entry] of this.entries) {
      if (!figure.isConnected) {
        entry.detach()
        entry.btn.remove()
        this.entries.delete(figure)
      }
    }

    const figures = document.querySelectorAll<HTMLElement>(
      '.post__thumbnail figure'
    )
    for (const figure of figures) {
      if (this.entries.has(figure)) continue

      const anchor = figure.querySelector<HTMLAnchorElement>('a.fileThumb')
      const img = figure.querySelector<HTMLImageElement>('img')
      const imgSrc = img?.getAttribute('src') || img?.src || ''
      const anchorHref = anchor?.getAttribute('href') || anchor?.href || ''
      const path =
        parseImagePathFromUrl(imgSrc) ?? parseImagePathFromUrl(anchorHref)
      if (!path) continue

      const key = makeFavImageKey(target.site, path)
      const fileName = extractFileNameFromUrl(anchorHref)

      // Remove any stale overlay button left behind on the same figure
      for (const stale of figure.querySelectorAll('.pwpImgFavBtn')) {
        stale.remove()
      }

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pwpImgFavBtn'
      markTransient(btn)

      const imageTarget: FavImageTarget = { ...target, key, path, fileName }
      const detach = attachPressGesture(btn, {
        holdMs: () => HOLD_MS,
        onTap: ({ shiftKey }) => {
          if (shiftKey) this.openFolderList(entry)
          else void this.toggleImage(entry)
        },
        onOpen: (pt) => this.openMenu(entry, pt),
        onMove: (pt) => this.menu?.move(pt),
        onRelease: (pt) => this.menu?.release(pt),
      })
      const entry: BoundFigure = { btn, target: imageTarget, detach }

      figure.classList.add('pwpImgFavHost')
      figure.appendChild(btn)
      this.entries.set(figure, entry)
      this.updateButton(entry)
    }
  }

  private updateButton(entry: BoundFigure): void {
    const saved = favImages.has(entry.target.key)
    entry.btn.textContent = saved ? '★' : '☆'
    entry.btn.classList.toggle('is-saved', saved)
    entry.btn.setAttribute('aria-pressed', String(saved))
    const label = lang.transl(saved ? '_fs_unfavImageAria' : '_fs_favImageAria')
    entry.btn.setAttribute('aria-label', label)
    entry.btn.title = label
  }

  private updateAllButtons(): void {
    for (const entry of this.entries.values()) {
      this.updateButton(entry)
    }
  }

  /** Tap: favorite into Unsorted, or unfavorite when already saved */
  private async toggleImage(entry: BoundFigure): Promise<void> {
    const { key } = entry.target
    if (this.busyKeys.has(key)) return
    this.busyKeys.add(key)
    try {
      await favImages.ready()
      if (favImages.has(key)) {
        await removeImageFromFav(entry.target)
      } else {
        await saveImageToFolder(
          entry.target,
          UNSORTED_FOLDER_ID,
          lang.transl('_w_unsorted')
        )
      }
    } finally {
      this.busyKeys.delete(key)
    }
  }

  private openMenu(entry: BoundFigure, point: Point): void {
    if (isRadialMenuOpen()) return
    this.closeFolderMenu()
    const saved = favImages.get(entry.target.key)
    entry.btn.classList.add('is-open')
    this.menu = openRadialMenu({
      center: point,
      folders: sortedFolders(favImages.data).map((f) => ({
        id: f.id,
        name: folderDisplayName(f),
      })),
      savedFolderId: saved?.folderId ?? null,
      savedRating: saved?.rating ?? null,
      canDownload: false,
      unsavedCaption: lang.transl('_fs_favImage'),
      onChoose: (choice) => {
        void this.onChoose(entry, choice)
      },
      onClose: () => {
        this.menu = null
        entry.btn.classList.remove('is-open')
      },
    })
  }

  private async onChoose(
    entry: BoundFigure,
    choice: RadialChoice
  ): Promise<void> {
    switch (choice.kind) {
      case 'folder':
        await saveImageToFolder(
          entry.target,
          choice.folderId,
          choice.label,
          choice.rating
        )
        return
      case 'newFolder': {
        let folderId: string
        try {
          folderId = (await favImages.addFolder(choice.name)).id
        } catch (err) {
          toast.error(lang.transl('_ws_saveFailed', String(err)))
          return
        }
        const folder = favImages.data.folders.find((f) => f.id === folderId)
        await saveImageToFolder(
          entry.target,
          folderId,
          folderDisplayName(folder)
        )
        return
      }
      case 'more':
        this.openFolderList(entry)
        return
      case 'remove':
        await removeImageFromFav(entry.target)
        return
      case 'download':
        // Disabled in this menu
        return
    }
  }

  /** The folder list popover (as on the post page favorite button) */
  private openFolderList(entry: BoundFigure): void {
    this.closeFolderMenu()
    const { target, btn } = entry
    const saved = favImages.get(target.key)
    btn.classList.add('is-open')
    btn.setAttribute('aria-expanded', 'true')
    this.closeFolderMenuFn = openFolderMenu({
      anchor: btn,
      folders: sortedFolders(favImages.data),
      currentFolderId: saved?.folderId ?? null,
      unsortedLabel: lang.transl('_w_unsorted'),
      removeLabel: lang.transl('_fs_unfavImageAria'),
      onPick: (folderId, label) => saveImageToFolder(target, folderId, label),
      onCreateFolder: async (name) => (await favImages.addFolder(name)).id,
      onRemove: saved ? () => removeImageFromFav(target) : undefined,
      onError: (err) => {
        toast.error(lang.transl('_ws_saveFailed', String(err)))
      },
      onClose: () => {
        this.closeFolderMenuFn = null
        btn.classList.remove('is-open')
        btn.removeAttribute('aria-expanded')
      },
    })
  }

  private closeFolderMenu(): void {
    this.closeFolderMenuFn?.()
    this.closeFolderMenuFn = null
  }

  private cleanup(): void {
    this.observer?.disconnect()
    this.observer = null
    this.observedRoot = null
    if (this.scanFrame) {
      window.cancelAnimationFrame(this.scanFrame)
      this.scanFrame = 0
    }
    this.menu?.close()
    this.closeFolderMenu()
    for (const [figure, entry] of this.entries) {
      entry.detach()
      entry.btn.remove()
      figure.classList.remove('pwpImgFavHost')
    }
    this.entries.clear()
    this.busyKeys.clear()
  }
}

export const imageFavOverlay = new ImageFavOverlay()
