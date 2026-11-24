/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Left sidebar with folder navigation, inline CRUD, drag-and-drop, and export/import. */

import { lang } from '../Language'
import {
  creatorsInFolder,
  sortedFolders,
  totalUnread,
} from '../watch/watchData'
import {
  UNSORTED_FOLDER_ID,
  type WatchData,
  type WatchFolder,
} from '../watch/watchTypes'
import { MIME_CREATOR, MIME_FOLDER, el, folderLabel } from './dom'
import type { WatchRoute } from './listModel'

export interface SidebarCallbacks {
  onNavigate: (hash: string) => void
  onCreateFolder: (name: string) => Promise<void>
  onRenameFolder: (id: string, name: string) => Promise<void>
  onDeleteFolder: (folder: WatchFolder) => Promise<void>
  onReorderFolders: (ids: string[]) => Promise<void>
  onDropCreators: (draggedKey: string, folderId: string) => Promise<void>
  onExport: () => void
  onImport: () => void
  onToggleMobileMenu: () => void
}

export interface SidebarRenderParams {
  data: WatchData
  route: WatchRoute
  mobileOpen: boolean
  callbacks: SidebarCallbacks
}

export function renderSidebar(
  root: HTMLElement,
  params: SidebarRenderParams
): void {
  const { data, route, mobileOpen, callbacks } = params
  const folders = sortedFolders(data)
  const allCreators = Object.values(data.creators)
  const totalCount = allCreators.length
  const trackedCount = allCreators.filter((c) => c.tracking?.enabled).length
  const updatesCount = allCreators.filter(
    (c) => c.tracking?.enabled && c.tracking.unread.length > 0
  ).length
  const unreadTotal = totalUnread(data)

  root.replaceChildren()
  root.className = mobileOpen ? 'w-sidebar is-open' : 'w-sidebar'

  // Brand + mobile toggle
  const header = el('div', 'w-sidebar-header')
  const brand = el('div', 'w-brand')
  brand.appendChild(el('div', 'w-brand-title', 'PawchivePro'))
  brand.appendChild(el('div', 'w-brand-sub', lang.transl('_w_subtitle')))
  header.appendChild(brand)

  const toggleBtn = el('button', 'w-mobile-toggle')
  toggleBtn.type = 'button'
  toggleBtn.setAttribute('aria-expanded', String(mobileOpen))
  toggleBtn.setAttribute('aria-label', lang.transl('_w_menuToggle'))
  toggleBtn.textContent = mobileOpen ? '✕' : '☰'
  toggleBtn.addEventListener('click', () => callbacks.onToggleMobileMenu())
  header.appendChild(toggleBtn)
  root.appendChild(header)

  // Collapsible body
  const body = el('div', 'w-sidebar-body')

  const nav = el('nav', 'w-nav')
  nav.setAttribute('aria-label', lang.transl('_w_subtitle'))

  // All creators
  const allBtn = el(
    'button',
    route.view === 'all' ? 'w-nav-item is-active' : 'w-nav-item'
  )
  allBtn.type = 'button'
  allBtn.appendChild(el('span', 'w-nav-label', lang.transl('_w_allCreators')))
  allBtn.appendChild(el('span', 'w-nav-count', String(totalCount)))
  allBtn.addEventListener('click', () => callbacks.onNavigate('#/all'))
  nav.appendChild(allBtn)

  // Updates (creators with unread + total unread badge)
  const updatesBtn = el(
    'button',
    route.view === 'updates' ? 'w-nav-item is-active' : 'w-nav-item'
  )
  updatesBtn.type = 'button'
  updatesBtn.appendChild(el('span', 'w-nav-label', lang.transl('_wt_updates')))
  const updatesRight = el('span', 'w-nav-right')
  if (unreadTotal > 0) {
    updatesRight.appendChild(
      el(
        'span',
        'w-nav-badge',
        unreadTotal > 999 ? '999+' : String(unreadTotal)
      )
    )
  }
  updatesRight.appendChild(el('span', 'w-nav-count', String(updatesCount)))
  updatesBtn.appendChild(updatesRight)
  updatesBtn.addEventListener('click', () => callbacks.onNavigate('#/updates'))
  nav.appendChild(updatesBtn)

  // Tracking
  const trackingBtn = el(
    'button',
    route.view === 'tracking' ? 'w-nav-item is-active' : 'w-nav-item'
  )
  trackingBtn.type = 'button'
  trackingBtn.appendChild(
    el('span', 'w-nav-label', lang.transl('_wt_trackingList'))
  )
  trackingBtn.appendChild(el('span', 'w-nav-count', String(trackedCount)))
  trackingBtn.addEventListener('click', () =>
    callbacks.onNavigate('#/tracking')
  )
  nav.appendChild(trackingBtn)

  // New posts feed
  const feedBtn = el(
    'button',
    route.view === 'feed' ? 'w-nav-item is-active' : 'w-nav-item'
  )
  feedBtn.type = 'button'
  feedBtn.appendChild(el('span', 'w-nav-label', lang.transl('_wt_feed')))
  feedBtn.addEventListener('click', () => callbacks.onNavigate('#/feed'))
  nav.appendChild(feedBtn)

  nav.appendChild(el('div', 'w-nav-sep'))

  // Folder list
  const list = el('div', 'w-folder-list')
  let draggingFolderId: string | null = null

  for (const folder of folders) {
    const isUnsorted = folder.id === UNSORTED_FOLDER_ID
    const isActive = route.view === 'folder' && route.folderId === folder.id
    const count = creatorsInFolder(data, folder.id).length

    const row = el('div', isActive ? 'w-folder-row is-active' : 'w-folder-row')
    row.dataset.folderId = folder.id

    if (!isUnsorted) {
      row.draggable = true
      row.addEventListener('dragstart', (ev) => {
        draggingFolderId = folder.id
        row.classList.add('is-dragging')
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move'
          ev.dataTransfer.setData(MIME_FOLDER, folder.id)
        }
      })
      row.addEventListener('dragend', () => {
        draggingFolderId = null
        row.classList.remove('is-dragging')
        for (const elRow of list.querySelectorAll('.drop-target')) {
          elRow.classList.remove('drop-target')
        }
      })
    }

    // Drag-over & drop: supports creator drop (all folders) and folder reorder (non-unsorted)
    row.addEventListener('dragover', (ev) => {
      const types = ev.dataTransfer?.types
      if (!types) return
      const isCreator = types.includes(MIME_CREATOR)
      const isFolder =
        !isUnsorted &&
        types.includes(MIME_FOLDER) &&
        draggingFolderId !== folder.id
      if (isCreator || isFolder) {
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
        row.classList.add('drop-target')
      }
    })

    row.addEventListener('dragleave', (ev) => {
      if (!row.contains(ev.relatedTarget as Node | null)) {
        row.classList.remove('drop-target')
      }
    })

    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      row.classList.remove('drop-target')
      const creatorKey = ev.dataTransfer?.getData(MIME_CREATOR)
      if (creatorKey) {
        void callbacks.onDropCreators(creatorKey, folder.id)
        return
      }
      const sourceFolderId = ev.dataTransfer?.getData(MIME_FOLDER)
      if (sourceFolderId && !isUnsorted && sourceFolderId !== folder.id) {
        const ids = folders
          .filter((f) => f.id !== UNSORTED_FOLDER_ID)
          .map((f) => f.id)
        const fromIdx = ids.indexOf(sourceFolderId)
        const toIdx = ids.indexOf(folder.id)
        if (fromIdx !== -1 && toIdx !== -1) {
          ids.splice(fromIdx, 1)
          ids.splice(toIdx, 0, sourceFolderId)
          void callbacks.onReorderFolders([UNSORTED_FOLDER_ID, ...ids])
        }
      }
    })

    const mainBtn = el('button', 'w-folder-btn')
    mainBtn.type = 'button'
    mainBtn.appendChild(el('span', 'w-nav-label', folderLabel(folder)))
    mainBtn.appendChild(el('span', 'w-nav-count', String(count)))
    mainBtn.addEventListener('click', () => {
      callbacks.onNavigate(`#/folder/${encodeURIComponent(folder.id)}`)
    })
    row.appendChild(mainBtn)

    if (!isUnsorted) {
      const actions = el('div', 'w-folder-actions')

      const renameBtn = el('button', 'w-icon-btn')
      renameBtn.type = 'button'
      renameBtn.textContent = '✎'
      renameBtn.setAttribute('aria-label', lang.transl('_w_renameFolder'))
      renameBtn.title = lang.transl('_w_renameFolder')
      renameBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        startInlineRename(row, folder, callbacks.onRenameFolder)
      })
      actions.appendChild(renameBtn)

      const delBtn = el('button', 'w-icon-btn w-icon-btn-danger')
      delBtn.type = 'button'
      delBtn.textContent = '×'
      delBtn.setAttribute('aria-label', lang.transl('_w_deleteFolder'))
      delBtn.title = lang.transl('_w_deleteFolder')
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const confirmed = window.confirm(
          lang.transl('_w_deleteFolderConfirm', folder.name)
        )
        if (confirmed) {
          void callbacks.onDeleteFolder(folder)
        }
      })
      actions.appendChild(delBtn)

      row.appendChild(actions)
    }

    list.appendChild(row)
  }

  nav.appendChild(list)

  // + New folder button -> inline input
  const newFolderWrap = el('div', 'w-new-folder-wrap')
  renderNewFolderButton(newFolderWrap, callbacks.onCreateFolder)
  nav.appendChild(newFolderWrap)

  body.appendChild(nav)

  // Bottom export / import buttons
  const footer = el('div', 'w-sidebar-footer')
  const exportBtn = el(
    'button',
    'w-btn w-btn-secondary',
    lang.transl('_w_export')
  )
  exportBtn.type = 'button'
  exportBtn.addEventListener('click', () => callbacks.onExport())
  footer.appendChild(exportBtn)

  const importBtn = el(
    'button',
    'w-btn w-btn-secondary',
    lang.transl('_w_import')
  )
  importBtn.type = 'button'
  importBtn.addEventListener('click', () => callbacks.onImport())
  footer.appendChild(importBtn)

  body.appendChild(footer)
  root.appendChild(body)
}

function renderNewFolderButton(
  wrap: HTMLElement,
  onCreate: (name: string) => Promise<void>
): void {
  wrap.replaceChildren()
  const btn = el('button', 'w-new-folder-btn', lang.transl('_w_newFolder'))
  btn.type = 'button'
  btn.addEventListener('click', () => {
    wrap.replaceChildren()
    const input = el('input', 'w-inline-input')
    input.type = 'text'
    input.maxLength = 100
    input.placeholder = lang.transl('_w_folderNamePlaceholder')
    input.setAttribute('aria-label', lang.transl('_w_folderNamePlaceholder'))

    let finished = false
    const cancel = (): void => {
      if (finished) return
      finished = true
      renderNewFolderButton(wrap, onCreate)
    }
    const submit = (): void => {
      if (finished) return
      const name = input.value.trim()
      finished = true
      if (name) {
        void onCreate(name)
      } else {
        renderNewFolderButton(wrap, onCreate)
      }
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        submit()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        cancel()
      }
    })
    input.addEventListener('blur', () => cancel())

    wrap.appendChild(input)
    input.focus()
  })
  wrap.appendChild(btn)
}

function startInlineRename(
  row: HTMLElement,
  folder: WatchFolder,
  onRename: (id: string, name: string) => Promise<void>
): void {
  const input = el('input', 'w-inline-input')
  input.type = 'text'
  input.maxLength = 100
  input.value = folder.name
  input.setAttribute('aria-label', lang.transl('_w_renameFolder'))

  const origChildren = Array.from(row.childNodes)
  row.draggable = false
  row.replaceChildren(input)
  input.focus()
  input.select()

  let finished = false
  const restore = (): void => {
    row.draggable = true
    row.replaceChildren(...origChildren)
  }
  const commit = (): void => {
    if (finished) return
    finished = true
    const next = input.value.trim()
    if (next && next !== folder.name) {
      void onRename(folder.id, next)
    } else {
      restore()
    }
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
