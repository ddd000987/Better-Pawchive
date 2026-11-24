/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Read-only and interactive 5-star rating components for the watch page. */

import { lang } from '../Language'
import type { Rating } from '../watch/collectTypes'
import { sanitizeRating } from '../watch/labels'
import { el } from './dom'

export interface StarInputOptions {
  value?: Rating | null
  onChange: (rating: Rating | null) => void
}

export interface StarInputHandle {
  element: HTMLElement
  setValue: (next: Rating | null | undefined) => void
}

/** Render a read-only 5-star rating display. */
export function renderStars(
  rating: number | undefined,
  opts?: { size?: 'sm' | 'md' }
): HTMLElement {
  const size = opts?.size ?? 'md'
  const val = sanitizeRating(rating) ?? 0
  const wrap = el('span', `w-stars w-stars-${size}`)
  wrap.setAttribute('role', 'img')
  wrap.setAttribute(
    'aria-label',
    val > 0
      ? lang.transl('_lb_ratedOf', String(val))
      : lang.transl('_lb_notRated')
  )

  for (let i = 1; i <= 5; i++) {
    const filled = i <= val
    const star = el(
      'span',
      filled ? 'w-star is-filled' : 'w-star',
      filled ? '★' : '☆'
    )
    star.setAttribute('aria-hidden', 'true')
    wrap.appendChild(star)
  }

  return wrap
}

/** Create an interactive 5-star rating input with hover preview and radio-group keyboard semantics. */
export function createStarInput(opts: StarInputOptions): StarInputHandle {
  let current: Rating | null = sanitizeRating(opts.value) ?? null
  let hoverValue: number | null = null

  const group = el('div', 'w-star-input')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', lang.transl('_lb_ratingLabel'))

  const buttons: HTMLButtonElement[] = []

  const syncVisuals = (): void => {
    const display = hoverValue ?? current ?? 0
    for (let i = 0; i < 5; i++) {
      const n = i + 1
      const btn = buttons[i]
      const filled = n <= display
      const checked = current === n
      btn.textContent = filled ? '★' : '☆'
      btn.className = filled
        ? hoverValue !== null
          ? 'w-star-btn is-filled is-preview'
          : 'w-star-btn is-filled'
        : 'w-star-btn'
      btn.setAttribute('aria-checked', String(checked))
      btn.tabIndex = current ? (checked ? 0 : -1) : n === 1 ? 0 : -1
    }
  }

  const commit = (next: Rating | null): void => {
    if (next === current) return
    current = next
    hoverValue = null
    syncVisuals()
    opts.onChange(current)
  }

  group.addEventListener('mouseleave', () => {
    if (hoverValue !== null) {
      hoverValue = null
      syncVisuals()
    }
  })

  for (let i = 1; i <= 5; i++) {
    const n = i as Rating
    const btn = el('button', 'w-star-btn', '☆')
    btn.type = 'button'
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-label', lang.transl('_lb_rateStar', String(n)))

    btn.addEventListener('mouseenter', () => {
      hoverValue = n
      syncVisuals()
    })

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      commit(current === n ? null : n)
    })

    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const next = (current ? Math.min(5, current + 1) : 1) as Rating
        commit(next)
        buttons[next - 1].focus()
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
        ev.preventDefault()
        const next = (current ? Math.max(1, current - 1) : 1) as Rating
        commit(next)
        buttons[next - 1].focus()
      } else if (ev.key === 'Home') {
        ev.preventDefault()
        commit(1)
        buttons[0].focus()
      } else if (ev.key === 'End') {
        ev.preventDefault()
        commit(5)
        buttons[4].focus()
      } else if (
        ev.key === 'Delete' ||
        ev.key === 'Backspace' ||
        ev.key === '0'
      ) {
        ev.preventDefault()
        commit(null)
        buttons[0].focus()
      } else if (ev.key >= '1' && ev.key <= '5') {
        ev.preventDefault()
        const num = Number(ev.key) as Rating
        commit(num)
        buttons[num - 1].focus()
      }
    })

    buttons.push(btn)
    group.appendChild(btn)
  }

  syncVisuals()

  return {
    element: group,
    setValue(next) {
      const sanitized = sanitizeRating(next) ?? null
      if (sanitized === current) return
      current = sanitized
      hoverValue = null
      syncVisuals()
    },
  }
}
