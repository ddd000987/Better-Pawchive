/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Root state, hash router, refresh runner, and live-update orchestration for the watch page. */

import { EVT } from '../EVT'
import { api } from '../kemono/api'
import { lang } from '../Language'
import { runScan, type ScanResult } from '../watch/scanner'
import { snapshotFromPosts, snapshots } from '../watch/snapshot'
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
import { renderFeedToolbar, renderFeedView, type FeedCallbacks } from './feed'
import {
  filterCreators,
  parseRoute,
  sortCreators,
  type SortMode,
  type WatchRoute,
} from './listModel'
import { renderSidebar } from './sidebar'
import { renderToolbar, type RefreshState, type ViewMode } from './toolbar'
import { exportWatchlist, importWatchlist } from './transfer'

const VIEW_MODE_KEY = 'pawchiveProWatchView'

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
  private sort: SortMode = 'name'
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
    await watchStore.ready()
    await this.loadSnapshots()
    this.updateTitle()

    window.addEventListener('hashchange', () => {
      this.hasInternalHistory = true
      this.onRouteChange()
    })

    watchStore.onChange(() => {
      this.onStoreChange()
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

  private onRouteChange(): void {
    const next = parseRoute(location.hash)
    const prev = this.route
    this.route = next
    this.mobileMenuOpen = false

    // Clear selection when changing views
    if (
      prev.view !== next.view ||
      (prev.view === 'folder' &&
        next.view === 'folder' &&
        prev.folderId !== next.folderId)
    ) {
      this.selected.clear()
      this.lastSelectedKey = null
      this.selectMode = false
    }

    this.renderAll(true)
    window.scrollTo({ top: 0 })
  }

  private onStoreChange(): void {
    // Prune selection to existing creators
    const creators = watchStore.data.creators
    for (const k of Array.from(this.selected)) {
      if (!Object.hasOwn(creators, k)) this.selected.delete(k)
    }

    // Load snapshots for any newly added creators
    const missing = Object.keys(creators).filter((k) => !this.snaps.has(k))
    if (missing.length > 0) {
      void snapshots.getMany(missing).then((loaded) => {
        if (loaded.size === 0) return
        for (const [k, v] of loaded) this.snaps.set(k, v)
        if (this.route.view !== 'creator') {
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
    } else {
      const scrollY = window.scrollY
      this.renderToolbarOnly()
      this.renderListContent()
      window.scrollTo({ top: scrollY })
    }
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
    const filtered = filterCreators(base, this.query)
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
      route: this.route,
      mobileOpen: this.mobileMenuOpen,
      callbacks: {
        onNavigate: (hash) => this.navigate(hash),
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
        onDropCreators: async (draggedKey, folderId) => {
          const keys =
            this.selected.size > 0 && this.selected.has(draggedKey)
              ? Array.from(this.selected)
              : [draggedKey]
          await watchStore.moveCreators(keys, folderId)
          if (this.selected.has(draggedKey)) {
            this.selected.clear()
            this.lastSelectedKey = null
          }
        },
        onExport: () => {
          void exportWatchlist().then(() => {
            this.showNotice(lang.transl('_w_exportDone'))
          })
        },
        onImport: () => {
          importWatchlist((msg, isError) => this.showNotice(msg, isError))
        },
        onToggleMobileMenu: () => {
          this.mobileMenuOpen = !this.mobileMenuOpen
          this.renderSidebarOnly()
        },
      },
    })
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
    const visible = this.visibleCreators()
    renderToolbar(this.toolbarEl, {
      data: watchStore.data,
      title: this.currentListTitle(),
      query: this.query,
      sort: this.sort,
      view: this.view,
      selectMode: this.selectMode,
      selectedCount: this.selected.size,
      visibleCount: visible.length,
      refresh: this.refreshState,
      callbacks: {
        onSearchChange: (q) => {
          this.query = q
          this.renderListContent()
        },
        onSortChange: (mode) => {
          this.sort = mode
          this.renderListContent()
        },
        onViewChange: (mode) => {
          this.view = mode
          saveViewMode(mode)
          this.renderToolbarOnly()
          this.renderListContent()
        },
        onToggleSelect: () => {
          this.selectMode = !this.selectMode
          if (!this.selectMode) {
            this.selected.clear()
            this.lastSelectedKey = null
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
          await watchStore.moveCreators(keys, folderId)
        },
        onBulkRemove: async () => {
          const keys = Array.from(this.selected)
          this.selected.clear()
          this.lastSelectedKey = null
          await watchStore.removeCreators(keys)
        },
        onClearSelection: () => {
          this.selected.clear()
          this.lastSelectedKey = null
          this.renderToolbarOnly()
          this.renderListContent()
        },
      },
    })
  }

  private renderListContent(): void {
    if (this.route.view === 'feed') {
      renderFeedView(this.contentEl, watchStore.data, this.feedCallbacks())
      return
    }
    const visible = this.visibleCreators()
    renderCreatorList(this.contentEl, {
      creators: visible,
      totalInWatchlist: Object.keys(watchStore.data.creators).length,
      hasQuery: this.query.trim().length > 0,
      emptyMessage: this.currentEmptyMessage(),
      snaps: this.snaps,
      view: this.view,
      selectMode: this.selectMode,
      selected: this.selected,
      callbacks: {
        onOpenCreator: (key) => {
          this.navigate(`#/creator/${encodeURIComponent(key)}`)
        },
        onToggleSelect: (key, shiftKey) => {
          if (shiftKey && this.lastSelectedKey) {
            const keys = visible.map((c) => c.key)
            const start = keys.indexOf(this.lastSelectedKey)
            const end = keys.indexOf(key)
            if (start !== -1 && end !== -1) {
              const [lo, hi] = start < end ? [start, end] : [end, start]
              for (let i = lo; i <= hi; i++) {
                this.selected.add(keys[i])
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

    // If folder route refers to missing folder, redirect to all
    const activeRoute = this.route
    if (
      activeRoute.view === 'folder' &&
      activeRoute.folderId !== UNSORTED_FOLDER_ID &&
      !watchStore.data.folders.some((f) => f.id === activeRoute.folderId)
    ) {
      this.route = { view: 'all' }
      history.replaceState(null, '', '#/all')
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
