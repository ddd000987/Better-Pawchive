/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Favorite posts grid view and post editor modal. */

import { lang } from '../Language'
import { favPosts } from '../watch/collectStore'
import type { FavPost } from '../watch/collectTypes'
import { creatorPageUrl, postPageUrl, thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import { MIME_FAV_POST, el, formatDate, siteLabel } from './dom'
import { createFavEditor, trapFocus, type FavEditorHandle } from './favEditor'
import { renderStars } from './stars'
import { renderTagChips } from './tagInput'

export interface FavPostsCallbacks {
  onOpenEditor: (key: string) => void
  onToggleSelect: (key: string, shiftKey: boolean) => void
  onTagClick: (tag: string) => void
}

export interface FavPostsRenderParams {
  posts: FavPost[]
  totalCount: number
  hasQuery: boolean
  selectMode: boolean
  selected: Set<string>
  callbacks: FavPostsCallbacks
}

export interface PostEditorModalHandle {
  key: string
  sync: () => void
  destroy: () => void
}

export function renderFavPostsView(
  root: HTMLElement,
  params: FavPostsRenderParams
): void {
  const { posts, totalCount, hasQuery, selectMode, selected, callbacks } =
    params

  root.replaceChildren()

  if (posts.length === 0) {
    const empty = el('div', 'w-empty')
    if (totalCount === 0) {
      empty.appendChild(
        el('p', 'w-empty-text', lang.transl('_fv_emptyPostsAll'))
      )
      empty.appendChild(
        el('p', 'w-empty-hint', lang.transl('_fv_emptyPostsHint'))
      )
    } else if (hasQuery) {
      empty.appendChild(el('p', 'w-empty-text', lang.transl('_w_emptySearch')))
    } else {
      empty.appendChild(el('p', 'w-empty-text', lang.transl('_fv_emptyFolder')))
      empty.appendChild(
        el('p', 'w-empty-hint', lang.transl('_fv_emptyPostsHint'))
      )
    }
    root.appendChild(empty)
    return
  }

  const grid = el('div', 'w-fv-post-grid')

  for (const post of posts) {
    const host = watchStore.hostFor(post.site)
    const isSelected = selected.has(post.key)
    const titleText = post.title || post.postId

    const card = el('article', 'w-fv-post-card')
    if (selectMode) card.classList.add('is-select-mode')
    if (isSelected) card.classList.add('is-selected')
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', titleText)
    if (selectMode) {
      card.setAttribute('aria-pressed', String(isSelected))
    }

    card.draggable = true
    card.addEventListener('dragstart', (ev) => {
      card.classList.add('is-dragging')
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData(MIME_FAV_POST, post.key)
      }
    })
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging')
    })

    const activate = (shiftKey: boolean): void => {
      if (selectMode) {
        callbacks.onToggleSelect(post.key, shiftKey)
      } else {
        callbacks.onOpenEditor(post.key)
      }
    }

    card.addEventListener('click', (ev) => {
      const target = ev.target as Element | null
      if (!selectMode && target?.closest('a')) return
      activate(ev.shiftKey)
    })
    card.addEventListener('keydown', (ev) => {
      if (ev.target !== card) return
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        activate(ev.shiftKey)
      }
    })

    // Cover
    const cover = el('div', 'w-fv-post-cover')
    if (post.coverPath) {
      const img = el('img', 'w-fv-post-img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = ''
      img.src = thumbUrl(host, post.coverPath)
      img.addEventListener('error', () => {
        img.remove()
      })
      cover.appendChild(img)
    }
    if (selectMode) {
      const check = el(
        'span',
        isSelected ? 'w-check is-checked' : 'w-check',
        isSelected ? '✓' : ''
      )
      check.setAttribute('aria-hidden', 'true')
      cover.appendChild(check)
    }
    card.appendChild(cover)

    // Body
    const body = el('div', 'w-fv-post-body')

    const titleLink = el('a', 'w-fv-post-title', titleText)
    titleLink.href = postPageUrl(
      host,
      post.service,
      post.creatorId,
      post.postId
    )
    titleLink.target = '_blank'
    titleLink.rel = 'noopener noreferrer'
    titleLink.addEventListener('click', (ev) => {
      if (selectMode) {
        ev.preventDefault()
      } else {
        ev.stopPropagation()
      }
    })
    body.appendChild(titleLink)

    const meta = el('div', 'w-fv-post-meta')
    const creatorLink = el(
      'a',
      'w-fv-post-creator',
      post.creatorName || post.creatorId
    )
    creatorLink.href = creatorPageUrl(host, post.service, post.creatorId)
    creatorLink.target = '_blank'
    creatorLink.rel = 'noopener noreferrer'
    creatorLink.addEventListener('click', (ev) => {
      if (selectMode) {
        ev.preventDefault()
      } else {
        ev.stopPropagation()
      }
    })
    meta.appendChild(creatorLink)

    if (post.published) {
      meta.appendChild(el('span', 'w-fv-post-date', formatDate(post.published)))
    }
    body.appendChild(meta)

    if (post.rating !== undefined || (post.tags && post.tags.length > 0)) {
      const labelsRow = el('div', 'w-card-labels')
      if (post.rating !== undefined) {
        labelsRow.appendChild(renderStars(post.rating, { size: 'sm' }))
      }
      if (post.tags && post.tags.length > 0) {
        labelsRow.appendChild(
          renderTagChips(post.tags, {
            max: 3,
            onClick: selectMode ? undefined : callbacks.onTagClick,
          })
        )
      }
      body.appendChild(labelsRow)
    }

    const note = post.note?.trim()
    if (note) {
      const noteEl = el('div', 'w-fv-post-note', note)
      noteEl.title = note
      body.appendChild(noteEl)
    }

    card.appendChild(body)
    grid.appendChild(card)
  }

  root.appendChild(grid)
}

export function openFavPostEditorModal(
  postKey: string,
  onClose: () => void
): PostEditorModalHandle | null {
  const post = favPosts.get(postKey)
  if (!post) return null

  const prevFocus = document.activeElement as HTMLElement | null
  const host = watchStore.hostFor(post.site)

  const backdrop = el('div', 'w-modal-backdrop w-fv-modal-backdrop')
  const modal = el('div', 'w-modal w-fv-editor-modal')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-label', post.title || post.postId)

  const header = el('div', 'w-modal-header')
  const titleWrap = el('div', 'w-fv-modal-head-info')
  const titleLink = el('a', 'w-fv-modal-link', post.title || post.postId)
  titleLink.href = postPageUrl(host, post.service, post.creatorId, post.postId)
  titleLink.target = '_blank'
  titleLink.rel = 'noopener noreferrer'
  titleWrap.appendChild(titleLink)

  const subRow = el('div', 'w-fv-modal-sub')
  const creatorLink = el(
    'a',
    'w-fv-post-creator',
    post.creatorName || post.creatorId
  )
  creatorLink.href = creatorPageUrl(host, post.service, post.creatorId)
  creatorLink.target = '_blank'
  creatorLink.rel = 'noopener noreferrer'
  subRow.appendChild(creatorLink)
  subRow.appendChild(
    el('span', `w-badge w-badge-${post.site}`, siteLabel(post.site))
  )
  subRow.appendChild(el('span', 'w-badge', post.service))
  if (post.published) {
    subRow.appendChild(el('span', 'w-fv-post-date', formatDate(post.published)))
  }
  titleWrap.appendChild(subRow)
  header.appendChild(titleWrap)

  const closeBtn = el('button', 'w-icon-btn w-fv-modal-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', lang.transl('_fv_close'))
  closeBtn.title = lang.transl('_fv_close')
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const content = el('div', 'w-fv-modal-body')

  if (post.coverPath) {
    const preview = el('div', 'w-fv-modal-cover')
    const img = el('img', 'w-fv-post-img')
    img.src = thumbUrl(host, post.coverPath)
    img.alt = ''
    img.addEventListener('error', () => {
      preview.remove()
    })
    preview.appendChild(img)
    content.appendChild(preview)
  }

  let closed = false
  let editor: FavEditorHandle | null = null

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

  editor = createFavEditor({
    store: favPosts,
    itemKey: postKey,
    onRemoved: () => finishClose(true),
  })
  content.appendChild(editor.element)
  modal.appendChild(content)
  backdrop.appendChild(modal)

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      finishClose(true)
      return
    }
    if (ev.key === 'Tab') {
      trapFocus(modal, ev)
    }
  }

  closeBtn.addEventListener('click', () => finishClose(true))
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) finishClose(true)
  })
  document.addEventListener('keydown', onKeyDown)
  document.body.appendChild(backdrop)
  closeBtn.focus()

  return {
    key: postKey,
    sync() {
      if (closed) return
      if (!favPosts.has(postKey)) {
        finishClose(true)
        return
      }
      editor?.sync()
    },
    destroy() {
      finishClose(false)
    },
  }
}
