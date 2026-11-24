/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Generic collection storage backed by chrome.storage.local with serialized
 * writes and cross-tab sync via chrome.storage.onChanged. */

import {
  emptyCollectData,
  validateFavImages,
  validateFavPosts,
} from './collectData'
import {
  FAV_IMAGES_KEY,
  FAV_POSTS_KEY,
  type CollectData,
  type FavImage,
  type FavPost,
  type Labels,
  type Rating,
} from './collectTypes'
import { applyBulkLabelsPatch, applyLabelsPatch } from './labels'
import { sortedFolders } from './watchData'
import { UNSORTED_FOLDER_ID, type WatchFolder } from './watchTypes'

type ChangeListener<T> = (data: CollectData<T>) => void

export class CollectStore<
  T extends {
    key: string
    folderId: string
    addedAt: number
    note?: string
  } & Labels,
> {
  private _data: CollectData<T> = emptyCollectData<T>()
  private listeners = new Set<ChangeListener<T>>()
  private loadPromise: Promise<void> | null = null
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storageKey: string,
    private readonly validate: (raw: unknown) => CollectData<T>
  ) {
    if (typeof chrome !== 'undefined') {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== 'local' || !(this.storageKey in changes)) return
        this._data = this.validate(changes[this.storageKey].newValue)
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
          const raw = await chrome.storage.local.get(this.storageKey)
          this._data = this.validate(raw?.[this.storageKey])
          this.notify()
        } catch (e) {
          console.error(`[PawchivePro] load ${this.storageKey} failed`, e)
        }
      })()
    }
    return this.loadPromise
  }

  get data(): CollectData<T> {
    return this._data
  }

  onChange(cb: ChangeListener<T>): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  has(key: string): boolean {
    return Object.hasOwn(this._data.items, key)
  }

  get(key: string): T | undefined {
    return this._data.items[key]
  }

  mutate(fn: (draft: CollectData<T>) => void): Promise<CollectData<T>> {
    const task = async (): Promise<CollectData<T>> => {
      const raw = await chrome.storage.local.get(this.storageKey)
      const current = this.validate(raw?.[this.storageKey])
      const draft = structuredClone(current)
      fn(draft)
      const next = this.validate(draft)
      await chrome.storage.local.set({ [this.storageKey]: next })
      this._data = next
      this.notify()
      return next
    }
    const run = this.writeChain.then(task, task)
    this.writeChain = run.catch(() => {})
    return run
  }

  async add(
    item: Omit<T, 'folderId' | 'addedAt'> & { folderId?: string },
    folderId?: string
  ): Promise<T> {
    const targetFolder = folderId ?? item.folderId
    const next = await this.mutate((draft) => {
      const existing = draft.items[item.key]
      if (existing) {
        if (
          targetFolder !== undefined &&
          draft.folders.some((f) => f.id === targetFolder)
        ) {
          existing.folderId = targetFolder
        }
        const rec = item as Record<string, unknown>
        const existingRec = existing as Record<string, unknown>
        for (const [k, v] of Object.entries(rec)) {
          if (
            k === 'folderId' ||
            k === 'addedAt' ||
            k === 'rating' ||
            k === 'tags' ||
            k === 'note'
          ) {
            continue
          }
          if (v !== undefined) {
            existingRec[k] = v
          }
        }
      } else {
        const resolvedFolder =
          targetFolder !== undefined &&
          draft.folders.some((f) => f.id === targetFolder)
            ? targetFolder
            : UNSORTED_FOLDER_ID
        draft.items[item.key] = {
          ...item,
          folderId: resolvedFolder,
          addedAt: Date.now(),
        } as T
      }
    })
    return next.items[item.key]
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      for (const key of keys) {
        delete draft.items[key]
      }
    })
  }

  async move(keys: string[], folderId: string): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      if (!draft.folders.some((f) => f.id === folderId)) return
      for (const key of keys) {
        const item = draft.items[key]
        if (item) item.folderId = folderId
      }
    })
  }

  async update(
    key: string,
    patch: {
      note?: string | null
      rating?: Rating | null
      tags?: string[] | null
    }
  ): Promise<void> {
    await this.mutate((draft) => {
      const item = draft.items[key]
      if (!item) return
      if (patch.note === null) delete item.note
      else if (patch.note !== undefined) item.note = patch.note
      applyLabelsPatch(item, patch)
    })
  }

  async updateMany(
    keys: string[],
    patch: { addTags?: string[]; removeTags?: string[]; rating?: Rating | null }
  ): Promise<void> {
    if (keys.length === 0) return
    await this.mutate((draft) => {
      for (const key of keys) {
        const item = draft.items[key]
        if (item) applyBulkLabelsPatch(item, patch)
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
      for (const item of Object.values(draft.items)) {
        if (item.folderId === id) {
          item.folderId = UNSORTED_FOLDER_ID
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

  async replaceAll(raw: unknown): Promise<void> {
    const validated = this.validate(raw)
    await this.mutate((draft) => {
      draft.version = validated.version
      draft.folders = validated.folders
      draft.items = validated.items
    })
  }

  itemsInFolder(folderId: string): T[] {
    return Object.values(this._data.items)
      .filter((item) => item.folderId === folderId)
      .sort((a, b) => b.addedAt - a.addedAt)
  }
}

export const favPosts = new CollectStore<FavPost>(
  FAV_POSTS_KEY,
  validateFavPosts
)
export const favImages = new CollectStore<FavImage>(
  FAV_IMAGES_KEY,
  validateFavImages
)
