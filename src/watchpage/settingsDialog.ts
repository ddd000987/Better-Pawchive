/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Watch page settings dialog (the ⚙ in the sidebar): hover previews,
 * tracking, display and data (export / import). The site menu's settings
 * center keeps the site's own settings; the watchlist's live here. */

import { lang } from '../Language'
import type { LangTextKey } from '../localeTypes'
import { settings, type SettingKey } from '../setting/Settings'
import { totalUnread } from '../watch/watchData'
import { watchStore } from '../watch/watchStore'
import { el } from './dom'
import { trapFocus } from './favEditor'
import type { ViewMode } from './toolbar'

export interface SettingsDialogOptions {
  view: ViewMode
  onViewChange: (mode: ViewMode) => void
  onExport: () => void
  onImport: () => void
  onClose: () => void
}

export interface SettingsDialogHandle {
  destroy: () => void
}

type BoolKey = Extract<
  SettingKey,
  | 'watchPreviewPosts'
  | 'watchPreviewImages'
  | 'watchPreviewOriginal'
  | 'watchScanEnabled'
  | 'watchNotice'
>

type NumberKey = Extract<
  SettingKey,
  'watchPreviewWait' | 'watchScanIntervalHours'
>

function group(body: HTMLElement, titleKey: LangTextKey): HTMLElement {
  const sec = el('section', 'w-set-group')
  sec.appendChild(el('h3', 'w-set-group-title', lang.transl(titleKey)))
  body.appendChild(sec)
  return sec
}

/** Label text with the setting's explanation under it */
function labelBlock(labelKey: LangTextKey, descKey?: LangTextKey): HTMLElement {
  const wrap = el('span', 'w-set-text')
  wrap.appendChild(el('span', 'w-set-label', lang.transl(labelKey)))
  if (descKey) wrap.appendChild(el('span', 'w-set-desc', lang.transl(descKey)))
  return wrap
}

function checkRow(
  host: HTMLElement,
  key: BoolKey,
  labelKey: LangTextKey,
  onChange?: () => void
): HTMLInputElement {
  const row = el('label', 'w-set-row')
  const box = el('input', 'w-set-check')
  box.type = 'checkbox'
  box.checked = settings.get(key)
  box.addEventListener('change', () => {
    settings.set(key, box.checked)
    onChange?.()
  })
  row.append(box, labelBlock(labelKey, `_d_${key}` as LangTextKey))
  host.appendChild(row)
  return box
}

function numberRow(
  host: HTMLElement,
  key: NumberKey,
  labelKey: LangTextKey,
  attrs: { min: string; max: string; step: string }
): HTMLInputElement {
  const row = el('label', 'w-set-row w-set-row-field')
  const input = el('input', 'w-input w-set-number')
  input.type = 'number'
  input.min = attrs.min
  input.max = attrs.max
  input.step = attrs.step
  input.value = String(settings.get(key))
  input.addEventListener('change', () => {
    settings.set(key, Number(input.value))
    // Show the cleaned value (out of range is clamped, NaN falls back)
    input.value = String(settings.get(key))
  })
  row.append(labelBlock(labelKey, `_d_${key}` as LangTextKey), input)
  host.appendChild(row)
  return input
}

export function openSettingsDialog(
  opts: SettingsDialogOptions
): SettingsDialogHandle {
  const prevFocus = document.activeElement as HTMLElement | null

  const backdrop = el('div', 'w-modal-backdrop')
  const modal = el('div', 'w-modal w-set-modal')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-label', lang.transl('_wset_title'))

  const header = el('div', 'w-modal-header')
  header.appendChild(el('h2', 'w-modal-title', lang.transl('_wset_title')))
  const closeBtn = el('button', 'w-icon-btn', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', lang.transl('_fv_close'))
  closeBtn.title = lang.transl('_fv_close')
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const body = el('div', 'w-modal-body w-set-body')

  // Hover previews
  const preview = group(body, '_wset_secPreview')
  checkRow(preview, 'watchPreviewPosts', '_wset_previewPosts')
  checkRow(preview, 'watchPreviewImages', '_wset_previewImages')
  checkRow(preview, 'watchPreviewOriginal', '_wset_previewOriginal')
  numberRow(preview, 'watchPreviewWait', '_wset_previewWait', {
    min: '0',
    max: '2000',
    step: '50',
  })

  // Tracking
  const tracking = group(body, '_wt_secTracking')
  const data = watchStore.data
  const tracked = Object.values(data.creators).filter(
    (c) => c.tracking?.enabled
  ).length
  tracking.appendChild(
    el(
      'p',
      'w-set-summary',
      lang.transl(
        '_wt_trackingSummary',
        String(tracked),
        String(totalUnread(data))
      )
    )
  )
  checkRow(tracking, 'watchScanEnabled', '_wt_scanEnabled')
  numberRow(tracking, 'watchScanIntervalHours', '_wt_scanIntervalHours', {
    min: '1',
    max: '168',
    step: '1',
  })
  checkRow(tracking, 'watchNotice', '_wt_noticeEnabled')

  // Display
  const display = group(body, '_wset_secDisplay')
  const viewRow = el('label', 'w-set-row w-set-row-field')
  const viewSelect = el('select', 'w-select')
  for (const [mode, key] of [
    ['grid', '_w_viewGrid'],
    ['list', '_w_viewList'],
  ] as const) {
    const opt = el('option', undefined, lang.transl(key))
    opt.value = mode
    opt.selected = opts.view === mode
    viewSelect.appendChild(opt)
  }
  viewSelect.addEventListener('change', () => {
    opts.onViewChange(viewSelect.value === 'list' ? 'list' : 'grid')
  })
  viewRow.append(labelBlock('_wset_view', '_wset_viewDesc'), viewSelect)
  display.appendChild(viewRow)

  // Data
  const dataGroup = group(body, '_wset_secData')
  dataGroup.appendChild(
    el('p', 'w-set-desc w-set-desc-block', lang.transl('_wset_dataDesc'))
  )
  const dataBtns = el('div', 'w-set-actions')
  const exportBtn = el('button', 'w-btn', lang.transl('_w_export'))
  exportBtn.type = 'button'
  exportBtn.addEventListener('click', () => opts.onExport())
  const importBtn = el('button', 'w-btn', lang.transl('_w_import'))
  importBtn.type = 'button'
  importBtn.addEventListener('click', () => {
    close(true)
    opts.onImport()
  })
  dataBtns.append(exportBtn, importBtn)
  dataGroup.appendChild(dataBtns)

  modal.appendChild(body)
  backdrop.appendChild(modal)

  let closed = false
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      // An open <select> uses Esc to close its own list
      if ((ev.target as HTMLElement | null)?.tagName === 'SELECT') return
      ev.preventDefault()
      close(true)
      return
    }
    trapFocus(modal, ev)
  }
  const close = (notify: boolean): void => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeyDown)
    backdrop.remove()
    if (prevFocus && prevFocus.isConnected) prevFocus.focus()
    if (notify) opts.onClose()
  }

  closeBtn.addEventListener('click', () => close(true))
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close(true)
  })
  document.addEventListener('keydown', onKeyDown)
  document.body.appendChild(backdrop)
  closeBtn.focus()

  return { destroy: () => close(false) }
}
