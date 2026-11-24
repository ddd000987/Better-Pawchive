/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Left sidebar with folder navigation, inline CRUD, drag-and-drop, and export/import. */

import { lang } from '../Language'
import type { CollectData, FavImage, FavPost } from '../watch/collectTypes'
import { allTagCounts } from '../watch/tagOps'
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
import {
  MIME_CREATOR,
  MIME_FAV_IMAGE,
  MIME_FAV_IMAGE_FOLDER,
  MIME_FAV_POST,
  MIME_FAV_POST_FOLDER,
  MIME_FOLDER,
  el,
  folderLabel,
} from './dom'
import type { WatchRoute } from './listModel'

const SECTION_STATE_KEY = 'pawchiveProWatchSidebarSections'

type CollapsibleSectionKey = 'creators' | 'posts' | 'images'

interface SectionCollapsedState {
  creators?: boolean
  posts?: boolean
  images?: boolean
}

function loadCollapsedState(): SectionCollapsedState {
  try {
    const raw = window.localStorage.getItem(SECTION_STATE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SectionCollapsedState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCollapsedState(state: SectionCollapsedState): void {
  try {
    window.localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors
  }
}

export interface FolderSectionCallbacks {
  onCreateFolder: (name: string) => Promise<void>
  onRenameFolder: (id: string, name: string) => Promise<void>
  onDeleteFolder: (folder: WatchFolder) => Promise<void>
  onReorderFolders: (ids: string[]) => Promise<void>
  onDropItems: (draggedKey: string, folderId: string) => Promise<void>
}

export interface SidebarCallbacks {
  onNavigate: (hash: string) => void
  creators: FolderSectionCallbacks
  favPosts: FolderSectionCallbacks
  favImages: FolderSectionCallbacks
  onExport: () => void
  onImport: () => void
  onToggleMobileMenu: () => void
}

export interface SidebarRenderParams {
  data: WatchData
  favPostsData: CollectData<FavPost>
  favImagesData: CollectData<FavImage>
  route: WatchRoute
  mobileOpen: boolean
  callbacks: SidebarCallbacks
}

interface FolderListConfig {
  folders: WatchFolder[]
  activeFolderId: string | null
  countInFolder: (folderId: string) => number
  routeForFolder: (folderId: string) => string
  itemMime: string
  folderMime: string
  onNavigate: (hash: string) => void
  callbacks: FolderSectionCallbacks
}

function countCollectItemsByFolder<T extends { folderId: string }>(
  items: Record<string, T>
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of Object.values(items)) {
    counts.set(item.folderId, (counts.get(item.folderId) ?? 0) + 1)
  }
  return counts
}

function renderFolderList(container: HTMLElement, cfg: FolderListConfig): void {
  const {
    folders,
    activeFolderId,
    countInFolder,
    routeForFolder,
    itemMime,
    folderMime,
    onNavigate,
    callbacks,
  } = cfg

  const list = el('div', 'w-folder-list')
  let draggingFolderId: string | null = null

  for (const folder of folders) {
    const isUnsorted = folder.id === UNSORTED_FOLDER_ID
    const isActive = activeFolderId === folder.id
    const count = countInFolder(folder.id)

    const row = el('div', isActive ? 'w-folder-row is-active' : 'w-folder-row')
    row.dataset.folderId = folder.id

    if (!isUnsorted) {
      row.draggable = true
      row.addEventListener('dragstart', (ev) => {
        draggingFolderId = folder.id
        row.classList.add('is-dragging')
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move'
          ev.dataTransfer.setData(folderMime, folder.id)
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

    // Drag-over & drop: supports item drop (all folders) and folder reorder (non-unsorted)
    row.addEventListener('dragover', (ev) => {
      const types = ev.dataTransfer?.types
      if (!types) return
      const isItem = types.includes(itemMime)
      const isFolder =
        !isUnsorted &&
        types.includes(folderMime) &&
        draggingFolderId !== folder.id
      if (isItem || isFolder) {
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
      const itemKey = ev.dataTransfer?.getData(itemMime)
      if (itemKey) {
        void callbacks.onDropItems(itemKey, folder.id)
        return
      }
      const sourceFolderId = ev.dataTransfer?.getData(folderMime)
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
      onNavigate(routeForFolder(folder.id))
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

  container.appendChild(list)

  const newFolderWrap = el('div', 'w-new-folder-wrap')
  renderNewFolderButton(newFolderWrap, callbacks.onCreateFolder)
  container.appendChild(newFolderWrap)
}

interface NavSectionParams {
  sectionKey: CollapsibleSectionKey
  heading: string
  totalCount: number
  collapsedState: SectionCollapsedState
  /** Adds the section's items to its body */
  fill(body: HTMLElement): void
}

/** A titled, collapsible sidebar group (creators, favorite posts, images). */
function renderNavSection(nav: HTMLElement, params: NavSectionParams): void {
  const { sectionKey, heading, totalCount, collapsedState, fill } = params
  let collapsed = Boolean(collapsedState[sectionKey])

  const section = el('section', `w-nav-section w-nav-section-${sectionKey}`)

  const headBtn = el('button', 'w-nav-section-head')
  headBtn.type = 'button'
  headBtn.setAttribute('aria-expanded', String(!collapsed))
  const caret = el('span', 'w-nav-caret', collapsed ? '▸' : '▾')
  caret.setAttribute('aria-hidden', 'true')
  headBtn.appendChild(caret)
  headBtn.appendChild(el('span', 'w-nav-section-title', heading))
  headBtn.appendChild(el('span', 'w-nav-section-count', String(totalCount)))

  const body = el('div', 'w-nav-section-body')
  body.hidden = collapsed

  headBtn.addEventListener('click', () => {
    collapsed = !collapsed
    body.hidden = collapsed
    caret.textContent = collapsed ? '▸' : '▾'
    headBtn.setAttribute('aria-expanded', String(!collapsed))
    const next = loadCollapsedState()
    next[sectionKey] = collapsed
    saveCollapsedState(next)
  })

  fill(body)
  section.appendChild(headBtn)
  section.appendChild(body)
  nav.appendChild(section)
}

/** Small label above a section's folder list */
function folderSubLabel(): HTMLElement {
  return el('div', 'w-nav-sub', lang.transl('_w_foldersHeading'))
}

/** The "All ..." entry at the top of a favorites section */
function allItemButton(
  label: string,
  count: number,
  active: boolean,
  onClick: () => void
): HTMLButtonElement {
  const btn = el('button', active ? 'w-nav-item is-active' : 'w-nav-item')
  btn.type = 'button'
  btn.appendChild(el('span', 'w-nav-label', label))
  btn.appendChild(el('span', 'w-nav-count', String(count)))
  btn.addEventListener('click', onClick)
  return btn
}

export function renderSidebar(
  root: HTMLElement,
  params: SidebarRenderParams
): void {
  const { data, favPostsData, favImagesData, route, mobileOpen, callbacks } =
    params
  const folders = sortedFolders(data)
  const allCreators = Object.values(data.creators)
  const totalCount = allCreators.length
  const trackedCount = allCreators.filter((c) => c.tracking?.enabled).length
  const updatesCount = allCreators.filter(
    (c) => c.tracking?.enabled && c.tracking.unread.length > 0
  ).length
  const unreadTotal = totalUnread(data)
  const collapsedState = loadCollapsedState()

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

  // Tags
  const tagsBtn = el(
    'button',
    route.view === 'tags' ? 'w-nav-item is-active' : 'w-nav-item'
  )
  tagsBtn.type = 'button'
  tagsBtn.appendChild(el('span', 'w-nav-label', lang.transl('_lb_tagsNav')))
  tagsBtn.appendChild(el('span', 'w-nav-count', String(allTagCounts().length)))
  tagsBtn.addEventListener('click', () => callbacks.onNavigate('#/tags'))
  nav.appendChild(tagsBtn)

  nav.appendChild(el('div', 'w-nav-sep'))

  renderNavSection(nav, {
    sectionKey: 'creators',
    heading: lang.transl('_w_sectionCreators'),
    totalCount,
    collapsedState,
    fill: (body) => {
      // All creators
      const allBtn = el(
        'button',
        route.view === 'all' ? 'w-nav-item is-active' : 'w-nav-item'
      )
      allBtn.type = 'button'
      allBtn.appendChild(
        el('span', 'w-nav-label', lang.transl('_w_allCreators'))
      )
      allBtn.appendChild(el('span', 'w-nav-count', String(totalCount)))
      allBtn.addEventListener('click', () => callbacks.onNavigate('#/all'))
      body.appendChild(allBtn)

      // Updates (creators with unread + total unread badge)
      const updatesBtn = el(
        'button',
        route.view === 'updates' ? 'w-nav-item is-active' : 'w-nav-item'
      )
      updatesBtn.type = 'button'
      updatesBtn.appendChild(
        el('span', 'w-nav-label', lang.transl('_wt_updates'))
      )
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
      updatesBtn.addEventListener('click', () =>
        callbacks.onNavigate('#/updates')
      )
      body.appendChild(updatesBtn)

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
      body.appendChild(trackingBtn)

      // New posts feed
      const feedBtn = el(
        'button',
        route.view === 'feed' ? 'w-nav-item is-active' : 'w-nav-item'
      )
      feedBtn.type = 'button'
      feedBtn.appendChild(el('span', 'w-nav-label', lang.transl('_wt_feed')))
      feedBtn.addEventListener('click', () => callbacks.onNavigate('#/feed'))
      body.appendChild(feedBtn)

      // Creator folders
      body.appendChild(folderSubLabel())
      renderFolderList(body, {
        folders,
        activeFolderId: route.view === 'folder' ? route.folderId : null,
        countInFolder: (folderId) => creatorsInFolder(data, folderId).length,
        routeForFolder: (folderId) =>
          `#/folder/${encodeURIComponent(folderId)}`,
        itemMime: MIME_CREATOR,
        folderMime: MIME_FOLDER,
        onNavigate: callbacks.onNavigate,
        callbacks: callbacks.creators,
      })
    },
  })

  // Favorite posts section
  const postTotal = Object.keys(favPostsData.items).length
  const postFolderCounts = countCollectItemsByFolder(favPostsData.items)
  renderNavSection(nav, {
    sectionKey: 'posts',
    heading: lang.transl('_fv_favPosts'),
    totalCount: postTotal,
    collapsedState,
    fill: (body) => {
      body.appendChild(
        allItemButton(
          lang.transl('_fv_allPosts'),
          postTotal,
          route.view === 'posts' && !route.folderId,
          () => callbacks.onNavigate('#/posts')
        )
      )
      body.appendChild(folderSubLabel())
      renderFolderList(body, {
        folders: sortedFolders(favPostsData),
        activeFolderId:
          route.view === 'posts' ? (route.folderId ?? null) : null,
        countInFolder: (folderId) => postFolderCounts.get(folderId) ?? 0,
        routeForFolder: (folderId) => `#/posts/${encodeURIComponent(folderId)}`,
        itemMime: MIME_FAV_POST,
        folderMime: MIME_FAV_POST_FOLDER,
        onNavigate: callbacks.onNavigate,
        callbacks: callbacks.favPosts,
      })
    },
  })

  // Favorite images section
  const imageTotal = Object.keys(favImagesData.items).length
  const imageFolderCounts = countCollectItemsByFolder(favImagesData.items)
  renderNavSection(nav, {
    sectionKey: 'images',
    heading: lang.transl('_fv_favImages'),
    totalCount: imageTotal,
    collapsedState,
    fill: (body) => {
      body.appendChild(
        allItemButton(
          lang.transl('_fv_allImages'),
          imageTotal,
          route.view === 'images' && !route.folderId,
          () => callbacks.onNavigate('#/images')
        )
      )
      body.appendChild(folderSubLabel())
      renderFolderList(body, {
        folders: sortedFolders(favImagesData),
        activeFolderId:
          route.view === 'images' ? (route.folderId ?? null) : null,
        countInFolder: (folderId) => imageFolderCounts.get(folderId) ?? 0,
        routeForFolder: (folderId) =>
          `#/images/${encodeURIComponent(folderId)}`,
        itemMime: MIME_FAV_IMAGE,
        folderMime: MIME_FAV_IMAGE_FOLDER,
        onNavigate: callbacks.onNavigate,
        callbacks: callbacks.favImages,
      })
    },
  })

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
