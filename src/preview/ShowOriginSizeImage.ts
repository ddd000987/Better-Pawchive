/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/ShowOriginSizeImage.ts
 *               (xuejianxianzun)
 * changes: minimal viewer only — show full image + close.
 *          Entry: `callShowOriginSizeImage` with {imageUrl, placeholderUrl?}
 *          (PreviewWork V key sends image URLs, not work data). The
 *          placeholder (the image already shown in the hover preview) is
 *          displayed until the full image finishes loading. DELETED:
 *          right-click trigger, zoom, drag, cacheWorkData, D/C download keys.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'

/** 精簡原圖 viewer：顯示一張原圖，click/Esc/換頁關閉 */
class ShowOriginSizeImage {
  private wrap: HTMLDivElement | null = null

  constructor() {
    EVT.on(EVT.list.callShowOriginSizeImage, ((ev: Event) => {
      const { imageUrl, placeholderUrl } = (ev as CustomEvent).detail.data as {
        imageUrl?: string
        placeholderUrl?: string
      }
      if (imageUrl) this.show(imageUrl, placeholderUrl)
    }) as EventListener)
    EVT.on(EVT.list.pageSwitch, () => this.close())
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      // 輸入框內按 Esc 不關 viewer
      const t = ev.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      ) {
        return
      }
      this.close()
    })
  }

  private show(imageUrl: string, placeholderUrl?: string): void {
    this.close()
    const wrap = document.createElement('div')
    wrap.id = 'originSizeWrap'
    wrap.addEventListener('click', () => this.close())
    document.body.appendChild(wrap)
    markTransient(wrap)
    this.wrap = wrap

    const full = document.createElement('img')
    const usePlaceholder = !!placeholderUrl && placeholderUrl !== imageUrl
    if (!usePlaceholder) {
      full.src = imageUrl
      wrap.appendChild(full)
      return
    }
    // 原圖通常很大：先顯示浮層那張（已在快取），原圖載完再換上
    const placeholder = document.createElement('img')
    placeholder.src = placeholderUrl
    wrap.appendChild(placeholder)
    full.onload = () => {
      if (this.wrap !== wrap) return
      placeholder.replaceWith(full)
    }
    full.onerror = () => {
      if (this.wrap !== wrap) return
      toast.error(lang.transl('_imageLoadFailed'))
    }
    full.src = imageUrl
  }

  private close(): void {
    if (!this.wrap) return
    this.wrap.remove()
    this.wrap = null
  }
}

const showOriginSizeImage = new ShowOriginSizeImage()

export { showOriginSizeImage }
