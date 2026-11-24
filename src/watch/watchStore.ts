/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Watchlist storage backed by chrome.storage.local with serialized writes
 * and cross-tab sync via chrome.storage.onChanged. */

import type { KemonoService, PostsApiResponse } from '../kemono/apiTypes'
import type { Rating } from './collectTypes'
import { applyBulkLabelsPatch, applyLabelsPatch } from './labels'
import {
  diffTracking,
  markRead as trackerMarkRead,
  startTracking,
} from './tracker'
import {
  emptyWatchData,
  sanitizePreviews,
  sortedFolders,
  validateWatchData,
} from './watchData'
import { DEFAULT_HOSTS, makeCreatorKey, siteOfHost } from './watchKey'
import {
  STORE_KEY,
  UNSORTED_FOLDER_ID,
  type AddedPost,
  type WatchCover,
  type WatchData,
  type WatchFolder,
  type WatchSite,
  type WatchedCreator,
} from './watchTypes'

export { STORE_KEY }

type ChangeListener = (data: WatchData) => void

export class WatchStore {
  private _data: WatchData = emptyWatchData()
  private listeners = new Set<ChangeListener>()
  private loadPromise: Promise<void> | null = null
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor() {
    if (typeof chrome !== 'undefined') {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !(STORE_KEY in changes)) return
        this._data = validateWatchData(changes[STORE_KEY].newValue)
        this.notify()
      })
    }
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb(this._data)
    }
  }

  ready(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await chrome.storage.local.get(STORE_KEY)
          this._data = validateWatchData(raw?.[STORE_KEY])
          this.notify()
        } catch (e) {
          console.error('[Better Pawchive] load watchlist failed', e)
        }
      })()
    }
    return this.loadPromise
  }

  get data(): WatchData {
    return this._data
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  getCreator(key: string): WatchedCreator | undefined {
    return this._data.creators[key]
  }

  isWatched(key: string): boolean {
    return Object.hasOwn(this._data.creators, key)
  }

  mutate(fn: (draft: WatchData) => void): Promise<WatchData> {
    const task = async (): Promise<WatchData> => {
      const raw = await chrome.storage.local.get(STORE_KEY)
      const current = validateWatchData(raw?.[STORE_KEY])
      const draft = structuredClone(current)
      fn(draft)
      const next = validateWatchData(draft)
      await chrome.storage.local.set({ [STORE_KEY]: next })
      this._data = next
      this.notify()
      return next
    }
    const run = this.writeChain.then(task, task)
    this.writeChain = run.catch(() => {})
    return run
  }

  async addCreator(
    input: {
      site: WatchSite
      service: KemonoService
      creatorId: string
      name: string
    },
    folderId?: string
  ): Promise<WatchedCreator> {
    const key = makeCreatorKey(input.site, input.service, input.creatorId)
    const next = await this.mutate((draft) => {
      const existing = draft.creators[key]
      if (existing) {
        if (
          folderId !== undefined &&
          draft.folders.some((f) => f.id === folderId)
        ) {
          existing.folderId = folderId
        }
        if (input.name) existing.name = input.name
      } else {
        draft.creators[key] = {
          key,
          site: input.site,
          service: input.service,
          creatorId: input.creatorId,
          name: input.name || input.creatorId,
          folderId: folderId ?? UNSORTED_FOLDER_ID,
          addedAt: Date.now(),
        }
      }
    })
    return next.creators[key]
  }

  async removeCreators(keys: string[]): Promise<void> {
    await this.mutate((draft) => {
      for (const key of keys) {
        delete draft.creators[key]
      }
    })
  }

  async moveCreators(keys: string[], folderId: string): Promise<void> {
    await this.mutate((draft) => {
      if (!draft.folders.some((f) => f.id === folderId)) return
      for (const key of keys) {
        const creator = draft.creators[key]
        if (creator) creator.folderId = folderId
      }
    })
  }

  async updateCreator(
    key: string,
    patch: {
      name?: string
      alias?: string | null
      note?: string | null
      cover?: WatchCover | null
      rating?: Rating | null
      tags?: string[] | null
      previews?: WatchCover[] | null
    }
  ): Promise<void> {
    await this.mutate((draft) => {
      const creator = draft.creators[key]
      if (!creator) return
      if (patch.name !== undefined) creator.name = patch.name
      if (patch.alias === null) delete creator.alias
      else if (patch.alias !== undefined) creator.alias = patch.alias
      if (patch.note === null) delete creator.note
      else if (patch.note !== undefined) creator.note = patch.note
      if (patch.cover === null) delete creator.cover
      else if (patch.cover !== undefined) creator.cover = patch.cover
      applyLabelsPatch(creator, patch)
      if (patch.previews === null) {
        delete creator.previews
      } else if (patch.previews !== undefined) {
        const sanitized = sanitizePreviews(patch.previews)
        if (sanitized) creator.previews = sanitized
        else delete creator.previews
      }
    })
  }

  async updateCreatorsLabels(
    keys: string[],
    patch: { addTags?: string[]; removeTags?: string[]; rating?: Rating | null }
  ): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      for (const key of keys) {
        const creator = draft.creators[key]
        if (creator) applyBulkLabelsPatch(creator, patch)
      }
    })
  }

  async addFolder(name: string): Promise<WatchFolder> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('empty folder name')
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
    const id = 'f_' + Date.now().toString(36) + rand
    const next = await this.mutate((draft) => {
      const maxOrder = draft.folders.reduce(
        (max, f) => Math.max(max, f.order),
        0
      )
      draft.folders.push({
        id,
        name: trimmed,
        order: maxOrder + 1,
        createdAt: Date.now(),
      })
    })
    return next.folders.find((f) => f.id === id)!
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (id === UNSORTED_FOLDER_ID || !trimmed) return
    await this.mutate((draft) => {
      const folder = draft.folders.find((f) => f.id === id)
      if (folder) folder.name = trimmed
    })
  }

  async deleteFolder(id: string): Promise<void> {
    if (id === UNSORTED_FOLDER_ID) return
    await this.mutate((draft) => {
      draft.folders = draft.folders.filter((f) => f.id !== id)
      for (const creator of Object.values(draft.creators)) {
        if (creator.folderId === id) {
          creator.folderId = UNSORTED_FOLDER_ID
        }
      }
    })
  }

  async reorderFolders(ids: string[]): Promise<void> {
    await this.mutate((draft) => {
      const byId = new Map(draft.folders.map((f) => [f.id, f]))
      const seen = new Set<string>()
      const ordered: WatchFolder[] = []
      for (const id of ids) {
        if (seen.has(id)) continue
        const folder = byId.get(id)
        if (folder) {
          seen.add(id)
          ordered.push(folder)
        }
      }
      const rest = sortedFolders(draft).filter((f) => !seen.has(f.id))
      const all = [...ordered, ...rest]
      all.forEach((folder, idx) => {
        folder.order = idx
      })
    })
  }

  async rememberHost(host: string): Promise<void> {
    const site = siteOfHost(host)
    if (!site) return
    await this.ready()
    if (this._data.hosts[site] === host) return
    await this.mutate((draft) => {
      draft.hosts[site] = host
    })
  }

  hostFor(site: WatchSite): string {
    return this._data.hosts[site] ?? DEFAULT_HOSTS[site]
  }

  async replaceAll(data: unknown): Promise<void> {
    const validated = validateWatchData(data)
    await this.mutate((draft) => {
      draft.version = validated.version
      draft.folders = validated.folders
      draft.creators = validated.creators
      draft.hosts = validated.hosts
    })
  }

  async enableTracking(
    input: {
      site: WatchSite
      service: KemonoService
      creatorId: string
      name: string
    },
    items: PostsApiResponse
  ): Promise<void> {
    const key = makeCreatorKey(input.site, input.service, input.creatorId)
    await this.mutate((draft) => {
      const now = Date.now()
      let creator = draft.creators[key]
      if (!creator) {
        creator = {
          key,
          site: input.site,
          service: input.service,
          creatorId: input.creatorId,
          name: input.name || input.creatorId,
          folderId: UNSORTED_FOLDER_ID,
          addedAt: now,
        }
        draft.creators[key] = creator
      } else if (input.name) {
        creator.name = input.name
      }
      creator.tracking = startTracking(items, now)
    })
  }

  async disableTracking(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      for (const key of keys) {
        const creator = draft.creators[key]
        if (creator) delete creator.tracking
      }
    })
  }

  async markRead(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      for (const key of keys) {
        const creator = draft.creators[key]
        if (creator?.tracking) {
          creator.tracking = trackerMarkRead(creator.tracking)
        }
      }
    })
  }

  async markPostsRead(key: string, postIds: string[]): Promise<void> {
    if (postIds.length === 0) return
    const idSet = new Set(postIds)
    await this.mutate((draft) => {
      const creator = draft.creators[key]
      if (!creator?.tracking) return
      creator.tracking.unread = creator.tracking.unread.filter(
        (p) => !idSet.has(p.id)
      )
    })
  }

  async applyCheckResults(
    results: Array<{
      key: string
      items?: PostsApiResponse
      error?: string
      name?: string
    }>,
    now = Date.now()
  ): Promise<AddedPost[]> {
    if (results.length === 0) return []
    const allAdded: AddedPost[] = []
    await this.mutate((draft) => {
      for (const res of results) {
        const creator = draft.creators[res.key]
        if (!creator?.tracking?.enabled) continue
        if (res.name) creator.name = res.name
        if (res.items !== undefined) {
          const { tracking, added } = diffTracking(
            creator.tracking,
            res.items,
            now
          )
          creator.tracking = tracking
          for (const post of added) allAdded.push({ ...post, key: res.key })
        } else if (res.error !== undefined) {
          creator.tracking.lastError = res.error
          creator.tracking.lastCheckedAt = now
        }
      }
    })
    return allAdded
  }
}

export const watchStore = new WatchStore()
