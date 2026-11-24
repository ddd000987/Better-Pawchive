/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Per-image favorite toggle button overlaid on post page thumbnails. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import { detectPage } from '../kemono/pages'
import { favImages } from './collectStore'
import {
  extractFileNameFromUrl,
  resolvePostMeta,
  type PostTarget,
} from './postMeta'
import { makeFavImageKey, parseImagePathFromUrl, siteOfHost } from './watchKey'

interface BoundFigure {
  btn: HTMLButtonElement
  key: string
  path: string
  fileName?: string
}

class ImageFavOverlay {
  private gen = 0
  private current: PostTarget | null = null
  private entries = new Map<HTMLElement, BoundFigure>()
  private busyKeys = new Set<string>()
  private observer: MutationObserver | null = null
  private observedRoot: Node | null = null
  private scanFrame = 0

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

      const entry: BoundFigure = { btn, key, path, fileName }
      btn.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        void this.toggleImage(target, entry)
      })

      figure.classList.add('pwpImgFavHost')
      figure.appendChild(btn)
      this.entries.set(figure, entry)
      this.updateButton(entry)
    }
  }

  private updateButton(entry: BoundFigure): void {
    const saved = favImages.has(entry.key)
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

  private async toggleImage(
    target: PostTarget,
    entry: BoundFigure
  ): Promise<void> {
    if (this.busyKeys.has(entry.key)) return
    this.busyKeys.add(entry.key)
    try {
      await favImages.ready()
      if (favImages.has(entry.key)) {
        await favImages.remove([entry.key])
        toast.success(lang.transl('_fs_removed'))
      } else {
        const meta = await resolvePostMeta(target)
        await favImages.add({
          key: entry.key,
          site: target.site,
          path: entry.path,
          fileName: entry.fileName,
          service: target.service,
          creatorId: target.creatorId,
          postId: target.postId,
          postTitle: meta.title || undefined,
          creatorName: meta.creatorName || undefined,
        })
        toast.success(lang.transl('_fs_imageSaved'))
      }
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    } finally {
      this.busyKeys.delete(entry.key)
    }
  }

  private cleanup(): void {
    this.observer?.disconnect()
    this.observer = null
    this.observedRoot = null
    if (this.scanFrame) {
      window.cancelAnimationFrame(this.scanFrame)
      this.scanFrame = 0
    }
    for (const [figure, entry] of this.entries) {
      entry.btn.remove()
      figure.classList.remove('pwpImgFavHost')
    }
    this.entries.clear()
    this.busyKeys.clear()
  }
}

export const imageFavOverlay = new ImageFavOverlay()
