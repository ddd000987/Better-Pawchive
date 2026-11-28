/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Root state, hash router, refresh runner, and live-update orchestration for the watch page. */

import { EVT } from '../EVT'
import { api } from '../kemono/api'
import { lang } from '../Language'
import { favImages, favPosts } from '../watch/collectStore'
import type { FavImage, FavPost } from '../watch/collectTypes'
import { normalizeTags, sanitizeRating } from '../watch/labels'
import { runScan, type ScanResult } from '../watch/scanner'
import { snapshotFromPosts, snapshots } from '../watch/snapshot'
import { deleteTag, renameTag } from '../watch/tagOps'
import { creatorsInFolder } from '../watch/watchData'
import { watchStore } from '../watch/watchStore'
import {
  UNSORTED_FOLDER_ID,
  type CreatorSnapshot,
  type WatchedCreator,
} from '../watch/watchTypes'
import { renderCreatorList } from './creatorList'
import { mountDetailView, type DetailController } from './detail'
import { el, folderLabel } from './dom'
import { renderFavImagesView } from './favImagesView'
import {
  filterFavImages,
  filterFavPosts,
  sortFavImages,
  sortFavPosts,
  type FavSortMode,
} from './favModel'
import {
  openFavPostEditorModal,
  renderFavPostsView,
  type PostEditorModalHandle,
} from './favPostsView'
import { renderFeedToolbar, renderFeedView, type FeedCallbacks } from './feed'
import { closeImageMenu, openImageMenu } from './imageContextMenu'
import { openFavImageLightbox, type LightboxHandle } from './lightbox'
import {
  filterCreators,
  hasActiveLabelFilter,
  parseRoute,
  sortCreators,
  type LabelFilter,
  type SortMode,
  type WatchRoute,
} from './listModel'
import { openSettingsDialog, type SettingsDialogHandle } from './settingsDialog'
import { renderSidebar } from './sidebar'
import { renderTagsToolbar, renderTagsView } from './tagsView'
import {
  renderFavToolbar,
  renderToolbar,
  type RefreshState,
  type ToolbarPopover,
  type ViewMode,
} from './toolbar'
import { exportWatchlist, importWatchlist } from './transfer'

const VIEW_MODE_KEY = 'pawchiveProWatchView'
const FILTER_KEY = 'pawchiveProWatchFilter'

function loadLabelFilter(): LabelFilter {
  try {
    const raw = window.localStorage.getItem(FILTER_KEY)
    if (!raw) return { tags: [] }
    const parsed = JSON.parse(raw) as {
      tags?: unknown
      ratings?: unknown
      minRating?: unknown
    }
    const tags = normalizeTags(parsed?.tags) ?? []
    let ratings: number[] = []
    if (Array.isArray(parsed?.ratings)) {
      ratings = [
        ...new Set(
          parsed.ratings
            .map((r) => sanitizeRating(r))
            .filter((r): r is NonNullable<typeof r> => r !== undefined)
        ),
      ].sort((a, b) => a - b)
    } else {
      // Older saves kept a minimum rating: N becomes N..5
      const min = sanitizeRating(parsed?.minRating)
      if (min) for (let r = min; r <= 5; r++) ratings.push(r)
    }
    return ratings.length > 0 ? { tags, ratings } : { tags }
  } catch {
    return { tags: [] }
  }
}

function saveLabelFilter(filter: LabelFilter): void {
  try {
    if (!hasActiveLabelFilter(filter)) {
      window.localStorage.removeItem(FILTER_KEY)
    } else {
      window.localStorage.setItem(FILTER_KEY, JSON.stringify(filter))
    }
  } catch {
    // Ignore storage errors
  }
}

function loadViewMode(): ViewMode {
  try {
    const saved = window.localStorage.getItem(VIEW_MODE_KEY)
    if (saved === 'list' || saved === 'grid') return saved
  } catch {
    // Ignore storage errors (e.g. restricted contexts)
  }
  return 'grid'
}

function saveViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    // Ignore storage errors
  }
}

export class WatchApp {
  private root: HTMLElement
  private sidebarEl: HTMLElement
  private mainEl: HTMLElement
  private noticeEl: HTMLElement
  private toolbarEl: HTMLElement
  private contentEl: HTMLElement

  private route: WatchRoute = parseRoute(location.hash)
  private snaps = new Map<string, CreatorSnapshot>()
  private query = ''
  private labelFilter: LabelFilter = loadLabelFilter()
  private openPopover: ToolbarPopover = null
  private sort: SortMode = 'name'
  private favPostSort: FavSortMode = 'added'
  private favImageSort: FavSortMode = 'added'
  private view: ViewMode = loadViewMode()
  private selectMode = false
  private selected = new Set<string>()
  private lastSelectedKey: string | null = null
  private mobileMenuOpen = false
  private hasInternalHistory = false

  private refreshState: RefreshState = { running: false, done: 0, total: 0 }
  private refreshAbort: AbortController | null = null

  private noticeTimer: number | null = null
  private detailController: DetailController | null = null
  private postEditorModal: PostEditorModalHandle | null = null
  private lightbox: LightboxHandle | null = null
  private settingsDialog: SettingsDialogHandle | null = null

  constructor(root: HTMLElement) {
    this.root = root
    this.sidebarEl = el('aside', 'w-sidebar')
    this.mainEl = el('main', 'w-main')
    this.noticeEl = el('div', 'w-notice')
    this.noticeEl.hidden = true
    this.noticeEl.setAttribute('role', 'status')
    this.toolbarEl = el('div', 'w-toolbar-wrap')
    this.contentEl = el('div', 'w-content')

    this.mainEl.appendChild(this.noticeEl)
    this.mainEl.appendChild(this.toolbarEl)
    this.mainEl.appendChild(this.contentEl)

    this.root.className = 'w-layout'
    this.root.replaceChildren(this.sidebarEl, this.mainEl)
  }

  async start(): Promise<void> {
    await Promise.all([watchStore.ready(), favPosts.ready(), favImages.ready()])
    await this.loadSnapshots()
    this.updateTitle()

    window.addEventListener('hashchange', () => {
      this.hasInternalHistory = true
      this.onRouteChange()
    })

    document.addEventListener('click', (ev) => {
      if (this.openPopover === null) return
      const target = ev.target as Node | null
      if (target instanceof Element && target.closest('.w-popover-anchor')) {
        return
      }
      this.openPopover = null
      this.renderToolbarOnly()
    })

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.openPopover !== null) {
        this.openPopover = null
        this.renderToolbarOnly()
      }
    })

    watchStore.onChange(() => {
      this.onStoreChange()
    })

    favPosts.onChange(() => {
      this.onFavPostsChange()
    })

    favImages.onChange(() => {
      this.onFavImagesChange()
    })

    EVT.on(EVT.list.langChange, () => {
      this.updateTitle()
      this.renderAll(true)
    })

    if (!location.hash) {
      history.replaceState(null, '', '#/all')
    }
    this.route = parseRoute(location.hash)
    this.renderAll(true)
  }

  private updateTitle(): void {
    document.title = lang.transl('_w_title')
  }

  private async loadSnapshots(): Promise<void> {
    const keys = Object.keys(watchStore.data.creators)
    if (keys.length === 0) return
    const loaded = await snapshots.getMany(keys)
    for (const [k, v] of loaded) {
      this.snaps.set(k, v)
    }
  }

  private showNotice(message: string, isError = false): void {
    this.noticeEl.textContent = message
    this.noticeEl.className = isError ? 'w-notice is-error' : 'w-notice'
    this.noticeEl.setAttribute('role', isError ? 'alert' : 'status')
    this.noticeEl.hidden = false
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer)
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.hidden = true
    }, 5000)
  }

  private navigate(hash: string): void {
    this.mobileMenuOpen = false
    if (location.hash === hash) {
      this.renderSidebarOnly()
      return
    }
    this.hasInternalHistory = true
    location.hash = hash
  }

  private closeOverlays(): void {
    closeImageMenu()
    if (this.postEditorModal) {
      this.postEditorModal.destroy()
      this.postEditorModal = null
    }
    if (this.lightbox) {
      this.lightbox.destroy()
      this.lightbox = null
    }
  }

  private onRouteChange(): void {
    const next = parseRoute(location.hash)
    const prev = this.route
    this.route = next
    this.mobileMenuOpen = false
    this.openPopover = null
    this.closeOverlays()

    // Clear selection when changing views or folders
    const sameFolder =
      (prev.view === 'folder' &&
        next.view === 'folder' &&
        prev.folderId === next.folderId) ||
      (prev.view === 'posts' &&
        next.view === 'posts' &&
        prev.folderId === next.folderId) ||
      (prev.view === 'images' &&
        next.view === 'images' &&
        prev.folderId === next.folderId)

    if (prev.view !== next.view || !sameFolder) {
      this.selected.clear()
      this.lastSelectedKey = null
      this.selectMode = false
    }

    this.renderAll(true)
    window.scrollTo({ top: 0 })
  }

  private onStoreChange(): void {
    const creators = watchStore.data.creators
    // Prune selection to existing creators only when viewing creators
    if (this.route.view !== 'posts' && this.route.view !== 'images') {
      for (const k of Array.from(this.selected)) {
        if (!Object.hasOwn(creators, k)) this.selected.delete(k)
      }
    }

    // Load snapshots for any newly added creators
    const missing = Object.keys(creators).filter((k) => !this.snaps.has(k))
    if (missing.length > 0) {
      void snapshots.getMany(missing).then((loaded) => {
        if (loaded.size === 0) return
        for (const [k, v] of loaded) this.snaps.set(k, v)
        if (
          this.route.view !== 'creator' &&
          this.route.view !== 'posts' &&
          this.route.view !== 'images'
        ) {
          this.renderListContent()
        }
      })
    }

    // If currently viewing a deleted folder, fall back to #/all
    const currentRoute = this.route
    if (
      currentRoute.view === 'folder' &&
      !watchStore.data.folders.some((f) => f.id === currentRoute.folderId)
    ) {
      this.navigate('#/all')
      return
    }

    this.renderSidebarOnly()
    if (this.route.view === 'creator') {
      this.detailController?.sync(
        watchStore.getCreator(this.route.key),
        watchStore.data
      )
    } else if (this.route.view === 'posts' || this.route.view === 'images') {
      if (this.openPopover === 'filter') {
        this.renderToolbarOnly()
      }
    } else {
      const scrollY = window.scrollY
      this.renderToolbarOnly()
      this.renderListContent()
      window.scrollTo({ top: scrollY })
    }
  }

  private onFavPostsChange(): void {
    const currentRoute = this.route
    if (currentRoute.view === 'posts') {
      for (const k of Array.from(this.selected)) {
        if (!favPosts.has(k)) this.selected.delete(k)
      }
      if (
        currentRoute.folderId &&
        !favPosts.data.folders.some((f) => f.id === currentRoute.folderId)
      ) {
        this.navigate('#/posts')
        return
      }
    }

    this.renderSidebarOnly()
    if (currentRoute.view === 'posts') {
      const scrollY = window.scrollY
      this.renderToolbarOnly()
      this.renderListContent()
      window.scrollTo({ top: scrollY })
      this.postEditorModal?.sync()
    } else if (currentRoute.view === 'tags') {
      this.renderListContent()
    } else if (this.openPopover === 'filter') {
      this.renderToolbarOnly()
    }
  }

  private onFavImagesChange(): void {
    const currentRoute = this.route
    if (currentRoute.view === 'images') {
      for (const k of Array.from(this.selected)) {
        if (!favImages.has(k)) this.selected.delete(k)
      }
      if (
        currentRoute.folderId &&
        !favImages.data.folders.some((f) => f.id === currentRoute.folderId)
      ) {
        this.navigate('#/images')
        return
      }
    }

    this.renderSidebarOnly()
    if (currentRoute.view === 'images') {
      const scrollY = window.scrollY
      this.renderToolbarOnly()
      this.renderListContent()
      window.scrollTo({ top: scrollY })
      this.lightbox?.sync(this.visibleFavImages())
    } else if (currentRoute.view === 'tags') {
      this.renderListContent()
    } else if (this.openPopover === 'filter') {
      this.renderToolbarOnly()
    }
  }

  private setLabelFilter(next: LabelFilter): void {
    this.labelFilter = next
    saveLabelFilter(next)
    this.renderToolbarOnly()
    this.renderListContent()
  }

  private applyTagFilter(tag: string): void {
    const lower = tag.toLowerCase()
    if (this.labelFilter.tags.some((t) => t.toLowerCase() === lower)) return
    this.setLabelFilter({
      tags: [...this.labelFilter.tags, tag],
      ratings: this.labelFilter.ratings,
    })
  }

  private selectedItemTags(): string[] {
    const seen = new Map<string, string>()
    for (const key of this.selected) {
      const tags =
        this.route.view === 'posts'
          ? favPosts.get(key)?.tags
          : this.route.view === 'images'
            ? favImages.get(key)?.tags
            : watchStore.getCreator(key)?.tags
      if (!tags) continue
      for (const tag of tags) {
        const lower = tag.toLowerCase()
        if (!seen.has(lower)) seen.set(lower, tag)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b))
  }

  private visibleFavPosts(): FavPost[] {
    const base =
      this.route.view === 'posts' && this.route.folderId
        ? favPosts.itemsInFolder(this.route.folderId)
        : Object.values(favPosts.data.items)
    const filtered = filterFavPosts(base, this.query, this.labelFilter)
    return sortFavPosts(filtered, this.favPostSort)
  }

  private visibleFavImages(): FavImage[] {
    const base =
      this.route.view === 'images' && this.route.folderId
        ? favImages.itemsInFolder(this.route.folderId)
        : Object.values(favImages.data.items)
    const filtered = filterFavImages(base, this.query, this.labelFilter)
    return sortFavImages(filtered, this.favImageSort)
  }

  private visibleCreators(): WatchedCreator[] {
    const data = watchStore.data
    let base: WatchedCreator[]
    if (this.route.view === 'folder') {
      base = creatorsInFolder(data, this.route.folderId)
    } else if (this.route.view === 'updates') {
      base = Object.values(data.creators).filter(
        (c) => c.tracking?.enabled && c.tracking.unread.length > 0
      )
    } else if (this.route.view === 'tracking') {
      base = Object.values(data.creators).filter((c) => c.tracking?.enabled)
    } else {
      base = Object.values(data.creators)
    }
    const filtered = filterCreators(base, this.query, this.labelFilter)
    return sortCreators(filtered, this.sort, this.snaps)
  }

  private currentListTitle(): string {
    const route = this.route
    if (route.view === 'updates') return lang.transl('_wt_updates')
    if (route.view === 'tracking') return lang.transl('_wt_trackingList')
    if (route.view === 'feed') return lang.transl('_wt_feed')
    if (route.view === 'folder') {
      const folder = watchStore.data.folders.find(
        (f) => f.id === route.folderId
      )
      if (folder) return folderLabel(folder)
    }
    if (route.view === 'posts') {
      if (route.folderId) {
        const folder = favPosts.data.folders.find(
          (f) => f.id === route.folderId
        )
        if (folder) return folderLabel(folder)
      }
      return lang.transl('_fv_allPosts')
    }
    if (route.view === 'images') {
      if (route.folderId) {
        const folder = favImages.data.folders.find(
          (f) => f.id === route.folderId
        )
        if (folder) return folderLabel(folder)
      }
      return lang.transl('_fv_allImages')
    }
    return lang.transl('_w_allCreators')
  }

  private currentEmptyMessage(): string | undefined {
    if (this.route.view === 'updates') return lang.transl('_wt_emptyUpdates')
    if (this.route.view === 'tracking') return lang.transl('_wt_emptyTracking')
    return undefined
  }

  private feedCallbacks(): FeedCallbacks {
    return {
      onOpenCreator: (key) => {
        this.navigate(`#/creator/${encodeURIComponent(key)}`)
      },
      onMarkPostRead: (key, postId) => watchStore.markPostsRead(key, [postId]),
      onMarkAllRead: (keys) => watchStore.markRead(keys),
    }
  }

  private renderSidebarOnly(): void {
    renderSidebar(this.sidebarEl, {
      data: watchStore.data,
      favPostsData: favPosts.data,
      favImagesData: favImages.data,
      route: this.route,
      mobileOpen: this.mobileMenuOpen,
      callbacks: {
        onNavigate: (hash) => this.navigate(hash),
        creators: {
          onCreateFolder: async (name) => {
            await watchStore.addFolder(name)
          },
          onRenameFolder: async (id, name) => {
            await watchStore.renameFolder(id, name)
          },
          onDeleteFolder: async (folder) => {
            const viewingDeleted =
              this.route.view === 'folder' && this.route.folderId === folder.id
            await watchStore.deleteFolder(folder.id)
            if (viewingDeleted) {
              this.navigate('#/all')
            }
          },
          onReorderFolders: async (ids) => {
            await watchStore.reorderFolders(ids)
          },
          onDropItems: async (draggedKey, folderId) => {
            const inCreators =
              this.route.view !== 'posts' && this.route.view !== 'images'
            const keys =
              inCreators &&
              this.selected.size > 0 &&
              this.selected.has(draggedKey)
                ? Array.from(this.selected)
                : [draggedKey]
            await watchStore.moveCreators(keys, folderId)
            if (inCreators && this.selected.has(draggedKey)) {
              this.selected.clear()
              this.lastSelectedKey = null
            }
          },
        },
        favPosts: {
          onCreateFolder: async (name) => {
            await favPosts.addFolder(name)
          },
          onRenameFolder: async (id, name) => {
            await favPosts.renameFolder(id, name)
          },
          onDeleteFolder: async (folder) => {
            const viewingDeleted =
              this.route.view === 'posts' && this.route.folderId === folder.id
            await favPosts.deleteFolder(folder.id)
            if (viewingDeleted) {
              this.navigate('#/posts')
            }
          },
          onReorderFolders: async (ids) => {
            await favPosts.reorderFolders(ids)
          },
          onDropItems: async (draggedKey, folderId) => {
            const inPosts = this.route.view === 'posts'
            const keys =
              inPosts && this.selected.size > 0 && this.selected.has(draggedKey)
                ? Array.from(this.selected)
                : [draggedKey]
            await favPosts.move(keys, folderId)
            if (inPosts && this.selected.has(draggedKey)) {
              this.selected.clear()
              this.lastSelectedKey = null
            }
          },
        },
        favImages: {
          onCreateFolder: async (name) => {
            await favImages.addFolder(name)
          },
          onRenameFolder: async (id, name) => {
            await favImages.renameFolder(id, name)
          },
          onDeleteFolder: async (folder) => {
            const viewingDeleted =
              this.route.view === 'images' && this.route.folderId === folder.id
            await favImages.deleteFolder(folder.id)
            if (viewingDeleted) {
              this.navigate('#/images')
            }
          },
          onReorderFolders: async (ids) => {
            await favImages.reorderFolders(ids)
          },
          onDropItems: async (draggedKey, folderId) => {
            const inImages = this.route.view === 'images'
            const keys =
              inImages &&
              this.selected.size > 0 &&
              this.selected.has(draggedKey)
                ? Array.from(this.selected)
                : [draggedKey]
            await favImages.move(keys, folderId)
            if (inImages && this.selected.has(draggedKey)) {
              this.selected.clear()
              this.lastSelectedKey = null
            }
          },
        },
        onOpenSettings: () => this.openSettings(),
        onToggleMobileMenu: () => {
          this.mobileMenuOpen = !this.mobileMenuOpen
          this.renderSidebarOnly()
        },
      },
    })
  }

  /** Right-click menu of a favorite image; on a selected image in select
   * mode it acts on the whole selection */
  private openImageMenu(
    key: string,
    at: { x: number; y: number },
    shown: HTMLImageElement | null
  ): void {
    const useSelection =
      this.selectMode && this.selected.has(key) && this.selected.size > 1
    const keys = useSelection ? Array.from(this.selected) : [key]
    const images = keys
      .map((k) => favImages.get(k))
      .filter((img): img is FavImage => img !== undefined)
    openImageMenu({
      images,
      at,
      shown,
      notify: (msg, isError) => this.showNotice(msg, isError),
      onChanged: () => {
        if (!useSelection) return
        this.selected.clear()
        this.lastSelectedKey = null
        this.renderToolbarOnly()
      },
    })
  }

  private openSettings(): void {
    this.settingsDialog?.destroy()
    this.settingsDialog = openSettingsDialog({
      view: this.view,
      onViewChange: (mode) => this.setView(mode),
      onExport: () => {
        void exportWatchlist().then(() => {
          this.showNotice(lang.transl('_w_exportDone'))
        })
      },
      onImport: () => {
        importWatchlist((msg, isError) => this.showNotice(msg, isError))
      },
      onClose: () => {
        this.settingsDialog = null
      },
    })
  }

  private setView(mode: ViewMode): void {
    this.view = mode
    saveViewMode(mode)
    // The settings dialog can change it on a creator's page, which has no list
    if (this.route.view === 'creator') return
    this.renderToolbarOnly()
    this.renderListContent()
  }

  private renderToolbarOnly(): void {
    if (this.route.view === 'creator') {
      this.toolbarEl.hidden = true
      this.toolbarEl.replaceChildren()
      return
    }
    this.toolbarEl.hidden = false
    if (this.route.view === 'feed') {
      renderFeedToolbar(this.toolbarEl, watchStore.data, this.feedCallbacks())
      return
    }
    if (this.route.view === 'tags') {
      renderTagsToolbar(this.toolbarEl)
      return
    }
    if (this.route.view === 'posts' || this.route.view === 'images') {
      const isPosts = this.route.view === 'posts'
      const store = isPosts ? favPosts : favImages
      renderFavToolbar(this.toolbarEl, {
        kind: this.route.view,
        folders: store.data.folders,
        title: this.currentListTitle(),
        query: this.query,
        labelFilter: this.labelFilter,
        openPopover: this.openPopover,
        sort: isPosts ? this.favPostSort : this.favImageSort,
        selectMode: this.selectMode,
        selectedCount: this.selected.size,
        selectedTags: this.selectedItemTags(),
        callbacks: {
          onSearchChange: (q) => {
            this.query = q
            this.renderListContent()
          },
          onFilterChange: (next) => {
            this.setLabelFilter(next)
          },
          onOpenPopoverChange: (next) => {
            this.openPopover = next
            this.renderToolbarOnly()
          },
          onSortChange: (mode) => {
            if (isPosts) this.favPostSort = mode
            else this.favImageSort = mode
            this.renderListContent()
          },
          onToggleSelect: () => {
            this.selectMode = !this.selectMode
            if (!this.selectMode) {
              this.selected.clear()
              this.lastSelectedKey = null
              if (
                this.openPopover === 'bulkTags' ||
                this.openPopover === 'bulkRating'
              ) {
                this.openPopover = null
              }
            }
            this.renderToolbarOnly()
            this.renderListContent()
          },
          onBulkMove: async (folderId) => {
            const keys = Array.from(this.selected)
            this.selected.clear()
            this.lastSelectedKey = null
            this.openPopover = null
            await store.move(keys, folderId)
          },
          onBulkAddTags: async (tags) => {
            const keys = Array.from(this.selected)
            this.openPopover = null
            await store.updateMany(keys, { addTags: tags })
          },
          onBulkRemoveTag: async (tag) => {
            const keys = Array.from(this.selected)
            await store.updateMany(keys, { removeTags: [tag] })
          },
          onBulkRating: async (rating) => {
            const keys = Array.from(this.selected)
            this.openPopover = null
            await store.updateMany(keys, { rating })
          },
          onBulkRemove: async () => {
            const keys = Array.from(this.selected)
            this.selected.clear()
            this.lastSelectedKey = null
            this.openPopover = null
            await store.remove(keys)
          },
          onClearSelection: () => {
            this.selected.clear()
            this.lastSelectedKey = null
            if (
              this.openPopover === 'bulkTags' ||
              this.openPopover === 'bulkRating'
            ) {
              this.openPopover = null
            }
            this.renderToolbarOnly()
            this.renderListContent()
          },
        },
      })
      return
    }
    const visible = this.visibleCreators()
    renderToolbar(this.toolbarEl, {
      data: watchStore.data,
      title: this.currentListTitle(),
      query: this.query,
      labelFilter: this.labelFilter,
      openPopover: this.openPopover,
      sort: this.sort,
      view: this.view,
      selectMode: this.selectMode,
      selectedCount: this.selected.size,
      selectedTags: this.selectedItemTags(),
      visibleCount: visible.length,
      refresh: this.refreshState,
      callbacks: {
        onSearchChange: (q) => {
          this.query = q
          this.renderListContent()
        },
        onFilterChange: (next) => {
          this.setLabelFilter(next)
        },
        onOpenPopoverChange: (next) => {
          this.openPopover = next
          this.renderToolbarOnly()
        },
        onSortChange: (mode) => {
          this.sort = mode
          this.renderListContent()
        },
        onViewChange: (mode) => this.setView(mode),
        onToggleSelect: () => {
          this.selectMode = !this.selectMode
          if (!this.selectMode) {
            this.selected.clear()
            this.lastSelectedKey = null
            if (
              this.openPopover === 'bulkTags' ||
              this.openPopover === 'bulkRating'
            ) {
              this.openPopover = null
            }
          }
          this.renderToolbarOnly()
          this.renderListContent()
        },
        onRefreshStart: () => {
          void this.runRefresh()
        },
        onRefreshCancel: () => {
          this.refreshAbort?.abort()
        },
        onBulkMove: async (folderId) => {
          const keys = Array.from(this.selected)
          this.selected.clear()
          this.lastSelectedKey = null
          this.openPopover = null
          await watchStore.moveCreators(keys, folderId)
        },
        onBulkAddTags: async (tags) => {
          const keys = Array.from(this.selected)
          this.openPopover = null
          await watchStore.updateCreatorsLabels(keys, { addTags: tags })
        },
        onBulkRemoveTag: async (tag) => {
          const keys = Array.from(this.selected)
          await watchStore.updateCreatorsLabels(keys, { removeTags: [tag] })
        },
        onBulkRating: async (rating) => {
          const keys = Array.from(this.selected)
          this.openPopover = null
          await watchStore.updateCreatorsLabels(keys, { rating })
        },
        onBulkRemove: async () => {
          const keys = Array.from(this.selected)
          this.selected.clear()
          this.lastSelectedKey = null
          this.openPopover = null
          await watchStore.removeCreators(keys)
        },
        onClearSelection: () => {
          this.selected.clear()
          this.lastSelectedKey = null
          if (
            this.openPopover === 'bulkTags' ||
            this.openPopover === 'bulkRating'
          ) {
            this.openPopover = null
          }
          this.renderToolbarOnly()
          this.renderListContent()
        },
      },
    })
  }

  private toggleSelection(
    visibleKeys: string[],
    key: string,
    shiftKey: boolean
  ): void {
    if (shiftKey && this.lastSelectedKey) {
      const start = visibleKeys.indexOf(this.lastSelectedKey)
      const end = visibleKeys.indexOf(key)
      if (start !== -1 && end !== -1) {
        const [lo, hi] = start < end ? [start, end] : [end, start]
        for (let i = lo; i <= hi; i++) {
          this.selected.add(visibleKeys[i])
        }
        this.lastSelectedKey = key
        this.renderToolbarOnly()
        this.renderListContent()
        return
      }
    }
    if (this.selected.has(key)) {
      this.selected.delete(key)
    } else {
      this.selected.add(key)
    }
    this.lastSelectedKey = key
    this.renderToolbarOnly()
    this.renderListContent()
  }

  private renderListContent(): void {
    if (this.route.view === 'feed') {
      renderFeedView(this.contentEl, watchStore.data, this.feedCallbacks())
      return
    }
    if (this.route.view === 'posts') {
      const visible = this.visibleFavPosts()
      renderFavPostsView(this.contentEl, {
        posts: visible,
        totalCount: Object.keys(favPosts.data.items).length,
        hasQuery:
          this.query.trim().length > 0 ||
          hasActiveLabelFilter(this.labelFilter),
        selectMode: this.selectMode,
        selected: this.selected,
        callbacks: {
          onOpenEditor: (key) => {
            this.postEditorModal?.destroy()
            this.postEditorModal = openFavPostEditorModal(key, () => {
              this.postEditorModal = null
            })
          },
          onTagClick: (tag) => {
            this.applyTagFilter(tag)
          },
          onToggleSelect: (key, shiftKey) => {
            this.toggleSelection(
              visible.map((p) => p.key),
              key,
              shiftKey
            )
          },
        },
      })
      return
    }
    if (this.route.view === 'images') {
      const visible = this.visibleFavImages()
      renderFavImagesView(this.contentEl, {
        images: visible,
        totalCount: Object.keys(favImages.data.items).length,
        hasQuery:
          this.query.trim().length > 0 ||
          hasActiveLabelFilter(this.labelFilter),
        selectMode: this.selectMode,
        selected: this.selected,
        callbacks: {
          onOpenLightbox: (key) => {
            this.lightbox?.destroy()
            this.lightbox = openFavImageLightbox(visible, key, () => {
              this.lightbox = null
            })
          },
          onToggleSelect: (key, shiftKey) => {
            this.toggleSelection(
              visible.map((img) => img.key),
              key,
              shiftKey
            )
          },
          onContextMenu: (key, at, shown) => {
            this.openImageMenu(key, at, shown)
          },
        },
      })
      return
    }
    if (this.route.view === 'tags') {
      renderTagsView(this.contentEl, {
        onFilterByTag: (tag) => {
          this.labelFilter = { tags: [tag] }
          saveLabelFilter(this.labelFilter)
          this.navigate('#/all')
        },
        onRenameTag: async (from, to) => {
          await renameTag(from, to)
          const fromLower = from.toLowerCase()
          if (
            this.labelFilter.tags.some((t) => t.toLowerCase() === fromLower)
          ) {
            const nextTags =
              normalizeTags(
                this.labelFilter.tags.map((t) =>
                  t.toLowerCase() === fromLower ? to : t
                )
              ) ?? []
            this.labelFilter = {
              tags: nextTags,
              ratings: this.labelFilter.ratings,
            }
            saveLabelFilter(this.labelFilter)
          }
        },
        onDeleteTag: async (tag) => {
          await deleteTag(tag)
          const lower = tag.toLowerCase()
          if (this.labelFilter.tags.some((t) => t.toLowerCase() === lower)) {
            this.labelFilter = {
              tags: this.labelFilter.tags.filter(
                (t) => t.toLowerCase() !== lower
              ),
              ratings: this.labelFilter.ratings,
            }
            saveLabelFilter(this.labelFilter)
          }
        },
      })
      return
    }
    const visible = this.visibleCreators()
    renderCreatorList(this.contentEl, {
      creators: visible,
      totalInWatchlist: Object.keys(watchStore.data.creators).length,
      hasQuery:
        this.query.trim().length > 0 || hasActiveLabelFilter(this.labelFilter),
      emptyMessage: this.currentEmptyMessage(),
      snaps: this.snaps,
      view: this.view,
      selectMode: this.selectMode,
      selected: this.selected,
      callbacks: {
        onOpenCreator: (key) => {
          this.navigate(`#/creator/${encodeURIComponent(key)}`)
        },
        onTagClick: (tag) => {
          this.applyTagFilter(tag)
        },
        onToggleSelect: (key, shiftKey) => {
          this.toggleSelection(
            visible.map((c) => c.key),
            key,
            shiftKey
          )
        },
      },
    })
  }

  private renderAll(remountDetail: boolean): void {
    this.renderSidebarOnly()

    if (this.route.view === 'creator') {
      this.toolbarEl.hidden = true
      this.toolbarEl.replaceChildren()

      if (
        remountDetail ||
        !this.detailController ||
        this.detailController.key !== this.route.key
      ) {
        this.detailController?.destroy()
        const key = this.route.key
        this.detailController = mountDetailView(
          this.contentEl,
          key,
          this.snaps.get(key),
          {
            onBack: () => {
              if (this.hasInternalHistory && history.length > 1) {
                history.back()
              } else {
                this.navigate('#/all')
              }
            },
            onGoAll: () => this.navigate('#/all'),
            onSnapshotUpdated: (snap) => {
              this.snaps.set(snap.key, snap)
            },
          }
        )
      }
      return
    }

    if (this.detailController) {
      this.detailController.destroy()
      this.detailController = null
    }

    // If folder route refers to missing folder, redirect to section's all
    const activeRoute = this.route
    if (
      activeRoute.view === 'folder' &&
      activeRoute.folderId !== UNSORTED_FOLDER_ID &&
      !watchStore.data.folders.some((f) => f.id === activeRoute.folderId)
    ) {
      this.route = { view: 'all' }
      history.replaceState(null, '', '#/all')
      this.renderSidebarOnly()
    } else if (
      activeRoute.view === 'posts' &&
      activeRoute.folderId &&
      activeRoute.folderId !== UNSORTED_FOLDER_ID &&
      !favPosts.data.folders.some((f) => f.id === activeRoute.folderId)
    ) {
      this.route = { view: 'posts' }
      history.replaceState(null, '', '#/posts')
      this.renderSidebarOnly()
    } else if (
      activeRoute.view === 'images' &&
      activeRoute.folderId &&
      activeRoute.folderId !== UNSORTED_FOLDER_ID &&
      !favImages.data.folders.some((f) => f.id === activeRoute.folderId)
    ) {
      this.route = { view: 'images' }
      history.replaceState(null, '', '#/images')
      this.renderSidebarOnly()
    }

    this.renderToolbarOnly()
    this.renderListContent()
  }

  private async runRefresh(): Promise<void> {
    if (this.refreshState.running) return
    const targets = this.visibleCreators()
    if (targets.length === 0) return

    const tracked = targets.filter((c) => c.tracking?.enabled)
    const untracked = targets.filter((c) => !c.tracking?.enabled)

    const controller = new AbortController()
    this.refreshAbort = controller
    this.refreshState = { running: true, done: 0, total: targets.length }
    this.renderToolbarOnly()

    let scanResult: ScanResult | null = null
    if (tracked.length > 0) {
      scanResult = await runScan(
        tracked,
        {
          fetchPosts: async (creator, signal) => {
            const res = await api.posts(
              {
                service: creator.service,
                creatorId: creator.creatorId,
                index: 0,
                host: watchStore.hostFor(creator.site),
              },
              signal
            )
            if (api.isErrorResponse(res)) {
              throw new Error(res.error)
            }
            return res
          },
          saveSnapshot: async (key, items) => {
            const snap = snapshotFromPosts(key, items)
            await snapshots.set(snap)
            this.snaps.set(key, snap)
          },
          apply: (results) => watchStore.applyCheckResults(results),
        },
        {
          signal: controller.signal,
          onProgress: (done) => {
            this.refreshState.done = done
            if (this.route.view !== 'creator') {
              this.renderToolbarOnly()
              this.renderListContent()
            }
          },
        }
      )
    }

    let untrackedOk = 0
    let untrackedFail = 0
    let cancelled =
      controller.signal.aborted || scanResult?.stoppedBy === 'abort'
    const rateLimited = scanResult?.stoppedBy === 'rateLimit'

    if (!cancelled && !rateLimited) {
      for (const creator of untracked) {
        if (controller.signal.aborted) {
          cancelled = true
          break
        }
        try {
          const res = await api.posts(
            {
              service: creator.service,
              creatorId: creator.creatorId,
              index: 0,
              host: watchStore.hostFor(creator.site),
            },
            controller.signal
          )
          if (api.isErrorResponse(res)) {
            untrackedFail += 1
          } else {
            const snap = snapshotFromPosts(creator.key, res)
            await snapshots.set(snap)
            this.snaps.set(creator.key, snap)
            untrackedOk += 1
          }
        } catch (e) {
          if (
            controller.signal.aborted ||
            (e as { name?: string })?.name === 'AbortError'
          ) {
            cancelled = true
            break
          }
          untrackedFail += 1
        }

        this.refreshState.done += 1
        if (this.route.view !== 'creator') {
          this.renderToolbarOnly()
          this.renderListContent()
        }
      }
    }

    const done = this.refreshState.done
    const total = this.refreshState.total
    this.refreshState = { running: false, done: 0, total: 0 }
    this.refreshAbort = null

    if (this.route.view !== 'creator') {
      this.renderToolbarOnly()
      this.renderListContent()
    }

    if (rateLimited) {
      this.showNotice(lang.transl('_wt_checkRateLimited'), true)
    } else if (cancelled) {
      this.showNotice(
        lang.transl('_w_refreshCancelled', String(done), String(total))
      )
    } else {
      const checkedTotal =
        (scanResult?.checked ?? 0) + untrackedOk + untrackedFail
      const newPosts = scanResult?.added.length ?? 0
      const failedTotal = (scanResult?.failed ?? 0) + untrackedFail
      this.showNotice(
        lang.transl(
          '_wt_checkSummary',
          String(checkedTotal),
          String(newPosts),
          String(failedTotal)
        ),
        failedTotal > 0
      )
    }
  }
}
