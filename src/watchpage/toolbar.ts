/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* List-view toolbar: search, filter, sort, view mode, selection, refresh, and bulk actions. */

import { lang } from '../Language'
import type { Rating } from '../watch/collectTypes'
import { allTagCounts } from '../watch/tagOps'
import { sortedFolders } from '../watch/watchData'
import type { WatchData, WatchFolder } from '../watch/watchTypes'
import { el, folderLabel } from './dom'
import type { FavSortMode } from './favModel'
import {
  hasActiveLabelFilter,
  toggleFilterRating,
  type LabelFilter,
  type SortMode,
} from './listModel'
import { createStarInput } from './stars'
import { createTagInput } from './tagInput'

export type ViewMode = 'grid' | 'list'
export type ToolbarPopover = null | 'filter' | 'bulkTags' | 'bulkRating'

export interface RefreshState {
  running: boolean
  done: number
  total: number
}

export interface ToolbarCallbacks {
  onSearchChange: (query: string) => void
  onFilterChange: (next: LabelFilter) => void
  onOpenPopoverChange: (next: ToolbarPopover) => void
  onSortChange: (mode: SortMode) => void
  onViewChange: (mode: ViewMode) => void
  onToggleSelect: () => void
  onRefreshStart: () => void
  onRefreshCancel: () => void
  onBulkMove: (folderId: string) => Promise<void>
  onBulkAddTags: (tags: string[]) => Promise<void>
  onBulkRemoveTag: (tag: string) => Promise<void>
  onBulkRating: (rating: Rating | null) => Promise<void>
  onBulkRemove: () => Promise<void>
  onClearSelection: () => void
}

export interface ToolbarRenderParams {
  data: WatchData
  title: string
  query: string
  labelFilter: LabelFilter
  openPopover: ToolbarPopover
  sort: SortMode
  view: ViewMode
  selectMode: boolean
  selectedCount: number
  selectedTags: string[]
  visibleCount: number
  refresh: RefreshState
  callbacks: ToolbarCallbacks
}

export interface FavToolbarCallbacks {
  onSearchChange: (query: string) => void
  onFilterChange: (next: LabelFilter) => void
  onOpenPopoverChange: (next: ToolbarPopover) => void
  onSortChange: (mode: FavSortMode) => void
  onToggleSelect: () => void
  onBulkMove: (folderId: string) => Promise<void>
  onBulkAddTags: (tags: string[]) => Promise<void>
  onBulkRemoveTag: (tag: string) => Promise<void>
  onBulkRating: (rating: Rating | null) => Promise<void>
  onBulkRemove: () => Promise<void>
  onClearSelection: () => void
}

export interface FavToolbarRenderParams {
  kind: 'posts' | 'images'
  folders: WatchFolder[]
  title: string
  query: string
  labelFilter: LabelFilter
  openPopover: ToolbarPopover
  sort: FavSortMode
  selectMode: boolean
  selectedCount: number
  selectedTags: string[]
  callbacks: FavToolbarCallbacks
}

/** One toggle per rating, 1 to 5 stars. None on: show every rating; some
 * on: show only those ratings. */
function createRatingFilter(
  labelFilter: LabelFilter,
  onFilterChange: (next: LabelFilter) => void
): HTMLElement {
  const group = el('div', 'w-segmented w-rating-filter')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', lang.transl('_lb_filterRatings'))
  const picked = new Set(labelFilter.ratings ?? [])
  for (let rating = 1; rating <= 5; rating++) {
    const on = picked.has(rating)
    const btn = el('button', on ? 'w-seg-btn is-active' : 'w-seg-btn')
    btn.type = 'button'
    btn.textContent = `★${rating}`
    const label = lang.transl('_lb_filterRating', String(rating))
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.setAttribute('aria-pressed', String(on))
    btn.addEventListener('click', () => {
      const ratings = toggleFilterRating(labelFilter.ratings, rating)
      onFilterChange({
        tags: [...labelFilter.tags],
        ...(ratings.length > 0 ? { ratings } : {}),
      })
    })
    group.appendChild(btn)
  }
  return group
}

function createFilterControl(
  labelFilter: LabelFilter,
  openPopover: ToolbarPopover,
  onOpenPopoverChange: (next: ToolbarPopover) => void,
  onFilterChange: (next: LabelFilter) => void
): HTMLElement {
  const filterAnchor = el('div', 'w-popover-anchor')
  // Ratings have their own buttons in the toolbar: this one is for tags
  const filterCount = labelFilter.tags.length
  const filterActive = filterCount > 0
  const filterBtn = el(
    'button',
    filterActive || openPopover === 'filter'
      ? 'w-btn w-btn-primary w-filter-btn'
      : 'w-btn w-btn-secondary w-filter-btn'
  )
  filterBtn.type = 'button'
  filterBtn.setAttribute('aria-expanded', String(openPopover === 'filter'))
  filterBtn.textContent =
    filterCount > 0
      ? `${lang.transl('_lb_filter')} (${filterCount})`
      : lang.transl('_lb_filter')
  filterBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onOpenPopoverChange(openPopover === 'filter' ? null : 'filter')
  })
  filterAnchor.appendChild(filterBtn)

  if (openPopover === 'filter') {
    const panel = el('div', 'w-popover w-filter-panel')
    panel.addEventListener('click', (ev) => ev.stopPropagation())

    const tagsSection = el('div', 'w-popover-section')
    tagsSection.appendChild(
      el('div', 'w-popover-label', lang.transl('_lb_filterTags'))
    )
    const tagEntries = allTagCounts()
    if (tagEntries.length === 0) {
      tagsSection.appendChild(
        el('p', 'w-muted w-popover-empty', lang.transl('_lb_noTagsYet'))
      )
    } else {
      const selectedLower = new Set(
        labelFilter.tags.map((t) => t.toLowerCase())
      )
      const chips = el('div', 'w-filter-tag-list')
      for (const entry of tagEntries) {
        const isSel = selectedLower.has(entry.tag.toLowerCase())
        const chip = el(
          'button',
          isSel ? 'w-filter-tag-chip is-selected' : 'w-filter-tag-chip'
        )
        chip.type = 'button'
        chip.setAttribute('aria-pressed', String(isSel))
        chip.appendChild(el('span', undefined, entry.tag))
        chip.appendChild(el('span', 'w-filter-tag-count', String(entry.count)))
        chip.addEventListener('click', () => {
          const lower = entry.tag.toLowerCase()
          const nextTags = isSel
            ? labelFilter.tags.filter((t) => t.toLowerCase() !== lower)
            : [...labelFilter.tags, entry.tag]
          onFilterChange({
            tags: nextTags,
            ratings: labelFilter.ratings,
          })
        })
        chips.appendChild(chip)
      }
      tagsSection.appendChild(chips)
    }
    panel.appendChild(tagsSection)

    filterAnchor.appendChild(panel)
  }

  return filterAnchor
}

function createActiveFiltersBar(
  labelFilter: LabelFilter,
  onFilterChange: (next: LabelFilter) => void
): HTMLElement {
  const bar = el('div', 'w-active-filters')

  for (const tag of labelFilter.tags) {
    const chip = el('span', 'w-active-filter-chip')
    chip.appendChild(el('span', undefined, tag))
    const rm = el('button', 'w-tag-chip-rm', '×')
    rm.type = 'button'
    rm.setAttribute('aria-label', lang.transl('_lb_removeTag', tag))
    rm.addEventListener('click', () => {
      const lower = tag.toLowerCase()
      onFilterChange({
        tags: labelFilter.tags.filter((t) => t.toLowerCase() !== lower),
        ratings: labelFilter.ratings,
      })
    })
    chip.appendChild(rm)
    bar.appendChild(chip)
  }

  const clearFiltersBtn = el(
    'button',
    'w-btn w-btn-secondary w-btn-xs',
    lang.transl('_lb_clearFilters')
  )
  clearFiltersBtn.type = 'button'
  clearFiltersBtn.addEventListener('click', () => {
    onFilterChange({ tags: [] })
  })
  bar.appendChild(clearFiltersBtn)

  return bar
}

interface BulkBarParams {
  folders: WatchFolder[]
  openPopover: ToolbarPopover
  selectedCount: number
  selectedTags: string[]
  removeConfirmText: string
  onOpenPopoverChange: (next: ToolbarPopover) => void
  onBulkMove: (folderId: string) => Promise<void>
  onBulkAddTags: (tags: string[]) => Promise<void>
  onBulkRemoveTag: (tag: string) => Promise<void>
  onBulkRating: (rating: Rating | null) => Promise<void>
  onBulkRemove: () => Promise<void>
  onClearSelection: () => void
}

function createBulkActionBar(params: BulkBarParams): HTMLElement {
  const {
    folders,
    openPopover,
    selectedCount,
    selectedTags,
    removeConfirmText,
    onOpenPopoverChange,
    onBulkMove,
    onBulkAddTags,
    onBulkRemoveTag,
    onBulkRating,
    onBulkRemove,
    onClearSelection,
  } = params

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

  for (const folder of sortedFolders({ folders })) {
    const opt = el('option', undefined, folderLabel(folder))
    opt.value = folder.id
    moveSelect.appendChild(opt)
  }
  moveSelect.addEventListener('change', () => {
    const target = moveSelect.value
    if (target) {
      void onBulkMove(target)
    }
  })
  bulk.appendChild(moveSelect)

  // Bulk Tags popover
  const tagsAnchor = el('div', 'w-popover-anchor')
  const bulkTagsBtn = el(
    'button',
    openPopover === 'bulkTags'
      ? 'w-btn w-btn-primary'
      : 'w-btn w-btn-secondary',
    lang.transl('_lb_bulkTags')
  )
  bulkTagsBtn.type = 'button'
  bulkTagsBtn.setAttribute('aria-expanded', String(openPopover === 'bulkTags'))
  bulkTagsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onOpenPopoverChange(openPopover === 'bulkTags' ? null : 'bulkTags')
  })
  tagsAnchor.appendChild(bulkTagsBtn)

  if (openPopover === 'bulkTags') {
    const pop = el('div', 'w-popover w-bulk-popover')
    pop.addEventListener('click', (ev) => ev.stopPropagation())

    const addSec = el('div', 'w-popover-section')
    addSec.appendChild(
      el('div', 'w-popover-label', lang.transl('_lb_bulkAddTags'))
    )
    let pendingTags: string[] = []
    const applyBtn = el(
      'button',
      'w-btn w-btn-primary w-btn-xs',
      lang.transl('_lb_apply')
    )
    applyBtn.type = 'button'
    applyBtn.disabled = true

    const tagInput = createTagInput({
      tags: [],
      onChange: (next) => {
        pendingTags = next
        applyBtn.disabled = next.length === 0
      },
    })
    addSec.appendChild(tagInput.element)

    const addActions = el('div', 'w-popover-actions')
    applyBtn.addEventListener('click', () => {
      if (pendingTags.length > 0) {
        void onBulkAddTags(pendingTags)
      }
    })
    addActions.appendChild(applyBtn)
    addSec.appendChild(addActions)
    pop.appendChild(addSec)

    if (selectedTags.length > 0) {
      const rmSec = el('div', 'w-popover-section')
      rmSec.appendChild(
        el('div', 'w-popover-label', lang.transl('_lb_bulkRemoveTags'))
      )
      const rmList = el('div', 'w-tag-chips')
      for (const tag of selectedTags) {
        const chip = el('span', 'w-tag-chip w-tag-chip-edit')
        chip.appendChild(el('span', 'w-tag-chip-text', tag))
        const rm = el('button', 'w-tag-chip-rm', '×')
        rm.type = 'button'
        rm.setAttribute('aria-label', lang.transl('_lb_removeTag', tag))
        rm.addEventListener('click', () => {
          void onBulkRemoveTag(tag)
        })
        chip.appendChild(rm)
        rmList.appendChild(chip)
      }
      rmSec.appendChild(rmList)
      pop.appendChild(rmSec)
    }

    tagsAnchor.appendChild(pop)
  }
  bulk.appendChild(tagsAnchor)

  // Bulk Rating popover
  const ratingAnchor = el('div', 'w-popover-anchor')
  const bulkRatingBtn = el(
    'button',
    openPopover === 'bulkRating'
      ? 'w-btn w-btn-primary'
      : 'w-btn w-btn-secondary',
    lang.transl('_lb_bulkRating')
  )
  bulkRatingBtn.type = 'button'
  bulkRatingBtn.setAttribute(
    'aria-expanded',
    String(openPopover === 'bulkRating')
  )
  bulkRatingBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onOpenPopoverChange(openPopover === 'bulkRating' ? null : 'bulkRating')
  })
  ratingAnchor.appendChild(bulkRatingBtn)

  if (openPopover === 'bulkRating') {
    const pop = el('div', 'w-popover w-bulk-popover w-bulk-rating-popover')
    pop.addEventListener('click', (ev) => ev.stopPropagation())

    const stars = createStarInput({
      value: undefined,
      onChange: (rating) => {
        if (rating !== null) {
          void onBulkRating(rating)
        }
      },
    })
    pop.appendChild(stars.element)

    const clearRatingBtn = el(
      'button',
      'w-btn w-btn-secondary w-btn-xs',
      lang.transl('_lb_clearRating')
    )
    clearRatingBtn.type = 'button'
    clearRatingBtn.addEventListener('click', () => {
      void onBulkRating(null)
    })
    pop.appendChild(clearRatingBtn)

    ratingAnchor.appendChild(pop)
  }
  bulk.appendChild(ratingAnchor)

  const removeBtn = el(
    'button',
    'w-btn w-btn-danger',
    lang.transl('_w_removeSelected')
  )
  removeBtn.type = 'button'
  removeBtn.addEventListener('click', () => {
    const ok = window.confirm(removeConfirmText)
    if (ok) {
      void onBulkRemove()
    }
  })
  bulk.appendChild(removeBtn)

  const clearBtn = el(
    'button',
    'w-btn w-btn-secondary',
    lang.transl('_w_clearSelection')
  )
  clearBtn.type = 'button'
  clearBtn.addEventListener('click', () => onClearSelection())
  bulk.appendChild(clearBtn)

  return bulk
}

export function renderToolbar(
  root: HTMLElement,
  params: ToolbarRenderParams
): void {
  const {
    data,
    title,
    query,
    labelFilter,
    openPopover,
    sort,
    view,
    selectMode,
    selectedCount,
    selectedTags,
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

  // Filter popover trigger + panel
  controls.appendChild(
    createFilterControl(
      labelFilter,
      openPopover,
      callbacks.onOpenPopoverChange,
      callbacks.onFilterChange
    )
  )
  controls.appendChild(
    createRatingFilter(labelFilter, callbacks.onFilterChange)
  )

  // Sort select
  const sortSelect = el('select', 'w-select')
  sortSelect.setAttribute('aria-label', lang.transl('_w_sortLabel'))
  const sortOptions: { value: SortMode; label: string }[] = [
    { value: 'name', label: lang.transl('_w_sortName') },
    { value: 'added', label: lang.transl('_w_sortAdded') },
    { value: 'latest', label: lang.transl('_w_sortLatest') },
    { value: 'unread', label: lang.transl('_wt_sortUnread') },
    { value: 'rating', label: lang.transl('_lb_sortRating') },
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

  if (hasActiveLabelFilter(labelFilter)) {
    root.appendChild(
      createActiveFiltersBar(labelFilter, callbacks.onFilterChange)
    )
  }

  if (selectedCount > 0) {
    root.appendChild(
      createBulkActionBar({
        folders: data.folders,
        openPopover,
        selectedCount,
        selectedTags,
        removeConfirmText: lang.transl(
          '_w_removeSelectedConfirm',
          String(selectedCount)
        ),
        onOpenPopoverChange: callbacks.onOpenPopoverChange,
        onBulkMove: callbacks.onBulkMove,
        onBulkAddTags: callbacks.onBulkAddTags,
        onBulkRemoveTag: callbacks.onBulkRemoveTag,
        onBulkRating: callbacks.onBulkRating,
        onBulkRemove: callbacks.onBulkRemove,
        onClearSelection: callbacks.onClearSelection,
      })
    )
  }

  if (wasSearchFocused) {
    search.focus()
    if (selStart !== null && selEnd !== null) {
      search.setSelectionRange(selStart, selEnd)
    }
  }
}

export function renderFavToolbar(
  root: HTMLElement,
  params: FavToolbarRenderParams
): void {
  const {
    kind,
    folders,
    title,
    query,
    labelFilter,
    openPopover,
    sort,
    selectMode,
    selectedCount,
    selectedTags,
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
  topRow.appendChild(el('h1', 'w-view-title', title))

  const controls = el('div', 'w-toolbar-controls')

  const placeholderText =
    kind === 'posts'
      ? lang.transl('_fv_searchPostsPlaceholder')
      : lang.transl('_fv_searchImagesPlaceholder')

  const search = el('input', 'w-search-input')
  search.type = 'search'
  search.dataset.role = 'search'
  search.value = query
  search.placeholder = placeholderText
  search.setAttribute('aria-label', placeholderText)
  search.addEventListener('input', () => {
    callbacks.onSearchChange(search.value)
  })
  controls.appendChild(search)

  controls.appendChild(
    createFilterControl(
      labelFilter,
      openPopover,
      callbacks.onOpenPopoverChange,
      callbacks.onFilterChange
    )
  )
  controls.appendChild(
    createRatingFilter(labelFilter, callbacks.onFilterChange)
  )

  const sortSelect = el('select', 'w-select')
  sortSelect.setAttribute('aria-label', lang.transl('_w_sortLabel'))
  const sortOptions: { value: FavSortMode; label: string }[] =
    kind === 'posts'
      ? [
          { value: 'added', label: lang.transl('_w_sortAdded') },
          { value: 'published', label: lang.transl('_fv_sortPublished') },
          { value: 'title', label: lang.transl('_fv_sortTitle') },
          { value: 'rating', label: lang.transl('_lb_sortRating') },
        ]
      : [
          { value: 'added', label: lang.transl('_w_sortAdded') },
          { value: 'title', label: lang.transl('_fv_sortTitle') },
          { value: 'rating', label: lang.transl('_lb_sortRating') },
        ]
  const effectiveSort: FavSortMode =
    kind === 'images' && sort === 'published' ? 'added' : sort
  for (const opt of sortOptions) {
    const o = el('option', undefined, opt.label)
    o.value = opt.value
    o.selected = opt.value === effectiveSort
    sortSelect.appendChild(o)
  }
  sortSelect.addEventListener('change', () => {
    callbacks.onSortChange(sortSelect.value as FavSortMode)
  })
  controls.appendChild(sortSelect)

  const selectBtn = el(
    'button',
    selectMode ? 'w-btn w-btn-primary' : 'w-btn w-btn-secondary',
    selectMode ? lang.transl('_w_selectDone') : lang.transl('_w_select')
  )
  selectBtn.type = 'button'
  selectBtn.setAttribute('aria-pressed', String(selectMode))
  selectBtn.addEventListener('click', () => callbacks.onToggleSelect())
  controls.appendChild(selectBtn)

  topRow.appendChild(controls)
  root.appendChild(topRow)

  if (hasActiveLabelFilter(labelFilter)) {
    root.appendChild(
      createActiveFiltersBar(labelFilter, callbacks.onFilterChange)
    )
  }

  if (selectedCount > 0) {
    root.appendChild(
      createBulkActionBar({
        folders,
        openPopover,
        selectedCount,
        selectedTags,
        removeConfirmText: lang.transl(
          '_fv_removeSelectedConfirm',
          String(selectedCount)
        ),
        onOpenPopoverChange: callbacks.onOpenPopoverChange,
        onBulkMove: callbacks.onBulkMove,
        onBulkAddTags: callbacks.onBulkAddTags,
        onBulkRemoveTag: callbacks.onBulkRemoveTag,
        onBulkRating: callbacks.onBulkRating,
        onBulkRemove: callbacks.onBulkRemove,
        onClearSelection: callbacks.onClearSelection,
      })
    )
  }

  if (wasSearchFocused) {
    search.focus()
    if (selStart !== null && selEnd !== null) {
      search.setSelectionRange(selStart, selEnd)
    }
  }
}
