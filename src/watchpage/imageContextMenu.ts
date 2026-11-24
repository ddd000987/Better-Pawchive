/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Right-click menu for favorite images: download, move to a folder, open in
 * its own window, open the post, copy the image URL, remove. With several
 * images selected, the menu acts on all of them (the single-image actions
 * are left out). Only Pawchive images can be downloaded: Kemono has only
 * thumbnails left. */

import { lang } from '../Language'
import { openImageWindow } from '../preview/openImageWindow'
import { hasOriginalFiles } from '../preview/previewAssets'
import { replaceUnsafeStr } from '../Tools'
import { favImages } from '../watch/collectStore'
import type { FavImage } from '../watch/collectTypes'
import { sortedFolders } from '../watch/watchData'
import { fullImageUrl, postPageUrl, thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import { el, folderLabel } from './dom'
import { hideHoverPreview } from './hoverPreview'

export interface ImageMenuOptions {
  /** The images the menu acts on (one, or the whole selection) */
  images: FavImage[]
  at: { x: number; y: number }
  /** The tile's loaded thumbnail: its size shapes the image window */
  shown: HTMLImageElement | null
  notify: (message: string, isError?: boolean) => void
  /** Called after images were moved or removed (to clear the selection) */
  onChanged: () => void
}

/** File name for a download: the original name, else the stored file's */
export function downloadName(
  image: Pick<FavImage, 'fileName' | 'path'>
): string {
  const fromPath = image.path.split('/').pop() ?? ''
  const name = replaceUnsafeStr((image.fileName || fromPath).trim())
  return name || replaceUnsafeStr(fromPath) || 'image'
}

let closeCurrent: (() => void) | null = null

export function closeImageMenu(): void {
  closeCurrent?.()
}

async function downloadImages(
  images: FavImage[],
  notify: ImageMenuOptions['notify']
): Promise<void> {
  let failed = 0
  for (const image of images) {
    const host = watchStore.hostFor(image.site)
    try {
      await chrome.downloads.download({
        url: fullImageUrl(host, image.path),
        filename: downloadName(image),
        conflictAction: 'uniquify',
        saveAs: false,
      })
    } catch (err) {
      failed++
      console.error('[Better Pawchive] image download failed', err)
    }
  }
  if (failed > 0) {
    notify(lang.transl('_ctx_downloadFailed', String(failed)), true)
  } else {
    notify(lang.transl('_ctx_downloadStarted', String(images.length)))
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function openImageMenu(opts: ImageMenuOptions): void {
  closeImageMenu()
  hideHoverPreview()
  const { images, notify } = opts
  if (images.length === 0) return
  const single = images.length === 1 ? images[0] : null
  const prevFocus = document.activeElement as HTMLElement | null

  const menu = el('div', 'w-ctx-menu')
  menu.setAttribute('role', 'menu')

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    closeCurrent = null
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', onScroll, true)
    menu.remove()
    if (prevFocus && prevFocus.isConnected) prevFocus.focus()
  }
  closeCurrent = close

  const onDocDown = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node | null)) close()
  }
  // A long folder list scrolls inside the menu; only page scrolls close it
  const onScroll = (ev: Event): void => {
    if (!menu.contains(ev.target as Node | null)) close()
  }
  const items = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>('.w-ctx-item'))
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      close()
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const list = items()
      if (list.length === 0) return
      const i = list.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        ev.key === 'ArrowDown'
          ? (i + 1) % list.length
          : (i - 1 + list.length) % list.length
      list[next].focus()
    }
  }

  const addItem = (
    label: string,
    run: () => void | Promise<void>,
    danger = false
  ): void => {
    const btn = el(
      'button',
      danger ? 'w-ctx-item is-danger' : 'w-ctx-item',
      label
    )
    btn.type = 'button'
    btn.setAttribute('role', 'menuitem')
    btn.addEventListener('click', () => {
      close()
      void run()
    })
    menu.appendChild(btn)
  }
  const addSep = (): void => {
    menu.appendChild(el('div', 'w-ctx-sep'))
  }

  // Kemono images are left out of downloads (no original files there)
  const downloadable = images.filter((i) =>
    hasOriginalFiles(watchStore.hostFor(i.site))
  )

  const showMain = (): void => {
    menu.replaceChildren()
    const count = String(images.length)
    if (downloadable.length > 0) {
      addItem(
        single
          ? lang.transl('_ctx_download')
          : lang.transl('_ctx_downloadN', String(downloadable.length)),
        () => downloadImages(downloadable, notify)
      )
    }
    // Moving keeps the menu open: it turns into the folder list
    const moveBtn = el(
      'button',
      'w-ctx-item w-ctx-has-sub',
      single ? lang.transl('_ctx_moveTo') : lang.transl('_ctx_moveToN', count)
    )
    moveBtn.type = 'button'
    moveBtn.setAttribute('role', 'menuitem')
    moveBtn.setAttribute('aria-haspopup', 'menu')
    moveBtn.addEventListener('click', () => showFolders())
    menu.appendChild(moveBtn)

    if (single) {
      const host = watchStore.hostFor(single.site)
      const full = fullImageUrl(host, single.path)
      addItem(lang.transl('_ctx_openWindow'), () => {
        const shown = opts.shown
        const size =
          shown && shown.naturalWidth > 0
            ? { w: shown.naturalWidth, h: shown.naturalHeight }
            : null
        return openImageWindow(
          {
            src: full,
            placeholder: thumbUrl(host, single.path),
            title: single.postTitle || single.fileName || '',
          },
          size,
          false
        )
      })
      addSep()
      addItem(lang.transl('_fv_openPost'), () => {
        window.open(
          postPageUrl(host, single.service, single.creatorId, single.postId),
          '_blank',
          'noopener'
        )
      })
      addItem(lang.transl('_ctx_copyUrl'), async () => {
        const ok = await copyText(full)
        notify(lang.transl(ok ? '_ctx_copied' : '_ctx_copyFailed'), !ok)
      })
    }
    addSep()
    addItem(
      single ? lang.transl('_ctx_remove') : lang.transl('_ctx_removeN', count),
      async () => {
        const ok = window.confirm(
          single
            ? lang.transl('_fv_removeConfirm')
            : lang.transl('_ctx_removeManyConfirm', count)
        )
        if (!ok) return
        await favImages.remove(images.map((i) => i.key))
        opts.onChanged()
      },
      true
    )
  }

  const moveTo = async (folderId: string, label: string): Promise<void> => {
    try {
      await favImages.move(
        images.map((i) => i.key),
        folderId
      )
      notify(lang.transl('_ctx_moved', label))
      opts.onChanged()
    } catch (err) {
      notify(lang.transl('_ws_saveFailed', String(err)), true)
    }
  }

  const showFolders = (): void => {
    menu.replaceChildren()
    const back = el('button', 'w-ctx-item w-ctx-back', lang.transl('_ctx_back'))
    back.type = 'button'
    back.setAttribute('role', 'menuitem')
    back.addEventListener('click', () => {
      showMain()
      reposition()
      items()[0]?.focus()
    })
    menu.appendChild(back)
    addSep()
    // Mark the folder only when every image is already in it
    const current = images.every((i) => i.folderId === images[0].folderId)
      ? images[0].folderId
      : null
    for (const folder of sortedFolders(favImages.data)) {
      const label = folderLabel(folder)
      const isCurrent = folder.id === current
      addItem(`${isCurrent ? '✓ ' : ''}${label}`, () =>
        moveTo(folder.id, label)
      )
    }
    addSep()
    const slot = el('div', 'w-ctx-new')
    const newBtn = el('button', 'w-ctx-item', lang.transl('_w_newFolder'))
    newBtn.type = 'button'
    newBtn.setAttribute('role', 'menuitem')
    newBtn.addEventListener('click', () => {
      const input = el('input', 'w-input w-ctx-input')
      input.type = 'text'
      input.placeholder = lang.transl('_w_folderNamePlaceholder')
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return
        ev.preventDefault()
        const name = input.value.trim()
        if (!name) return
        close()
        void (async () => {
          try {
            const folder = await favImages.addFolder(name)
            await moveTo(folder.id, folder.name)
          } catch (err) {
            notify(lang.transl('_ws_saveFailed', String(err)), true)
          }
        })()
      })
      slot.replaceChildren(input)
      reposition()
      input.focus()
    })
    slot.appendChild(newBtn)
    menu.appendChild(slot)
    reposition()
    items()[1]?.focus()
  }

  const reposition = (): void => {
    const pad = 8
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    let left = opts.at.x
    let top = opts.at.y
    if (left + w > window.innerWidth - pad) left = Math.max(pad, left - w)
    if (top + h > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - pad - h)
    }
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`
  }

  showMain()
  document.body.appendChild(menu)
  reposition()
  items()[0]?.focus()

  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  window.addEventListener('scroll', onScroll, true)
}
