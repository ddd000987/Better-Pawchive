/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Tag chip display and interactive tag input with autocomplete suggestions. */

import { lang } from '../Language'
import { MAX_TAGS, normalizeTag, normalizeTags } from '../watch/labels'
import { allTagCounts } from '../watch/tagOps'
import { el } from './dom'

const MAX_SUGGESTIONS = 8

export interface TagInputOptions {
  tags?: string[]
  onChange: (tags: string[]) => void
}

export interface TagInputHandle {
  element: HTMLElement
  setTags: (tags: string[] | undefined) => void
}

export interface TagChipsOptions {
  max?: number
  onClick?: (tag: string) => void
}

/** Render read-only tag chips with optional max overflow ("+N") and click handler. */
export function renderTagChips(
  tags: string[] | undefined,
  opts?: TagChipsOptions
): HTMLElement {
  const wrap = el('div', 'w-tag-chips')
  if (!tags || tags.length === 0) return wrap

  const limit = opts?.max !== undefined && opts.max > 0 ? opts.max : tags.length
  const visible = tags.slice(0, limit)
  const overflow = tags.length - visible.length

  for (const tag of visible) {
    if (opts?.onClick) {
      const btn = el('button', 'w-tag-chip is-clickable', tag)
      btn.type = 'button'
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        opts.onClick!(tag)
      })
      btn.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.stopPropagation()
        }
      })
      wrap.appendChild(btn)
    } else {
      wrap.appendChild(el('span', 'w-tag-chip', tag))
    }
  }

  if (overflow > 0) {
    wrap.appendChild(el('span', 'w-tag-chip w-tag-chip-more', `+${overflow}`))
  }

  return wrap
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Create an interactive tag input with chips, Enter/comma add, Backspace remove, and autocomplete. */
export function createTagInput(opts: TagInputOptions): TagInputHandle {
  let current: string[] = normalizeTags(opts.tags) ?? []
  let activeIndex = -1
  let currentSuggestions: Array<{ tag: string; count: number }> = []
  let focused = false

  const root = el('div', 'w-tag-input-root')
  const box = el('div', 'w-tag-input-box')
  const chipsWrap = el('div', 'w-tag-input-chips')

  const input = el('input', 'w-tag-input-field')
  input.type = 'text'
  input.placeholder = lang.transl('_lb_addTagPlaceholder')
  input.setAttribute('aria-label', lang.transl('_lb_tagsLabel'))
  input.setAttribute('autocomplete', 'off')

  const dropdown = el('div', 'w-tag-suggestions')
  dropdown.setAttribute('role', 'listbox')
  dropdown.hidden = true

  box.appendChild(chipsWrap)
  box.appendChild(input)
  root.appendChild(box)
  root.appendChild(dropdown)

  box.addEventListener('click', (ev) => {
    if (ev.target === box || ev.target === chipsWrap) {
      input.focus()
    }
  })

  const emit = (next: string[]): void => {
    if (sameTags(current, next)) return
    current = next
    renderChips()
    renderSuggestions()
    opts.onChange([...current])
  }

  const addRawTag = (raw: string): boolean => {
    const norm = normalizeTag(raw)
    if (!norm) return false
    if (current.length >= MAX_TAGS) return false
    const lower = norm.toLowerCase()
    if (current.some((t) => t.toLowerCase() === lower)) return false
    emit([...current, norm])
    return true
  }

  const removeAt = (index: number): void => {
    if (index < 0 || index >= current.length) return
    const next = current.filter((_, i) => i !== index)
    emit(next)
  }

  const renderChips = (): void => {
    chipsWrap.replaceChildren()
    current.forEach((tag, idx) => {
      const chip = el('span', 'w-tag-chip w-tag-chip-edit')
      chip.appendChild(el('span', 'w-tag-chip-text', tag))
      const rm = el('button', 'w-tag-chip-rm', '×')
      rm.type = 'button'
      rm.setAttribute('aria-label', lang.transl('_lb_removeTag', tag))
      rm.addEventListener('click', (ev) => {
        ev.stopPropagation()
        removeAt(idx)
        input.focus()
      })
      chip.appendChild(rm)
      chipsWrap.appendChild(chip)
    })
  }

  const closeSuggestions = (): void => {
    activeIndex = -1
    currentSuggestions = []
    dropdown.hidden = true
    dropdown.replaceChildren()
  }

  const renderSuggestions = (): void => {
    if (!focused || current.length >= MAX_TAGS) {
      closeSuggestions()
      return
    }
    const q = input.value.trim().toLowerCase()
    const existing = new Set(current.map((t) => t.toLowerCase()))
    const matches = allTagCounts()
      .filter((entry) => {
        const lower = entry.tag.toLowerCase()
        if (existing.has(lower)) return false
        return q === '' || lower.includes(q)
      })
      .slice(0, MAX_SUGGESTIONS)

    if (matches.length === 0) {
      closeSuggestions()
      return
    }

    currentSuggestions = matches
    if (activeIndex >= matches.length) activeIndex = matches.length - 1
    dropdown.replaceChildren()

    matches.forEach((entry, idx) => {
      const item = el(
        'button',
        idx === activeIndex
          ? 'w-tag-suggest-item is-active'
          : 'w-tag-suggest-item'
      )
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(idx === activeIndex))
      item.appendChild(el('span', 'w-tag-suggest-name', entry.tag))
      item.appendChild(el('span', 'w-tag-suggest-count', String(entry.count)))
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        addRawTag(entry.tag)
        input.value = ''
        activeIndex = -1
        renderSuggestions()
        input.focus()
      })
      dropdown.appendChild(item)
    })

    dropdown.hidden = false
  }

  input.addEventListener('focus', () => {
    focused = true
    renderSuggestions()
  })

  input.addEventListener('blur', () => {
    focused = false
    if (input.value.trim()) {
      addRawTag(input.value)
      input.value = ''
    }
    closeSuggestions()
  })

  input.addEventListener('input', () => {
    if (input.value.includes(',')) {
      const parts = input.value.split(',')
      const remainder = parts.pop() ?? ''
      let changed = false
      const next = [...current]
      for (const part of parts) {
        const norm = normalizeTag(part)
        if (!norm || next.length >= MAX_TAGS) continue
        const lower = norm.toLowerCase()
        if (next.some((t) => t.toLowerCase() === lower)) continue
        next.push(norm)
        changed = true
      }
      input.value = remainder
      if (changed) emit(next)
    }
    activeIndex = -1
    renderSuggestions()
  })

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && currentSuggestions.length > 0) {
      ev.preventDefault()
      activeIndex = (activeIndex + 1) % currentSuggestions.length
      renderSuggestions()
      return
    }
    if (ev.key === 'ArrowUp' && currentSuggestions.length > 0) {
      ev.preventDefault()
      activeIndex =
        activeIndex <= 0 ? currentSuggestions.length - 1 : activeIndex - 1
      renderSuggestions()
      return
    }
    if (ev.key === 'Escape') {
      if (!dropdown.hidden) {
        ev.preventDefault()
        ev.stopPropagation()
        closeSuggestions()
      }
      return
    }
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault()
      if (
        ev.key === 'Enter' &&
        activeIndex >= 0 &&
        activeIndex < currentSuggestions.length
      ) {
        addRawTag(currentSuggestions[activeIndex].tag)
      } else {
        addRawTag(input.value)
      }
      input.value = ''
      activeIndex = -1
      renderSuggestions()
      return
    }
    if (ev.key === 'Backspace' && input.value === '' && current.length > 0) {
      ev.preventDefault()
      removeAt(current.length - 1)
    }
  })

  renderChips()

  return {
    element: root,
    setTags(nextTags) {
      const normalized = normalizeTags(nextTags) ?? []
      if (sameTags(current, normalized)) return
      current = normalized
      renderChips()
      if (focused) renderSuggestions()
    },
  }
}
