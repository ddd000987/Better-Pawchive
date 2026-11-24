/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Grid cards and list rows for watched creators, with selection and drag-and-drop. */

import { lang } from '../Language'
import { watchStore } from '../watch/watchStore'
import type { CreatorSnapshot, WatchedCreator } from '../watch/watchTypes'
import { attachCardPreview, hideCardPreview } from './cardPreview'
import {
  MIME_CREATOR,
  createAvatar,
  el,
  formatDate,
  populateCover,
  siteLabel,
} from './dom'
import { displayName, latestPublished } from './listModel'
import { renderStars } from './stars'
import { renderTagChips } from './tagInput'
import type { ViewMode } from './toolbar'

export interface CreatorListCallbacks {
  onOpenCreator: (key: string) => void
  onToggleSelect: (key: string, shiftKey: boolean) => void
  onTagClick: (tag: string) => void
}

export interface CreatorListRenderParams {
  creators: WatchedCreator[]
  totalInWatchlist: number
  hasQuery: boolean
  emptyMessage?: string
  snaps: Map<string, CreatorSnapshot>
  view: ViewMode
  selectMode: boolean
  selected: Set<string>
  callbacks: CreatorListCallbacks
}

export function renderCreatorList(
  root: HTMLElement,
  params: CreatorListRenderParams
): void {
  const {
    creators,
    totalInWatchlist,
    hasQuery,
    emptyMessage,
    snaps,
    view,
    selectMode,
    selected,
    callbacks,
  } = params

  hideCardPreview()
  root.replaceChildren()

  if (creators.length === 0) {
    const empty = el('div', 'w-empty')
    let msg: string
    if (totalInWatchlist === 0) {
      msg = lang.transl('_w_emptyAll')
    } else if (hasQuery) {
      msg = lang.transl('_w_emptySearch')
    } else if (emptyMessage) {
      msg = emptyMessage
    } else {
      msg = lang.transl('_w_emptyFolder')
    }
    empty.appendChild(el('p', 'w-empty-text', msg))
    root.appendChild(empty)
    return
  }

  const container = el(
    'div',
    view === 'grid' ? 'w-creator-grid' : 'w-creator-list'
  )

  for (const creator of creators) {
    const snap = snaps.get(creator.key)
    const host = watchStore.hostFor(creator.site)
    const isSelected = selected.has(creator.key)

    const card = el('article', view === 'grid' ? 'w-card' : 'w-row')
    if (selectMode) card.classList.add('is-select-mode')
    if (isSelected) card.classList.add('is-selected')
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', displayName(creator))
    if (selectMode) {
      card.setAttribute('aria-pressed', String(isSelected))
    }

    card.draggable = true
    card.addEventListener('dragstart', (ev) => {
      card.classList.add('is-dragging')
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData(MIME_CREATOR, creator.key)
      }
    })
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging')
    })

    const activate = (shiftKey: boolean): void => {
      if (selectMode) {
        callbacks.onToggleSelect(creator.key, shiftKey)
      } else {
        callbacks.onOpenCreator(creator.key)
      }
    }

    card.addEventListener('click', (ev) => {
      activate(ev.shiftKey)
    })
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        activate(ev.shiftKey)
      }
    })

    // Cover area
    const cover = el('div', 'w-card-cover')
    populateCover(cover, creator, snap, host)
    const tracking = creator.tracking
    const isTracked = tracking?.enabled === true
    if (isTracked && tracking.unread.length > 0) {
      const badgeText = tracking.overflow
        ? '50+'
        : String(tracking.unread.length)
      cover.appendChild(el('span', 'w-unread-badge', badgeText))
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
    const body = el('div', 'w-card-body')

    const head = el('div', 'w-card-head')
    head.appendChild(createAvatar(creator, host, 'w-avatar'))

    const names = el('div', 'w-card-names')
    const nameRow = el('div', 'w-card-name-row')
    nameRow.appendChild(el('div', 'w-card-name', displayName(creator)))
    if (isTracked) {
      const bell = el('span', 'w-track-marker', '🔔')
      bell.title = lang.transl('_wt_trackedTitle')
      bell.setAttribute('aria-label', lang.transl('_wt_trackedTitle'))
      nameRow.appendChild(bell)
      if (tracking.lastError) {
        const warn = el('span', 'w-error-marker', '⚠')
        const errTitle = lang.transl('_wt_checkError', tracking.lastError)
        warn.title = errTitle
        warn.setAttribute('aria-label', errTitle)
        nameRow.appendChild(warn)
      }
    }
    names.appendChild(nameRow)
    if (creator.alias) {
      names.appendChild(el('div', 'w-card-orig', creator.name))
    }
    head.appendChild(names)
    body.appendChild(head)

    const meta = el('div', 'w-card-meta')
    const badges = el('div', 'w-badges')
    badges.appendChild(
      el('span', `w-badge w-badge-${creator.site}`, siteLabel(creator.site))
    )
    badges.appendChild(el('span', 'w-badge', creator.service))
    meta.appendChild(badges)

    const latest = latestPublished(snap)
    const dateText = latest ? formatDate(latest) : lang.transl('_w_notFetched')
    meta.appendChild(el('span', 'w-card-date', dateText))
    body.appendChild(meta)

    if (
      creator.rating !== undefined ||
      (creator.tags && creator.tags.length > 0)
    ) {
      const labelsRow = el('div', 'w-card-labels')
      if (creator.rating !== undefined) {
        labelsRow.appendChild(renderStars(creator.rating, { size: 'sm' }))
      }
      if (creator.tags && creator.tags.length > 0) {
        labelsRow.appendChild(
          renderTagChips(creator.tags, {
            max: 3,
            onClick: callbacks.onTagClick,
          })
        )
      }
      body.appendChild(labelsRow)
    }

    const note = creator.note?.trim()
    if (note && view === 'grid') {
      const noteEl = el('div', 'w-card-note', note)
      noteEl.title = note
      body.appendChild(noteEl)
    } else if (note) {
      const firstLine = note.split(/\r?\n/, 1)[0].trim()
      if (firstLine) {
        body.appendChild(el('div', 'w-row-note', firstLine))
      }
    }

    card.appendChild(body)
    attachCardPreview(card, creator, host, selectMode)
    container.appendChild(card)
  }

  root.appendChild(container)
}
