/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixStash src/content/radialMenu.ts (MIT, ddd000987)
 * changes: one post or image per menu (no wheel switching between
 *          targets); the
 *          inner ring holds favorite / download / more / remove, and the
 *          favorite slice opens the outer ring of favorite folders; texts
 *          come from lang.transl; the folder check mark uses the saved
 *          folder instead of a multi-folder membership set; a third ring
 *          picks a rating with the folder; releasing in the center or
 *          outside the open rings closes the menu.
 */

import { lang } from '../Language'
import {
  buildInnerSlices,
  buildOuterCells,
  CELL_DEG,
  clampCenter,
  DEAD_ZONE,
  hitTest,
  INNER_OUTER,
  MENU_RADIUS,
  MOVE_THRESHOLD,
  openRadius,
  OUTER_INNER,
  OUTER_OUTER,
  outerCellAngles,
  RATING_DEG,
  RATING_INNER,
  RATING_OUTER,
  ratingCellAngles,
  RATINGS,
  VIEWPORT_MARGIN,
  type InnerKind,
  type InnerSlice,
  type OuterCell,
  type Point,
  type RadialFolder,
  type RadialHighlight,
} from './radialGeometry'

export type RadialChoice =
  /** `rating` is set when the pointer went on to the rating ring */
  | { kind: 'folder'; folderId: string; label: string; rating?: number }
  | { kind: 'newFolder'; name: string }
  | { kind: 'download' }
  | { kind: 'more' }
  | { kind: 'remove' }

export interface RadialMenuOptions {
  center: Point
  /** Folders in display order; the unsorted folder already has its label */
  folders: RadialFolder[]
  /** Folder the post is saved in, or null when it is not a favorite */
  savedFolderId: string | null
  canDownload: boolean
  /** Caption while the target is not a favorite yet (default: the post) */
  unsavedCaption?: string
  /** Current rating of the target (marked on the rating ring) */
  savedRating?: number | null
  onChoose: (choice: RadialChoice) => void
  onClose?: () => void
}

export interface RadialMenuController {
  move: (point: Point) => void
  release: (point: Point | null) => void
  close: () => void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_PAD = 12
const SVG_HALF = MENU_RADIUS + SVG_PAD
const SVG_SIZE = SVG_HALF * 2

const RADIAL_STYLES = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color-scheme: light dark;
}

* {
  box-sizing: border-box;
}

.backdrop {
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.backdrop.sticky {
  pointer-events: auto;
}

.wheel {
  position: fixed;
  width: ${SVG_SIZE}px;
  height: ${SVG_SIZE}px;
  pointer-events: none;
  user-select: none;
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.22));
}

.slice {
  fill: rgba(255, 255, 255, 0.96);
  stroke: rgba(0, 0, 0, 0.14);
  stroke-width: 1;
}

.slice.expanded {
  fill: #eff6ff;
}

.slice.active {
  fill: #2563eb;
  stroke: #1d4ed8;
}

.slice.remove.active {
  fill: #dc2626;
  stroke: #b91c1c;
}

.slice.disabled {
  fill: rgba(243, 244, 246, 0.88);
}

.center-circle {
  fill: rgba(255, 255, 255, 0.94);
  stroke: rgba(0, 0, 0, 0.14);
  stroke-width: 1;
}

.label {
  fill: #111827;
  font-size: 11px;
  font-weight: 500;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.label.active {
  fill: #ffffff;
  font-weight: 600;
}

.label.disabled {
  fill: #9ca3af;
}

.label.remove {
  fill: #dc2626;
}

.label.remove.active {
  fill: #ffffff;
}

.label.remove.disabled {
  fill: #9ca3af;
}

.label.action {
  fill: #2563eb;
  font-weight: 600;
}

.label.action.active {
  fill: #ffffff;
}

.label.rating {
  fill: #d97706;
  font-size: 10px;
  letter-spacing: -1px;
}

.label.rating.active {
  fill: #ffffff;
}

.slice.rating-current {
  fill: #fef3c7;
}

.dot {
  fill: #2563eb;
  pointer-events: none;
}

.dot.active {
  fill: #ffffff;
}

.check {
  fill: #2563eb;
  font-size: 11px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.check.active {
  fill: #ffffff;
}

.caption {
  position: fixed;
  max-width: 280px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.96);
  color: #111827;
  border: 1px solid rgba(0, 0, 0, 0.14);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
  user-select: none;
  text-align: center;
}

.caption-target {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.caption-entry {
  color: #2563eb;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-folder-box {
  position: fixed;
  width: 220px;
  padding: 10px;
  border-radius: 10px;
  background: #ffffff;
  color: #111827;
  border: 1px solid rgba(0, 0, 0, 0.14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: auto;
  font-size: 13px;
}

.new-folder-title {
  font-weight: 600;
  font-size: 12px;
  color: #374151;
}

.new-folder-input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #f9fafb;
  color: #111827;
  font: inherit;
  font-size: 13px;
  outline: none;
}

.new-folder-input:focus {
  border-color: #2563eb;
  background: #ffffff;
}

.new-folder-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.btn {
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #111827;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
}

.btn:hover {
  background: #f3f4f6;
}

.btn-primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}

.btn-primary:hover {
  background: #1d4ed8;
}

@media (prefers-color-scheme: dark) {
  .wheel {
    filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.55));
  }

  .slice {
    fill: rgba(31, 41, 55, 0.96);
    stroke: rgba(255, 255, 255, 0.14);
  }

  .slice.expanded {
    fill: #1e3a5f;
  }

  .slice.active {
    fill: #2563eb;
    stroke: #3b82f6;
  }

  .slice.remove.active {
    fill: #dc2626;
    stroke: #ef4444;
  }

  .slice.disabled {
    fill: rgba(17, 24, 39, 0.88);
  }

  .center-circle {
    fill: rgba(31, 41, 55, 0.95);
    stroke: rgba(255, 255, 255, 0.14);
  }

  .label {
    fill: #f3f4f6;
  }

  .label.disabled {
    fill: #6b7280;
  }

  .label.remove {
    fill: #f87171;
  }

  .label.remove.disabled {
    fill: #6b7280;
  }

  .label.action {
    fill: #93c5fd;
  }

  .label.rating {
    fill: #fbbf24;
  }

  .slice.rating-current {
    fill: #453a1f;
  }

  .dot {
    fill: #60a5fa;
  }

  .check {
    fill: #60a5fa;
  }

  .caption {
    background: rgba(31, 41, 55, 0.96);
    color: #f3f4f6;
    border-color: rgba(255, 255, 255, 0.14);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
  }

  .caption-entry {
    color: #93c5fd;
  }

  .new-folder-box {
    background: #1f2937;
    color: #f3f4f6;
    border-color: rgba(255, 255, 255, 0.14);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  }

  .new-folder-title {
    color: #d1d5db;
  }

  .new-folder-input {
    background: #111827;
    color: #f3f4f6;
    border-color: #374151;
  }

  .new-folder-input:focus {
    border-color: #60a5fa;
    background: #111827;
  }

  .btn {
    background: #374151;
    border-color: #4b5563;
    color: #f3f4f6;
  }

  .btn:hover {
    background: #4b5563;
  }

  .btn-primary {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
  }

  .btn-primary:hover {
    background: #3b82f6;
  }
}
`

let activeClose: (() => void) | null = null

export function isRadialMenuOpen(): boolean {
  return activeClose !== null
}

function polar(cx: number, cy: number, r: number, deg: number): Point {
  const rad = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function sectorPath(
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  startDeg: number,
  endDeg: number
): string {
  const p1 = polar(cx, cy, rOut, startDeg)
  const p2 = polar(cx, cy, rOut, endDeg)
  const p3 = polar(cx, cy, rIn, endDeg)
  const p4 = polar(cx, cy, rIn, startDeg)
  const largeArc = endDeg - startDeg > 180 ? 1 : 0
  return (
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} ` +
    `A ${rOut} ${rOut} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} ` +
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} ` +
    `A ${rIn} ${rIn} 0 ${largeArc} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`
  )
}

function truncateLabel(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

function sliceLabel(slice: InnerSlice): string {
  switch (slice.kind) {
    case 'favorite':
      return lang.transl('_rm_favorite')
    case 'download':
      return lang.transl('_rm_download')
    case 'more':
      return lang.transl('_rm_more')
    case 'remove':
      return lang.transl('_rm_remove')
  }
}

function cellLabel(cell: OuterCell): string {
  switch (cell.kind) {
    case 'folder':
      return cell.name
    case 'new':
      return lang.transl('_rm_new')
    case 'more':
      return lang.transl('_rm_more')
  }
}

export function openRadialMenu(opts: RadialMenuOptions): RadialMenuController {
  if (activeClose) activeClose()

  const openPoint = { x: opts.center.x, y: opts.center.y }
  const center = clampCenter(openPoint, {
    width: window.innerWidth,
    height: window.innerHeight,
  })
  // Options that cannot be used are left out; the rest share the ring
  const hidden = new Set<InnerKind>()
  if (!opts.canDownload) hidden.add('download')
  if (opts.savedFolderId === null) hidden.add('remove')
  const innerSlices = buildInnerSlices(hidden)
  const outerCells = buildOuterCells(opts.folders)
  const disabled = new Set<InnerKind>()

  let closed = false
  let moved = false
  let sticky = false
  let newFolderOpen = false
  let expanded = false
  /** Folder cell whose rating ring is open */
  let ratingCell: number | null = null
  let highlight: RadialHighlight = { kind: 'none' }

  const host = document.createElement('div')
  host.setAttribute('data-pwp-radial-host', '')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = RADIAL_STYLES
  shadow.appendChild(style)

  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  shadow.appendChild(backdrop)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'wheel')
  svg.setAttribute('viewBox', `0 0 ${SVG_SIZE} ${SVG_SIZE}`)
  svg.style.left = `${Math.round(center.x - SVG_HALF)}px`
  svg.style.top = `${Math.round(center.y - SVG_HALF)}px`
  shadow.appendChild(svg)

  const caption = document.createElement('div')
  caption.className = 'caption'
  caption.lang = lang.htmlLang()
  shadow.appendChild(caption)

  let newFolderBox: HTMLDivElement | null = null
  let newFolderInput: HTMLInputElement | null = null

  const savedFolderName = (): string | null => {
    if (opts.savedFolderId === null) return null
    const f = opts.folders.find((x) => x.id === opts.savedFolderId)
    return f ? f.name : null
  }

  const positionCaption = () => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = caption.getBoundingClientRect()
    const width = rect.width || 180
    const height = rect.height || 36
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(center.x - width / 2, vw - width - VIEWPORT_MARGIN)
    )
    const belowTop = center.y + MENU_RADIUS + 10
    const aboveTop = center.y - MENU_RADIUS - height - 10
    let top: number
    if (belowTop + height <= vh - VIEWPORT_MARGIN) {
      top = belowTop
    } else if (aboveTop >= VIEWPORT_MARGIN) {
      top = aboveTop
    } else {
      top = Math.max(
        VIEWPORT_MARGIN,
        Math.min(center.y - height / 2, vh - height - VIEWPORT_MARGIN)
      )
    }
    caption.style.left = `${Math.round(left)}px`
    caption.style.top = `${Math.round(top)}px`
  }

  const highlightedEntryName = (): string => {
    if (highlight.kind === 'inner') {
      const slice = innerSlices[highlight.sliceIndex]
      return slice ? sliceLabel(slice) : ''
    }
    if (highlight.kind === 'outer') {
      const cell = outerCells[highlight.cellIndex]
      return cell ? cellLabel(cell) : ''
    }
    if (highlight.kind === 'rating') {
      const cell = outerCells[highlight.cellIndex]
      const stars = '★'.repeat(highlight.rating)
      return cell ? `${cellLabel(cell)} · ${stars}` : stars
    }
    return ''
  }

  const renderCaption = () => {
    caption.textContent = ''
    const targetEl = document.createElement('div')
    targetEl.className = 'caption-target'
    const saved = savedFolderName()
    targetEl.textContent =
      saved === null
        ? `☆ ${opts.unsavedCaption ?? lang.transl('_fs_favPost')}`
        : `★ ${saved}`
    caption.appendChild(targetEl)

    const entryName = highlightedEntryName()
    if (entryName) {
      const entryEl = document.createElement('div')
      entryEl.className = 'caption-entry'
      entryEl.textContent = entryName
      caption.appendChild(entryEl)
    }
    positionCaption()
  }

  const render = () => {
    svg.textContent = ''
    const cx = SVG_HALF
    const cy = SVG_HALF

    for (const slice of innerSlices) {
      const isDisabled = disabled.has(slice.kind)
      const isActive =
        highlight.kind === 'inner' && highlight.sliceIndex === slice.index
      const isExpanded = slice.kind === 'favorite' && expanded

      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute(
        'd',
        sectorPath(
          cx,
          cy,
          DEAD_ZONE,
          INNER_OUTER,
          slice.angle - slice.span / 2,
          slice.angle + slice.span / 2
        )
      )
      const classes = ['slice']
      if (slice.kind === 'remove') classes.push('remove')
      if (isDisabled) classes.push('disabled')
      else if (isActive) classes.push('active')
      else if (isExpanded) classes.push('expanded')
      path.setAttribute('class', classes.join(' '))
      svg.appendChild(path)

      const labelPos = polar(cx, cy, (DEAD_ZONE + INNER_OUTER) / 2, slice.angle)
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', labelPos.x.toFixed(1))
      text.setAttribute('y', labelPos.y.toFixed(1))
      const labelClasses = ['label']
      if (slice.kind === 'remove') labelClasses.push('remove')
      if (slice.kind === 'more') labelClasses.push('action')
      if (isDisabled) labelClasses.push('disabled')
      else if (isActive) labelClasses.push('active')
      text.setAttribute('class', labelClasses.join(' '))
      text.textContent = truncateLabel(sliceLabel(slice), 8)
      svg.appendChild(text)

      // Saved indicator on the favorite slice
      if (slice.kind === 'favorite' && opts.savedFolderId !== null) {
        const dotPos = polar(cx, cy, INNER_OUTER - 9, slice.angle)
        const dot = document.createElementNS(SVG_NS, 'circle')
        dot.setAttribute('cx', dotPos.x.toFixed(1))
        dot.setAttribute('cy', dotPos.y.toFixed(1))
        dot.setAttribute('r', '3.2')
        dot.setAttribute('class', isActive ? 'dot active' : 'dot')
        svg.appendChild(dot)
      }
    }

    const fav = innerSlices.find((s) => s.kind === 'favorite')
    if (expanded && fav) {
      const angles = outerCellAngles(fav.angle, outerCells.length)
      outerCells.forEach((cell, cellIndex) => {
        const cellAngle = angles[cellIndex]
        const isActive =
          highlight.kind === 'outer' && highlight.cellIndex === cellIndex

        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute(
          'd',
          sectorPath(
            cx,
            cy,
            OUTER_INNER,
            OUTER_OUTER,
            cellAngle - CELL_DEG / 2,
            cellAngle + CELL_DEG / 2
          )
        )
        path.setAttribute('class', isActive ? 'slice active' : 'slice')
        svg.appendChild(path)

        const labelPos = polar(
          cx,
          cy,
          (OUTER_INNER + OUTER_OUTER) / 2,
          cellAngle
        )
        const text = document.createElementNS(SVG_NS, 'text')
        text.setAttribute('x', labelPos.x.toFixed(1))
        text.setAttribute('y', labelPos.y.toFixed(1))
        const labelClasses = ['label']
        if (cell.kind !== 'folder') labelClasses.push('action')
        if (isActive) labelClasses.push('active')
        text.setAttribute('class', labelClasses.join(' '))
        text.textContent = truncateLabel(cellLabel(cell), 9)
        svg.appendChild(text)

        if (cell.kind === 'folder' && cell.folderId === opts.savedFolderId) {
          const checkPos = polar(cx, cy, OUTER_OUTER - 10, cellAngle)
          const check = document.createElementNS(SVG_NS, 'text')
          check.setAttribute('x', checkPos.x.toFixed(1))
          check.setAttribute('y', checkPos.y.toFixed(1))
          check.setAttribute('class', isActive ? 'check active' : 'check')
          check.textContent = '✓'
          svg.appendChild(check)
        }
      })
    }

    if (expanded && fav && ratingCell !== null) {
      const cellAngle = outerCellAngles(fav.angle, outerCells.length)[
        ratingCell
      ]
      const angles = ratingCellAngles(cellAngle ?? 0)
      RATINGS.forEach((rating, i) => {
        const a = angles[i]
        const isActive =
          highlight.kind === 'rating' && highlight.rating === rating
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute(
          'd',
          sectorPath(
            cx,
            cy,
            RATING_INNER,
            RATING_OUTER,
            a - RATING_DEG / 2,
            a + RATING_DEG / 2
          )
        )
        const classes = ['slice']
        if (isActive) classes.push('active')
        else if (rating === opts.savedRating) classes.push('rating-current')
        path.setAttribute('class', classes.join(' '))
        svg.appendChild(path)

        const labelPos = polar(cx, cy, (RATING_INNER + RATING_OUTER) / 2, a)
        const text = document.createElementNS(SVG_NS, 'text')
        text.setAttribute('x', labelPos.x.toFixed(1))
        text.setAttribute('y', labelPos.y.toFixed(1))
        text.setAttribute(
          'class',
          isActive ? 'label rating active' : 'label rating'
        )
        // Stars stacked as rows of at most 3 would not fit: show "N★"
        text.textContent = `${rating}★`
        svg.appendChild(text)
      })
    }

    const centerCircle = document.createElementNS(SVG_NS, 'circle')
    centerCircle.setAttribute('cx', String(cx))
    centerCircle.setAttribute('cy', String(cy))
    centerCircle.setAttribute('r', String(DEAD_ZONE))
    centerCircle.setAttribute('class', 'center-circle')
    svg.appendChild(centerCircle)

    renderCaption()
  }

  const enterSticky = () => {
    if (sticky) return
    sticky = true
    backdrop.classList.add('sticky')
  }

  const submitNewFolder = () => {
    if (!newFolderOpen || !newFolderInput) return
    const name = newFolderInput.value
    close()
    opts.onChoose({ kind: 'newFolder', name })
  }

  const openNewFolderInput = () => {
    newFolderOpen = true
    enterSticky()

    const box = document.createElement('div')
    box.className = 'new-folder-box'
    box.lang = lang.htmlLang()

    const title = document.createElement('div')
    title.className = 'new-folder-title'
    title.textContent = lang.transl('_rm_newFolder')

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'new-folder-input'
    input.placeholder = lang.transl('_w_folderNamePlaceholder')

    const actions = document.createElement('div')
    actions.className = 'new-folder-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn'
    cancelBtn.textContent = lang.transl('_w_cancel')
    cancelBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      close()
    })

    const createBtn = document.createElement('button')
    createBtn.type = 'button'
    createBtn.className = 'btn btn-primary'
    createBtn.textContent = lang.transl('_rm_create')
    createBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      submitNewFolder()
    })

    actions.append(cancelBtn, createBtn)
    box.append(title, input, actions)
    shadow.appendChild(box)
    newFolderBox = box
    newFolderInput = input

    const width = 220
    const height = 104
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        center.x - width / 2,
        window.innerWidth - width - VIEWPORT_MARGIN
      )
    )
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        center.y - height / 2,
        window.innerHeight - height - VIEWPORT_MARGIN
      )
    )
    box.style.left = `${Math.round(left)}px`
    box.style.top = `${Math.round(top)}px`
    input.focus()
  }

  const updatePointer = (point: Point) => {
    const result = hitTest(
      { center, innerSlices, outerCells, expanded, disabled, ratingCell },
      point
    )
    const changed =
      result.expanded !== expanded ||
      result.ratingCell !== ratingCell ||
      JSON.stringify(result.highlight) !== JSON.stringify(highlight)
    expanded = result.expanded
    ratingCell = result.ratingCell
    highlight = result.highlight
    if (changed) render()
  }

  /** Choose first, then close: callers may open their own popover */
  const choose = (choice: RadialChoice) => {
    close()
    opts.onChoose(choice)
  }

  const activateHighlight = (fromStickyClick: boolean) => {
    if (highlight.kind === 'inner') {
      const slice = innerSlices[highlight.sliceIndex]
      if (!slice || disabled.has(slice.kind)) {
        close()
        return
      }
      switch (slice.kind) {
        case 'favorite':
          // Released on the slice itself: keep the folder ring open
          if (!fromStickyClick) enterSticky()
          return
        case 'download':
          choose({ kind: 'download' })
          return
        case 'more':
          choose({ kind: 'more' })
          return
        case 'remove':
          choose({ kind: 'remove' })
          return
      }
    }
    if (highlight.kind === 'outer') {
      const cell = outerCells[highlight.cellIndex]
      if (!cell) {
        close()
        return
      }
      if (cell.kind === 'folder') {
        // Released on the folder: saved without changing the rating
        choose({ kind: 'folder', folderId: cell.folderId, label: cell.name })
      } else if (cell.kind === 'more') {
        choose({ kind: 'more' })
      } else {
        openNewFolderInput()
      }
      return
    }
    if (highlight.kind === 'rating') {
      const cell = outerCells[highlight.cellIndex]
      if (cell?.kind === 'folder') {
        choose({
          kind: 'folder',
          folderId: cell.folderId,
          label: cell.name,
          rating: highlight.rating,
        })
        return
      }
    }
    // Center, a gap or outside the menu
    close()
  }

  const onBackdropMove = (ev: PointerEvent) => {
    if (closed || newFolderOpen) return
    moved = true
    updatePointer({ x: ev.clientX, y: ev.clientY })
  }

  const onBackdropClick = (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (closed) return
    if (newFolderOpen) {
      close()
      return
    }
    const pt = { x: ev.clientX, y: ev.clientY }
    const dist = Math.hypot(pt.x - center.x, pt.y - center.y)
    if (dist < DEAD_ZONE || dist > openRadius(expanded, ratingCell)) {
      close()
      return
    }
    moved = true
    updatePointer(pt)
    activateHighlight(true)
  }

  backdrop.addEventListener('pointermove', onBackdropMove)
  backdrop.addEventListener('click', onBackdropClick)

  // While the menu is open the page must not scroll under it
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault()
    ev.stopImmediatePropagation()
  }

  const onKeyBlock = (ev: KeyboardEvent) => {
    ev.stopImmediatePropagation()
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    ev.stopImmediatePropagation()
    if (ev.isComposing || ev.keyCode === 229) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
      return
    }
    if (newFolderOpen && ev.key === 'Enter') {
      ev.preventDefault()
      submitNewFolder()
    }
  }

  const onBlur = () => close()
  const onVisibilityChange = () => {
    if (document.hidden) close()
  }

  const close = () => {
    if (closed) return
    closed = true
    if (activeClose === close) activeClose = null
    window.removeEventListener('wheel', onWheel, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyBlock, true)
    window.removeEventListener('keypress', onKeyBlock, true)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    newFolderBox?.remove()
    host.remove()
    opts.onClose?.()
  }

  activeClose = close

  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyBlock, true)
  window.addEventListener('keypress', onKeyBlock, true)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Outside <body>: htmx body swaps on Pawchive cannot take it away
  document.documentElement.appendChild(host)
  render()

  return {
    move(point) {
      if (closed || newFolderOpen) return
      if (!moved) {
        if (
          Math.hypot(point.x - openPoint.x, point.y - openPoint.y) <
          MOVE_THRESHOLD
        ) {
          return
        }
        moved = true
      }
      updatePointer(point)
    },
    release(point) {
      if (closed || newFolderOpen) return
      if (point === null) {
        close()
        return
      }
      if (!moved) {
        if (
          Math.hypot(point.x - openPoint.x, point.y - openPoint.y) >=
          MOVE_THRESHOLD
        ) {
          moved = true
        } else {
          // Held and released without moving: in the center, so cancel
          close()
          return
        }
      }
      updatePointer(point)
      activateHighlight(false)
    },
    close,
  }
}
