/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* List-view toolbar: search, sort, view mode, selection, refresh, and bulk actions. */

import { lang } from '../Language'
import { sortedFolders } from '../watch/watchData'
import type { WatchData } from '../watch/watchTypes'
import { el, folderLabel } from './dom'
import type { SortMode } from './listModel'

export type ViewMode = 'grid' | 'list'

export interface RefreshState {
  running: boolean
  done: number
  total: number
}

export interface ToolbarCallbacks {
  onSearchChange: (query: string) => void
  onSortChange: (mode: SortMode) => void
  onViewChange: (mode: ViewMode) => void
  onToggleSelect: () => void
  onRefreshStart: () => void
  onRefreshCancel: () => void
  onBulkMove: (folderId: string) => Promise<void>
  onBulkRemove: () => Promise<void>
  onClearSelection: () => void
}

export interface ToolbarRenderParams {
  data: WatchData
  title: string
  query: string
  sort: SortMode
  view: ViewMode
  selectMode: boolean
  selectedCount: number
  visibleCount: number
  refresh: RefreshState
  callbacks: ToolbarCallbacks
}

export function renderToolbar(
  root: HTMLElement,
  params: ToolbarRenderParams
): void {
  const {
    data,
    title,
    query,
    sort,
    view,
    selectMode,
    selectedCount,
    visibleCount,
    refresh,
    callbacks,
  } = params

  const activeEl = document.activeElement
  const wasSearchFocused =
    activeEl instanceof HTMLInputElement && activeEl.dataset.role === 'search'
  const selStart = wasSearchFocused ? activeEl.selectionStart : null
  const selEnd = wasSearchFocused ? activeEl.selectionEnd : null

  root.replaceChildren()
  root.className = 'w-toolbar-wrap'

  const topRow = el('div', 'w-toolbar')

  const heading = el('h1', 'w-view-title', title)
  topRow.appendChild(heading)

  const controls = el('div', 'w-toolbar-controls')

  // Search input
  const search = el('input', 'w-search-input')
  search.type = 'search'
  search.dataset.role = 'search'
  search.value = query
  search.placeholder = lang.transl('_w_searchPlaceholder')
  search.setAttribute('aria-label', lang.transl('_w_searchPlaceholder'))
  search.addEventListener('input', () => {
    callbacks.onSearchChange(search.value)
  })
  controls.appendChild(search)

  // Sort select
  const sortSelect = el('select', 'w-select')
  sortSelect.setAttribute('aria-label', lang.transl('_w_sortLabel'))
  const sortOptions: { value: SortMode; label: string }[] = [
    { value: 'name', label: lang.transl('_w_sortName') },
    { value: 'added', label: lang.transl('_w_sortAdded') },
    { value: 'latest', label: lang.transl('_w_sortLatest') },
    { value: 'unread', label: lang.transl('_wt_sortUnread') },
  ]
  for (const opt of sortOptions) {
    const o = el('option', undefined, opt.label)
    o.value = opt.value
    o.selected = opt.value === sort
    sortSelect.appendChild(o)
  }
  sortSelect.addEventListener('change', () => {
    callbacks.onSortChange(sortSelect.value as SortMode)
  })
  controls.appendChild(sortSelect)

  // View toggle (grid / list)
  const viewGroup = el('div', 'w-segmented')
  const gridBtn = el(
    'button',
    view === 'grid' ? 'w-seg-btn is-active' : 'w-seg-btn'
  )
  gridBtn.type = 'button'
  gridBtn.textContent = '⊞'
  gridBtn.setAttribute('aria-label', lang.transl('_w_viewGrid'))
  gridBtn.setAttribute('aria-pressed', String(view === 'grid'))
  gridBtn.title = lang.transl('_w_viewGrid')
  gridBtn.addEventListener('click', () => callbacks.onViewChange('grid'))

  const listBtn = el(
    'button',
    view === 'list' ? 'w-seg-btn is-active' : 'w-seg-btn'
  )
  listBtn.type = 'button'
  listBtn.textContent = '☰'
  listBtn.setAttribute('aria-label', lang.transl('_w_viewList'))
  listBtn.setAttribute('aria-pressed', String(view === 'list'))
  listBtn.title = lang.transl('_w_viewList')
  listBtn.addEventListener('click', () => callbacks.onViewChange('list'))

  viewGroup.appendChild(gridBtn)
  viewGroup.appendChild(listBtn)
  controls.appendChild(viewGroup)

  // Select mode toggle
  const selectBtn = el(
    'button',
    selectMode ? 'w-btn w-btn-primary' : 'w-btn w-btn-secondary',
    selectMode ? lang.transl('_w_selectDone') : lang.transl('_w_select')
  )
  selectBtn.type = 'button'
  selectBtn.setAttribute('aria-pressed', String(selectMode))
  selectBtn.addEventListener('click', () => callbacks.onToggleSelect())
  controls.appendChild(selectBtn)

  // Refresh / progress + cancel
  if (refresh.running) {
    const prog = el(
      'span',
      'w-refresh-progress',
      lang.transl(
        '_w_refreshProgress',
        String(refresh.done),
        String(refresh.total)
      )
    )
    prog.setAttribute('role', 'status')
    controls.appendChild(prog)

    const cancelBtn = el(
      'button',
      'w-btn w-btn-danger',
      lang.transl('_w_cancel')
    )
    cancelBtn.type = 'button'
    cancelBtn.addEventListener('click', () => callbacks.onRefreshCancel())
    controls.appendChild(cancelBtn)
  } else {
    const refreshBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_wt_checkUpdates')
    )
    refreshBtn.type = 'button'
    refreshBtn.disabled = visibleCount === 0
    refreshBtn.addEventListener('click', () => callbacks.onRefreshStart())
    controls.appendChild(refreshBtn)
  }

  topRow.appendChild(controls)
  root.appendChild(topRow)

  // Bulk action bar
  if (selectedCount > 0) {
    const bulk = el('div', 'w-bulk-bar')
    bulk.appendChild(
      el(
        'span',
        'w-bulk-count',
        lang.transl('_w_selectedCount', String(selectedCount))
      )
    )

    const moveSelect = el('select', 'w-select')
    moveSelect.setAttribute('aria-label', lang.transl('_w_moveTo'))
    const placeholder = el('option', undefined, lang.transl('_w_moveTo'))
    placeholder.value = ''
    placeholder.selected = true
    placeholder.disabled = true
    moveSelect.appendChild(placeholder)

    for (const folder of sortedFolders(data)) {
      const opt = el('option', undefined, folderLabel(folder))
      opt.value = folder.id
      moveSelect.appendChild(opt)
    }
    moveSelect.addEventListener('change', () => {
      const target = moveSelect.value
      if (target) {
        void callbacks.onBulkMove(target)
      }
    })
    bulk.appendChild(moveSelect)

    const removeBtn = el(
      'button',
      'w-btn w-btn-danger',
      lang.transl('_w_removeSelected')
    )
    removeBtn.type = 'button'
    removeBtn.addEventListener('click', () => {
      const ok = window.confirm(
        lang.transl('_w_removeSelectedConfirm', String(selectedCount))
      )
      if (ok) {
        void callbacks.onBulkRemove()
      }
    })
    bulk.appendChild(removeBtn)

    const clearBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_w_clearSelection')
    )
    clearBtn.type = 'button'
    clearBtn.addEventListener('click', () => callbacks.onClearSelection())
    bulk.appendChild(clearBtn)

    root.appendChild(bulk)
  }

  if (wasSearchFocused) {
    search.focus()
    if (selStart !== null && selEnd !== null) {
      search.setSelectionRange(selStart, selEnd)
    }
  }
}
