/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Responsive thumbnail grid view for favorite images. */

import { lang } from '../Language'
import type { FavImage } from '../watch/collectTypes'
import { thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import { MIME_FAV_IMAGE, el } from './dom'
import { renderStars } from './stars'
import { renderTagChips } from './tagInput'

export interface FavImagesCallbacks {
  onOpenLightbox: (key: string) => void
  onToggleSelect: (key: string, shiftKey: boolean) => void
}

export interface FavImagesRenderParams {
  images: FavImage[]
  totalCount: number
  hasQuery: boolean
  selectMode: boolean
  selected: Set<string>
  callbacks: FavImagesCallbacks
}

export function renderFavImagesView(
  root: HTMLElement,
  params: FavImagesRenderParams
): void {
  const { images, totalCount, hasQuery, selectMode, selected, callbacks } =
    params

  root.replaceChildren()

  if (images.length === 0) {
    const empty = el('div', 'w-empty')
    if (totalCount === 0) {
      empty.appendChild(
        el('p', 'w-empty-text', lang.transl('_fv_emptyImagesAll'))
      )
      empty.appendChild(
        el('p', 'w-empty-hint', lang.transl('_fv_emptyImagesHint'))
      )
    } else if (hasQuery) {
      empty.appendChild(el('p', 'w-empty-text', lang.transl('_w_emptySearch')))
    } else {
      empty.appendChild(el('p', 'w-empty-text', lang.transl('_fv_emptyFolder')))
      empty.appendChild(
        el('p', 'w-empty-hint', lang.transl('_fv_emptyImagesHint'))
      )
    }
    root.appendChild(empty)
    return
  }

  const grid = el('div', 'w-fv-img-grid')

  for (const image of images) {
    const host = watchStore.hostFor(image.site)
    const isSelected = selected.has(image.key)
    const label = image.postTitle || image.fileName || image.path

    const tile = el('article', 'w-fv-img-tile')
    if (selectMode) tile.classList.add('is-select-mode')
    if (isSelected) tile.classList.add('is-selected')
    tile.tabIndex = 0
    tile.setAttribute('role', 'button')
    tile.setAttribute('aria-label', label)
    if (selectMode) {
      tile.setAttribute('aria-pressed', String(isSelected))
    }

    tile.draggable = true
    tile.addEventListener('dragstart', (ev) => {
      tile.classList.add('is-dragging')
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData(MIME_FAV_IMAGE, image.key)
      }
    })
    tile.addEventListener('dragend', () => {
      tile.classList.remove('is-dragging')
    })

    const activate = (shiftKey: boolean): void => {
      if (selectMode) {
        callbacks.onToggleSelect(image.key, shiftKey)
      } else {
        callbacks.onOpenLightbox(image.key)
      }
    }

    tile.addEventListener('click', (ev) => {
      activate(ev.shiftKey)
    })
    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        activate(ev.shiftKey)
      }
    })

    const thumb = el('img', 'w-fv-img-thumb')
    thumb.loading = 'lazy'
    thumb.decoding = 'async'
    thumb.alt = ''
    thumb.src = thumbUrl(host, image.path)
    thumb.addEventListener('error', () => {
      thumb.remove()
    })
    tile.appendChild(thumb)

    if (image.rating !== undefined || (image.tags && image.tags.length > 0)) {
      const overlay = el('div', 'w-fv-img-overlay')
      if (image.rating !== undefined) {
        overlay.appendChild(renderStars(image.rating, { size: 'sm' }))
      }
      if (image.tags && image.tags.length > 0) {
        overlay.appendChild(renderTagChips(image.tags, { max: 2 }))
      }
      tile.appendChild(overlay)
    }

    if (selectMode) {
      const check = el(
        'span',
        isSelected ? 'w-check is-checked' : 'w-check',
        isSelected ? '✓' : ''
      )
      check.setAttribute('aria-hidden', 'true')
      tile.appendChild(check)
    }

    grid.appendChild(tile)
  }

  root.appendChild(grid)
}
