/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Full-image lightbox for favorite images with keyboard navigation, focus trap, and side editor panel. */

import { lang } from '../Language'
import { hasOriginalFiles } from '../preview/previewAssets'
import { favImages } from '../watch/collectStore'
import type { FavImage } from '../watch/collectTypes'
import {
  creatorPageUrl,
  fullImageUrl,
  postPageUrl,
  thumbUrl,
} from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import { el, siteLabel } from './dom'
import { createFavEditor, trapFocus, type FavEditorHandle } from './favEditor'

export interface LightboxHandle {
  sync: (nextItems: FavImage[]) => void
  destroy: () => void
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], .w-star-input'
    ) !== null
  )
}

export function openFavImageLightbox(
  initialItems: FavImage[],
  initialKey: string,
  onClose: () => void
): LightboxHandle | null {
  let items = [...initialItems]
  let currentIndex = items.findIndex((i) => i.key === initialKey)
  if (currentIndex === -1) return null

  const prevFocus = document.activeElement as HTMLElement | null
  let closed = false
  let loadToken = 0
  let editor: FavEditorHandle | null = null

  const backdrop = el('div', 'w-fv-lb-backdrop')
  const shell = el('div', 'w-fv-lb-shell')
  shell.setAttribute('role', 'dialog')
  shell.setAttribute('aria-modal', 'true')
  shell.setAttribute('aria-label', lang.transl('_fv_lightboxLabel'))

  // Left/top media stage
  const stage = el('div', 'w-fv-lb-stage')

  const topBar = el('div', 'w-fv-lb-topbar')
  const counterEl = el('span', 'w-fv-lb-counter')
  const closeBtn = el('button', 'w-fv-lb-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', lang.transl('_fv_close'))
  closeBtn.title = lang.transl('_fv_close')
  topBar.appendChild(counterEl)
  topBar.appendChild(closeBtn)
  stage.appendChild(topBar)

  const prevBtn = el('button', 'w-fv-lb-nav w-fv-lb-prev', '‹')
  prevBtn.type = 'button'
  prevBtn.setAttribute('aria-label', lang.transl('_fv_prevImage'))
  prevBtn.title = lang.transl('_fv_prevImage')

  const nextBtn = el('button', 'w-fv-lb-nav w-fv-lb-next', '›')
  nextBtn.type = 'button'
  nextBtn.setAttribute('aria-label', lang.transl('_fv_nextImage'))
  nextBtn.title = lang.transl('_fv_nextImage')

  const mediaWrap = el('div', 'w-fv-lb-media')
  stage.appendChild(prevBtn)
  stage.appendChild(mediaWrap)
  stage.appendChild(nextBtn)

  // Right side panel (bottom sheet on mobile)
  const panel = el('aside', 'w-fv-lb-panel')
  const metaWrap = el('div', 'w-fv-lb-meta')
  const editorHost = el('div', 'w-fv-lb-editor-host')
  panel.appendChild(metaWrap)
  panel.appendChild(editorHost)

  shell.appendChild(stage)
  shell.appendChild(panel)
  backdrop.appendChild(shell)

  const finishClose = (notify: boolean): void => {
    if (closed) return
    closed = true
    editor?.destroy()
    editor = null
    document.removeEventListener('keydown', onKeyDown)
    backdrop.remove()
    if (prevFocus && prevFocus.isConnected) {
      prevFocus.focus()
    }
    if (notify) onClose()
  }

  const renderCurrent = (): void => {
    if (closed) return
    if (items.length === 0) {
      finishClose(true)
      return
    }
    if (currentIndex < 0) currentIndex = 0
    if (currentIndex >= items.length) currentIndex = items.length - 1

    const img = items[currentIndex]
    const host = watchStore.hostFor(img.site)

    counterEl.textContent = `${currentIndex + 1} / ${items.length}`
    prevBtn.disabled = items.length <= 1
    nextBtn.disabled = items.length <= 1

    // Image stage: thumbnail as placeholder until full image finishes loading
    loadToken += 1
    const token = loadToken
    mediaWrap.replaceChildren()

    const thumb = el('img', 'w-fv-lb-img is-thumb')
    thumb.alt = img.postTitle || img.fileName || ''
    thumb.src = thumbUrl(host, img.path)
    mediaWrap.appendChild(thumb)

    // Kemono has only thumbnails left: nothing larger to load
    const fullSrc = hasOriginalFiles(host) ? fullImageUrl(host, img.path) : ''
    if (fullSrc) {
      const full = el('img', 'w-fv-lb-img is-full')
      full.alt = img.postTitle || img.fileName || ''
      full.decoding = 'async'
      full.addEventListener('load', () => {
        if (closed || token !== loadToken) return
        full.classList.add('is-loaded')
        thumb.remove()
      })
      full.addEventListener('error', () => {
        if (closed || token !== loadToken) return
        full.remove()
      })
      full.src = fullSrc
      mediaWrap.appendChild(full)
    }

    // Meta links
    metaWrap.replaceChildren()

    const postLink = el(
      'a',
      'w-fv-lb-post-link',
      img.postTitle || lang.transl('_fv_openPost')
    )
    postLink.href = postPageUrl(host, img.service, img.creatorId, img.postId)
    postLink.target = '_blank'
    postLink.rel = 'noopener noreferrer'
    metaWrap.appendChild(postLink)

    const creatorRow = el('div', 'w-fv-modal-sub')
    const creatorLink = el(
      'a',
      'w-fv-post-creator',
      img.creatorName || img.creatorId
    )
    creatorLink.href = creatorPageUrl(host, img.service, img.creatorId)
    creatorLink.target = '_blank'
    creatorLink.rel = 'noopener noreferrer'
    creatorRow.appendChild(creatorLink)
    creatorRow.appendChild(
      el('span', `w-badge w-badge-${img.site}`, siteLabel(img.site))
    )
    creatorRow.appendChild(el('span', 'w-badge', img.service))
    metaWrap.appendChild(creatorRow)

    if (img.fileName) {
      const fileEl = el('div', 'w-fv-lb-filename', img.fileName)
      fileEl.title = img.fileName
      metaWrap.appendChild(fileEl)
    }

    // Editor
    editor?.destroy()
    editorHost.replaceChildren()
    editor = createFavEditor({
      store: favImages,
      itemKey: img.key,
      onRemoved: () => {
        items = items.filter((it) => it.key !== img.key)
        if (items.length === 0) {
          finishClose(true)
        } else {
          if (currentIndex >= items.length) currentIndex = items.length - 1
          renderCurrent()
        }
      },
    })
    editorHost.appendChild(editor.element)
  }

  const goDelta = (delta: number): void => {
    if (items.length <= 1) return
    currentIndex = (currentIndex + delta + items.length) % items.length
    renderCurrent()
  }

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      finishClose(true)
      return
    }
    if (ev.key === 'Tab') {
      trapFocus(shell, ev)
      return
    }
    if (isEditableTarget(ev.target)) return
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      goDelta(-1)
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault()
      goDelta(1)
    }
  }

  prevBtn.addEventListener('click', () => goDelta(-1))
  nextBtn.addEventListener('click', () => goDelta(1))
  closeBtn.addEventListener('click', () => finishClose(true))
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) finishClose(true)
  })
  stage.addEventListener('click', (ev) => {
    if (ev.target === stage || ev.target === mediaWrap) finishClose(true)
  })

  document.addEventListener('keydown', onKeyDown)
  document.body.appendChild(backdrop)
  renderCurrent()
  closeBtn.focus()

  return {
    sync(nextItems) {
      if (closed) return
      const currentKey = items[currentIndex]?.key
      items = [...nextItems]
      if (items.length === 0) {
        finishClose(true)
        return
      }
      const nextIdx = currentKey
        ? items.findIndex((i) => i.key === currentKey)
        : -1
      if (nextIdx !== -1) {
        currentIndex = nextIdx
        counterEl.textContent = `${currentIndex + 1} / ${items.length}`
        prevBtn.disabled = items.length <= 1
        nextBtn.disabled = items.length <= 1
        editor?.sync()
      } else {
        if (currentIndex >= items.length) currentIndex = items.length - 1
        renderCurrent()
      }
    },
    destroy() {
      finishClose(false)
    },
  }
}
