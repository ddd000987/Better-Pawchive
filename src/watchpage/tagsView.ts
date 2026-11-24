/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Tag manager view (#/tags): list all tags with counts, inline rename/merge, delete, and filter navigation. */

import { lang } from '../Language'
import { MAX_TAG_LEN, normalizeTag } from '../watch/labels'
import { allTagCounts } from '../watch/tagOps'
import { el } from './dom'

export interface TagsViewCallbacks {
  onFilterByTag: (tag: string) => void
  onRenameTag: (from: string, to: string) => Promise<void>
  onDeleteTag: (tag: string) => Promise<void>
}

export function renderTagsToolbar(root: HTMLElement): void {
  root.replaceChildren()
  root.className = 'w-toolbar-wrap'

  const topRow = el('div', 'w-toolbar')
  topRow.appendChild(el('h1', 'w-view-title', lang.transl('_lb_tagsNav')))
  root.appendChild(topRow)
}

export function renderTagsView(
  root: HTMLElement,
  callbacks: TagsViewCallbacks
): void {
  const entries = allTagCounts()
  const existingByLower = new Map(
    entries.map((e) => [e.tag.toLowerCase(), e.tag])
  )

  root.replaceChildren()

  if (entries.length === 0) {
    const empty = el('div', 'w-empty')
    empty.appendChild(el('p', 'w-empty-text', lang.transl('_lb_emptyTags')))
    root.appendChild(empty)
    return
  }

  const card = el('div', 'w-tags-manager')

  const head = el('div', 'w-tags-row w-tags-head')
  head.appendChild(el('span', 'w-tags-col-name', lang.transl('_lb_tagName')))
  head.appendChild(el('span', 'w-tags-col-count', lang.transl('_lb_tagCount')))
  head.appendChild(el('span', 'w-tags-col-actions', ''))
  card.appendChild(head)

  for (const entry of entries) {
    const row = el('div', 'w-tags-row')

    const nameCol = el('div', 'w-tags-col-name')
    const tagBtn = el('button', 'w-tags-name-btn', entry.tag)
    tagBtn.type = 'button'
    tagBtn.addEventListener('click', () => {
      callbacks.onFilterByTag(entry.tag)
    })
    nameCol.appendChild(tagBtn)
    row.appendChild(nameCol)

    row.appendChild(el('span', 'w-tags-col-count', String(entry.count)))

    const actions = el('div', 'w-tags-col-actions')

    const renameBtn = el('button', 'w-icon-btn', '✎')
    renameBtn.type = 'button'
    renameBtn.title = lang.transl('_lb_renameTag')
    renameBtn.setAttribute('aria-label', lang.transl('_lb_renameTag'))
    renameBtn.addEventListener('click', () => {
      startInlineTagRename(
        nameCol,
        entry.tag,
        existingByLower,
        callbacks.onRenameTag
      )
    })
    actions.appendChild(renameBtn)

    const delBtn = el('button', 'w-icon-btn w-icon-btn-danger', '×')
    delBtn.type = 'button'
    delBtn.title = lang.transl('_lb_deleteTag')
    delBtn.setAttribute('aria-label', lang.transl('_lb_deleteTag'))
    delBtn.addEventListener('click', () => {
      const ok = window.confirm(
        lang.transl('_lb_deleteTagConfirm', entry.tag, String(entry.count))
      )
      if (ok) {
        void callbacks.onDeleteTag(entry.tag)
      }
    })
    actions.appendChild(delBtn)

    row.appendChild(actions)
    card.appendChild(row)
  }

  root.appendChild(card)
}

function startInlineTagRename(
  cell: HTMLElement,
  currentTag: string,
  existingByLower: Map<string, string>,
  onRename: (from: string, to: string) => Promise<void>
): void {
  const input = el('input', 'w-inline-input')
  input.type = 'text'
  input.maxLength = MAX_TAG_LEN
  input.value = currentTag
  input.setAttribute('aria-label', lang.transl('_lb_renameTag'))

  const origChildren = Array.from(cell.childNodes)
  cell.replaceChildren(input)
  input.focus()
  input.select()

  let finished = false
  const restore = (): void => {
    cell.replaceChildren(...origChildren)
  }
  const commit = (): void => {
    if (finished) return
    finished = true
    const next = normalizeTag(input.value)
    if (!next || next === currentTag) {
      restore()
      return
    }
    const fromLower = currentTag.toLowerCase()
    const nextLower = next.toLowerCase()
    const existingTarget = existingByLower.get(nextLower)
    if (existingTarget && nextLower !== fromLower) {
      const ok = window.confirm(
        lang.transl('_lb_mergeTagConfirm', existingTarget, currentTag, next)
      )
      if (!ok) {
        restore()
        return
      }
    }
    void onRename(currentTag, next)
  }
  const cancel = (): void => {
    if (finished) return
    finished = true
    restore()
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      commit()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      cancel()
    }
  })
  input.addEventListener('blur', () => commit())
}
