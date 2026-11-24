/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Shared favorite item editor panel (folder, rating, tags, note, remove) and modal focus-trap helper. */

import { lang } from '../Language'
import type { CollectStore } from '../watch/collectStore'
import type { Labels } from '../watch/collectTypes'
import { sortedFolders } from '../watch/watchData'
import { el, folderLabel } from './dom'
import { createStarInput } from './stars'
import { createTagInput } from './tagInput'

const NOTE_DEBOUNCE_MS = 500
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface FavEditableItem extends Labels {
  key: string
  folderId: string
  addedAt: number
  note?: string
}

export interface FavEditorOptions<T extends FavEditableItem> {
  store: CollectStore<T>
  itemKey: string
  onRemoved?: () => void
}

export interface FavEditorHandle {
  element: HTMLElement
  sync: () => void
  destroy: () => void
}

/** Trap Tab / Shift+Tab focus within a modal container. */
export function trapFocus(container: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== 'Tab') return
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((node) => !node.hidden && node.offsetParent !== null)
  if (focusable.length === 0) {
    ev.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (ev.shiftKey) {
    if (!active || active === first || !container.contains(active)) {
      ev.preventDefault()
      last.focus()
    }
  } else {
    if (!active || active === last || !container.contains(active)) {
      ev.preventDefault()
      first.focus()
    }
  }
}

/** Create a reusable editor panel for a favorite post or favorite image. */
export function createFavEditor<T extends FavEditableItem>(
  opts: FavEditorOptions<T>
): FavEditorHandle {
  const { store, itemKey } = opts
  const item = store.get(itemKey)

  const root = el('div', 'w-fv-editor')

  // Folder select
  const folderField = el('div', 'w-field')
  const folderLabelEl = el(
    'label',
    'w-field-label',
    lang.transl('_w_folderLabel')
  )
  const folderSelect = el('select', 'w-select')
  folderSelect.setAttribute('aria-label', lang.transl('_w_folderLabel'))

  const populateFolders = (currentFolderId: string): void => {
    folderSelect.replaceChildren()
    for (const folder of sortedFolders(store.data)) {
      const opt = el('option', undefined, folderLabel(folder))
      opt.value = folder.id
      opt.selected = folder.id === currentFolderId
      folderSelect.appendChild(opt)
    }
  }
  populateFolders(item?.folderId ?? '')

  folderSelect.addEventListener('change', () => {
    const target = folderSelect.value
    if (target) {
      void store.move([itemKey], target)
    }
  })
  folderField.appendChild(folderLabelEl)
  folderField.appendChild(folderSelect)
  root.appendChild(folderField)

  // Rating input
  const ratingField = el('div', 'w-field')
  ratingField.appendChild(
    el('span', 'w-field-label', lang.transl('_lb_ratingLabel'))
  )
  const starInput = createStarInput({
    value: item?.rating,
    onChange: (rating) => {
      void store.update(itemKey, { rating })
    },
  })
  ratingField.appendChild(starInput.element)
  root.appendChild(ratingField)

  // Tags input
  const tagsField = el('div', 'w-field')
  tagsField.appendChild(
    el('span', 'w-field-label', lang.transl('_lb_tagsLabel'))
  )
  const tagInput = createTagInput({
    tags: item?.tags,
    onChange: (tags) => {
      void store.update(itemKey, { tags: tags.length > 0 ? tags : null })
    },
  })
  tagsField.appendChild(tagInput.element)
  root.appendChild(tagsField)

  // Note textarea with blur + 500ms debounce save
  const noteField = el('div', 'w-field')
  const noteHead = el('div', 'w-field-head')
  noteHead.appendChild(
    el('label', 'w-field-label', lang.transl('_w_noteLabel'))
  )
  const savedHint = el('span', 'w-saved-hint', lang.transl('_w_saved'))
  savedHint.setAttribute('aria-live', 'polite')
  noteHead.appendChild(savedHint)
  noteField.appendChild(noteHead)

  const noteArea = el('textarea', 'w-textarea w-fv-note-area')
  noteArea.rows = 3
  noteArea.maxLength = 5000
  noteArea.placeholder = lang.transl('_w_notePlaceholder')
  noteArea.setAttribute('aria-label', lang.transl('_w_noteLabel'))
  noteArea.value = item?.note ?? ''
  noteField.appendChild(noteArea)
  root.appendChild(noteField)

  let lastSavedNote = item?.note ?? ''
  let saveTimer: number | null = null
  let hintTimer: number | null = null
  let destroyed = false

  const flashSaved = (): void => {
    if (destroyed) return
    savedHint.classList.add('is-visible')
    if (hintTimer !== null) window.clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => {
      savedHint.classList.remove('is-visible')
    }, 1500)
  }

  const flushNote = (): void => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    const next = noteArea.value
    if (next === lastSavedNote) return
    if (!store.has(itemKey)) return
    lastSavedNote = next
    void store.update(itemKey, { note: next ? next : null }).then(() => {
      flashSaved()
    })
  }

  noteArea.addEventListener('input', () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      flushNote()
    }, NOTE_DEBOUNCE_MS)
  })

  noteArea.addEventListener('blur', () => {
    flushNote()
  })

  // Remove action
  const actions = el('div', 'w-fv-editor-actions')
  const removeBtn = el(
    'button',
    'w-btn w-btn-danger',
    lang.transl('_fv_removeFav')
  )
  removeBtn.type = 'button'
  removeBtn.addEventListener('click', () => {
    const ok = window.confirm(lang.transl('_fv_removeConfirm'))
    if (!ok) return
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    void store.remove([itemKey]).then(() => {
      opts.onRemoved?.()
    })
  })
  actions.appendChild(removeBtn)
  root.appendChild(actions)

  return {
    element: root,
    sync() {
      const latest = store.get(itemKey)
      if (!latest) return
      populateFolders(latest.folderId)
      starInput.setValue(latest.rating)
      tagInput.setTags(latest.tags)
      const latestNote = latest.note ?? ''
      if (document.activeElement !== noteArea && saveTimer === null) {
        noteArea.value = latestNote
        lastSavedNote = latestNote
      }
    },
    destroy() {
      flushNote()
      destroyed = true
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      if (hintTimer !== null) {
        window.clearTimeout(hintTimer)
        hintTimer = null
      }
    },
  }
}
