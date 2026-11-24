/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Watchlist button and folder popover mounted on creator pages. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import { api } from '../kemono/api'
import type { KemonoService } from '../kemono/apiTypes'
import { detectPage, MOUNT } from '../kemono/pages'
import { isSnapshotStale, snapshotFromPosts, snapshots } from './snapshot'
import { sortedFolders } from './watchData'
import { makeCreatorKey, siteOfHost } from './watchKey'
import { watchStore } from './watchStore'
import {
  UNSORTED_FOLDER_ID,
  type WatchFolder,
  type WatchSite,
} from './watchTypes'

const MOUNT_WAIT_MS = 10_000
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000

interface PageCreator {
  site: WatchSite
  service: KemonoService
  creatorId: string
  key: string
}

function folderDisplayName(folder: WatchFolder | undefined): string {
  if (!folder || folder.id === UNSORTED_FOLDER_ID) {
    return lang.transl('_w_unsorted')
  }
  return folder.name
}

async function resolveCreatorName(
  service: KemonoService,
  creatorId: string
): Promise<string> {
  try {
    const profile = await api.profile({ service, creatorId })
    if (!api.isErrorResponse(profile) && profile?.name) {
      return profile.name
    }
  } catch {
    // Fall back to DOM name or creatorId
  }
  return (
    document.querySelector('.user-header__name')?.textContent?.trim() ||
    creatorId
  )
}

class WatchButton {
  private gen = 0
  private current: PageCreator | null = null
  private btn: HTMLButtonElement | null = null
  private trackBtn: HTMLButtonElement | null = null
  private row: HTMLElement | null = null
  private trackBusy = false
  private menu: HTMLDivElement | null = null
  private observer: MutationObserver | null = null
  private mountTimer = 0
  private onDocPointerDown: ((ev: MouseEvent) => void) | null = null
  private onWinKeyDown: ((ev: KeyboardEvent) => void) | null = null

  constructor() {
    if (typeof document === 'undefined') return
    EVT.on(EVT.list.pageSwitch, () => this.onPage())
    EVT.on(EVT.list.langChange, () => this.updateButton())
    watchStore.onChange(() => this.updateButton())
    this.onPage()
  }

  private onPage(): void {
    const gen = ++this.gen
    this.disconnectMountWait()
    this.closeMenu()
    this.removeButton()
    this.current = null

    const page = detectPage()
    const site = siteOfHost(location.host)
    if (page.kind !== 'creator' || !site) return

    const target: PageCreator = {
      site,
      service: page.service,
      creatorId: page.creatorId,
      key: makeCreatorKey(site, page.service, page.creatorId),
    }
    this.current = target
    this.waitForMount(gen, target)
    void this.refreshSnapshotIfWatched(gen, target)
  }

  private waitForMount(gen: number, target: PageCreator): void {
    const existing = document.querySelector<HTMLElement>(MOUNT.creator)
    if (existing) {
      this.mountButton(existing, target)
      return
    }
    const observer = new MutationObserver(() => {
      if (gen !== this.gen) {
        this.disconnectMountWait()
        return
      }
      const mount = document.querySelector<HTMLElement>(MOUNT.creator)
      if (mount) {
        this.disconnectMountWait()
        this.mountButton(mount, target)
      }
    })
    this.observer = observer
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    this.mountTimer = window.setTimeout(() => {
      this.disconnectMountWait()
    }, MOUNT_WAIT_MS)
  }

  private disconnectMountWait(): void {
    this.observer?.disconnect()
    this.observer = null
    if (this.mountTimer) {
      window.clearTimeout(this.mountTimer)
      this.mountTimer = 0
    }
  }

  private mountButton(actions: HTMLElement, target: PageCreator): void {
    this.removeButton()
    // Our buttons get their own row right below the site's action row
    for (const stale of document.querySelectorAll('.pwpWatchRow')) {
      stale.remove()
    }
    const mount = document.createElement('div')
    mount.className = 'pwpWatchRow'
    markTransient(mount)
    actions.after(mount)
    this.row = mount
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pwpWatchBtn'
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (this.menu) {
        this.closeMenu()
      } else {
        this.openMenu(target)
      }
    })
    markTransient(btn)
    mount.appendChild(btn)
    this.btn = btn

    const trackBtn = document.createElement('button')
    trackBtn.type = 'button'
    trackBtn.className = 'pwpTrackBtn'
    trackBtn.setAttribute('aria-pressed', 'false')
    trackBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      void this.toggleTracking(target)
    })
    markTransient(trackBtn)
    mount.appendChild(trackBtn)
    this.trackBtn = trackBtn

    this.updateButton()
  }

  private removeButton(): void {
    this.row?.remove()
    this.row = null
    this.btn?.remove()
    this.btn = null
    this.trackBtn?.remove()
    this.trackBtn = null
    this.trackBusy = false
  }

  private updateButton(): void {
    if (!this.btn || !this.current) return
    const creator = watchStore.getCreator(this.current.key)
    if (creator) {
      const folder = watchStore.data.folders.find(
        (f) => f.id === creator.folderId
      )
      this.btn.textContent = `★ ${lang.transl('_ws_watching', folderDisplayName(folder))}`
      this.btn.classList.add('is-watched')
    } else {
      this.btn.textContent = `☆ ${lang.transl('_ws_watch')}`
      this.btn.classList.remove('is-watched')
    }

    if (this.trackBtn) {
      const tracked = creator?.tracking?.enabled === true
      this.trackBtn.textContent = `🔔 ${lang.transl(tracked ? '_wt_tracking' : '_wt_track')}`
      this.trackBtn.classList.toggle('is-tracking', tracked)
      this.trackBtn.setAttribute('aria-pressed', String(tracked))
      this.trackBtn.disabled = this.trackBusy
    }
  }

  private async toggleTracking(target: PageCreator): Promise<void> {
    if (this.trackBusy) return
    this.trackBusy = true
    this.updateButton()
    try {
      const existing = watchStore.getCreator(target.key)
      if (existing?.tracking?.enabled) {
        await watchStore.disableTracking([target.key])
        toast.success(lang.transl('_wt_trackDisabled'))
      } else {
        const posts = await api.posts({
          service: target.service,
          creatorId: target.creatorId,
        })
        if (api.isErrorResponse(posts) || !Array.isArray(posts)) {
          const msg = api.isErrorResponse(posts)
            ? posts.error
            : 'invalid response'
          toast.error(lang.transl('_wt_trackFailed', msg))
          return
        }
        const name =
          existing?.name ||
          (await resolveCreatorName(target.service, target.creatorId))
        await watchStore.enableTracking(
          {
            site: target.site,
            service: target.service,
            creatorId: target.creatorId,
            name,
          },
          posts
        )
        void snapshots.set(snapshotFromPosts(target.key, posts)).catch(() => {})
        toast.success(lang.transl('_wt_trackEnabled'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(lang.transl('_wt_trackFailed', msg))
    } finally {
      this.trackBusy = false
      this.updateButton()
    }
  }

  private openMenu(target: PageCreator): void {
    if (!this.btn) return
    this.closeMenu()

    const menu = document.createElement('div')
    menu.className = 'pwpWatchMenu'
    menu.setAttribute('role', 'menu')
    menu.lang = lang.htmlLang()
    markTransient(menu)

    const watched = watchStore.getCreator(target.key)
    const folders = sortedFolders(watchStore.data)

    for (const folder of folders) {
      const label = folderDisplayName(folder)
      const isCurrent = watched?.folderId === folder.id
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'pwpWatchMenu-item'
      item.setAttribute('role', 'menuitem')
      if (isCurrent) {
        item.classList.add('is-active')
        item.setAttribute('aria-current', 'true')
      }
      const mark = document.createElement('span')
      mark.className = 'pwpWatchMenu-mark'
      mark.textContent = isCurrent ? '✓' : ''
      const text = document.createElement('span')
      text.className = 'pwpWatchMenu-label'
      text.textContent = label
      item.append(mark, text)
      item.addEventListener('click', () => {
        void this.addToFolder(target, folder.id, label)
      })
      menu.appendChild(item)
    }

    const sep1 = document.createElement('div')
    sep1.className = 'pwpWatchMenu-sep'
    menu.appendChild(sep1)

    const newFolderSlot = document.createElement('div')
    newFolderSlot.className = 'pwpWatchMenu-newSlot'
    const newFolderBtn = document.createElement('button')
    newFolderBtn.type = 'button'
    newFolderBtn.className = 'pwpWatchMenu-item'
    newFolderBtn.setAttribute('role', 'menuitem')
    newFolderBtn.textContent = lang.transl('_ws_newFolder')
    newFolderBtn.addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'pwpWatchMenu-input'
      input.placeholder = lang.transl('_w_folderNamePlaceholder')
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          const name = input.value.trim()
          if (!name) return
          void this.createFolderAndAdd(target, name)
        } else if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          this.closeMenu()
        }
      })
      newFolderSlot.replaceChildren(input)
      input.focus()
    })
    newFolderSlot.appendChild(newFolderBtn)
    menu.appendChild(newFolderSlot)

    if (watched) {
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'pwpWatchMenu-item is-danger'
      removeBtn.setAttribute('role', 'menuitem')
      removeBtn.textContent = lang.transl('_w_removeSelected')
      removeBtn.addEventListener('click', () => {
        void this.removeFromWatch(target)
      })
      menu.appendChild(removeBtn)
    }

    const sep2 = document.createElement('div')
    sep2.className = 'pwpWatchMenu-sep'
    menu.appendChild(sep2)

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.className = 'pwpWatchMenu-item'
    openBtn.setAttribute('role', 'menuitem')
    openBtn.textContent = lang.transl('_ws_openWatchPage')
    openBtn.addEventListener('click', () => {
      this.closeMenu()
      void chrome.runtime.sendMessage({ msg: 'watch_open' })
    })
    menu.appendChild(openBtn)

    document.body.appendChild(menu)
    this.menu = menu
    this.btn.setAttribute('aria-expanded', 'true')
    this.positionMenu(menu, this.btn)

    this.onDocPointerDown = (ev: MouseEvent) => {
      const node = ev.target as Node | null
      if (node && (menu.contains(node) || this.btn?.contains(node))) return
      this.closeMenu()
    }
    this.onWinKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.closeMenu()
      }
    }
    document.addEventListener('mousedown', this.onDocPointerDown, true)
    window.addEventListener('keydown', this.onWinKeyDown, true)
  }

  private positionMenu(menu: HTMLDivElement, btn: HTMLButtonElement): void {
    const r = btn.getBoundingClientRect()
    const w = menu.offsetWidth
    const h = menu.offsetHeight
    const pad = 8
    const left = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad))
    let top = r.bottom + 4
    if (top + h > window.innerHeight - pad && r.top - h - 4 >= pad) {
      top = r.top - h - 4
    }
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  private closeMenu(): void {
    if (this.onDocPointerDown) {
      document.removeEventListener('mousedown', this.onDocPointerDown, true)
      this.onDocPointerDown = null
    }
    if (this.onWinKeyDown) {
      window.removeEventListener('keydown', this.onWinKeyDown, true)
      this.onWinKeyDown = null
    }
    this.menu?.remove()
    this.menu = null
    this.btn?.setAttribute('aria-expanded', 'false')
  }

  private async addToFolder(
    target: PageCreator,
    folderId: string,
    folderLabel: string
  ): Promise<void> {
    this.closeMenu()
    try {
      const name = await resolveCreatorName(target.service, target.creatorId)
      await watchStore.addCreator(
        {
          site: target.site,
          service: target.service,
          creatorId: target.creatorId,
          name,
        },
        folderId
      )
      toast.success(lang.transl('_ws_added', folderLabel))
      void this.fetchAndSaveSnapshot(target)
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    }
  }

  private async createFolderAndAdd(
    target: PageCreator,
    folderName: string
  ): Promise<void> {
    this.closeMenu()
    try {
      const folder = await watchStore.addFolder(folderName)
      const name = await resolveCreatorName(target.service, target.creatorId)
      await watchStore.addCreator(
        {
          site: target.site,
          service: target.service,
          creatorId: target.creatorId,
          name,
        },
        folder.id
      )
      toast.success(lang.transl('_ws_added', folder.name))
      void this.fetchAndSaveSnapshot(target)
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    }
  }

  private async removeFromWatch(target: PageCreator): Promise<void> {
    this.closeMenu()
    try {
      await watchStore.removeCreators([target.key])
      await snapshots.remove([target.key]).catch(() => {})
      toast.success(lang.transl('_ws_removed'))
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    }
  }

  private async refreshSnapshotIfWatched(
    gen: number,
    target: PageCreator
  ): Promise<void> {
    try {
      await watchStore.ready()
      if (gen !== this.gen) return
      const creator = watchStore.getCreator(target.key)
      if (!creator) return
      const isTracked = creator.tracking?.enabled === true

      if (isTracked) {
        try {
          const posts = await api.posts({
            service: target.service,
            creatorId: target.creatorId,
          })
          if (!api.isErrorResponse(posts) && Array.isArray(posts)) {
            await snapshots
              .set(snapshotFromPosts(target.key, posts))
              .catch(() => {})
            await watchStore.applyCheckResults([
              { key: target.key, items: posts },
            ])
          }
        } catch (err) {
          console.warn('[PawchivePro] refresh tracked creator failed', err)
        } finally {
          await watchStore.markRead([target.key]).catch(() => {})
        }
        return
      }

      const existing = await snapshots.get(target.key)
      if (gen !== this.gen) return
      if (!isSnapshotStale(existing, SNAPSHOT_MAX_AGE_MS)) return
      await this.fetchAndSaveSnapshot(target)
    } catch (err) {
      console.warn('[PawchivePro] refresh watch snapshot failed', err)
    }
  }

  private async fetchAndSaveSnapshot(target: PageCreator): Promise<void> {
    try {
      const posts = await api.posts({
        service: target.service,
        creatorId: target.creatorId,
      })
      if (api.isErrorResponse(posts) || !Array.isArray(posts)) return
      await snapshots.set(snapshotFromPosts(target.key, posts))
    } catch (err) {
      console.warn('[PawchivePro] save watch snapshot failed', err)
    }
  }
}

export const watchButton = new WatchButton()
