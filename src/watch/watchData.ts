/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure validation, sanitization, and query helpers for WatchData. */

import { MAX_PREVIEWS, normalizeTags, sanitizeRating } from './labels'
import { parseCreatorKey, siteOfHost } from './watchKey'
import {
  UNSORTED_FOLDER_ID,
  WATCH_SITES,
  type UnreadPost,
  type WatchCover,
  type WatchData,
  type WatchFolder,
  type WatchSite,
  type WatchTracking,
  type WatchedCreator,
} from './watchTypes'

const MAX_FOLDER_ID_LEN = 64
const MAX_FOLDER_NAME_LEN = 100
const MAX_CREATOR_NAME_LEN = 200
const MAX_ALIAS_LEN = 100
const MAX_NOTE_LEN = 5000
const MAX_SEEN_IDS = 200
const MAX_UNREAD = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function emptyWatchData(): WatchData {
  return {
    version: 1,
    folders: [{ id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 }],
    creators: {},
    hosts: {},
  }
}

export function sanitizeCover(raw: unknown): WatchCover | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'post') {
    if (typeof raw.path === 'string' && raw.path.startsWith('/')) {
      return { kind: 'post', path: raw.path }
    }
    return undefined
  }
  if (raw.kind === 'upload') {
    if (typeof raw.id === 'string' && raw.id.length > 0) {
      return { kind: 'upload', id: raw.id }
    }
    return undefined
  }
  return undefined
}

export function sanitizePreviews(raw: unknown): WatchCover[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const out: WatchCover[] = []
  for (const item of raw) {
    if (out.length >= MAX_PREVIEWS) break
    const cover = sanitizeCover(item)
    if (!cover) continue
    const dedupeKey =
      cover.kind === 'post' ? `p:${cover.path}` : `u:${cover.id}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(cover)
  }
  return out.length > 0 ? out : undefined
}

export function sanitizeFolders(raw: unknown): {
  folders: WatchFolder[]
  folderIds: Set<string>
} {
  const folders: WatchFolder[] = []
  const folderIds = new Set<string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue
      const { id, name, order, createdAt } = item
      if (
        typeof id !== 'string' ||
        !id ||
        id.length > MAX_FOLDER_ID_LEN ||
        folderIds.has(id)
      ) {
        continue
      }
      if (typeof name !== 'string') continue
      if (!isFiniteNumber(order)) continue
      folderIds.add(id)
      folders.push({
        id,
        name: name.trim().slice(0, MAX_FOLDER_NAME_LEN),
        order,
        createdAt: isFiniteNumber(createdAt) ? createdAt : 0,
      })
    }
  }
  if (!folderIds.has(UNSORTED_FOLDER_ID)) {
    folderIds.add(UNSORTED_FOLDER_ID)
    folders.unshift({
      id: UNSORTED_FOLDER_ID,
      name: '',
      order: 0,
      createdAt: 0,
    })
  }
  return { folders, folderIds }
}

function sanitizeUnread(raw: unknown): UnreadPost[] {
  if (!Array.isArray(raw)) return []
  const out: UnreadPost[] = []
  for (const item of raw) {
    if (out.length >= MAX_UNREAD) break
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || !item.id) continue
    const post: UnreadPost = {
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      published: typeof item.published === 'string' ? item.published : '',
    }
    if (typeof item.coverPath === 'string' && item.coverPath) {
      post.coverPath = item.coverPath
    }
    out.push(post)
  }
  return out
}

function sanitizeTracking(raw: unknown): WatchTracking | undefined {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return undefined
  const seenIds = Array.isArray(raw.seenIds)
    ? raw.seenIds
        .filter((x): x is string => typeof x === 'string')
        .slice(-MAX_SEEN_IDS)
    : []
  const tracking: WatchTracking = {
    enabled: raw.enabled,
    since: isFiniteNumber(raw.since) ? raw.since : 0,
    baselinePublished:
      typeof raw.baselinePublished === 'string' ? raw.baselinePublished : '',
    seenIds,
    unread: sanitizeUnread(raw.unread),
  }
  if (typeof raw.overflow === 'boolean') tracking.overflow = raw.overflow
  if (isFiniteNumber(raw.lastCheckedAt)) {
    tracking.lastCheckedAt = raw.lastCheckedAt
  }
  if (typeof raw.lastError === 'string') tracking.lastError = raw.lastError
  return tracking
}

export function validateWatchData(raw: unknown): WatchData {
  if (!isRecord(raw)) return emptyWatchData()

  const { folders, folderIds } = sanitizeFolders(raw.folders)

  const creators: Record<string, WatchedCreator> = {}
  if (isRecord(raw.creators)) {
    for (const [key, value] of Object.entries(raw.creators)) {
      const parsed = parseCreatorKey(key)
      if (!parsed || !isRecord(value)) continue
      if (
        value.site !== parsed.site ||
        value.service !== parsed.service ||
        value.creatorId !== parsed.creatorId
      ) {
        continue
      }
      const name =
        typeof value.name === 'string' && value.name
          ? value.name.slice(0, MAX_CREATOR_NAME_LEN)
          : parsed.creatorId
      const folderId =
        typeof value.folderId === 'string' && folderIds.has(value.folderId)
          ? value.folderId
          : UNSORTED_FOLDER_ID
      const addedAt = isFiniteNumber(value.addedAt) ? value.addedAt : 0

      const creator: WatchedCreator = {
        key,
        site: parsed.site,
        service: parsed.service,
        creatorId: parsed.creatorId,
        name,
        folderId,
        addedAt,
      }

      if (typeof value.alias === 'string') {
        const alias = value.alias.trim().slice(0, MAX_ALIAS_LEN)
        if (alias) creator.alias = alias
      }
      if (typeof value.note === 'string' && value.note) {
        creator.note = value.note.slice(0, MAX_NOTE_LEN)
      }
      const cover = sanitizeCover(value.cover)
      if (cover) creator.cover = cover
      const tracking = sanitizeTracking(value.tracking)
      if (tracking) creator.tracking = tracking
      const rating = sanitizeRating(value.rating)
      if (rating !== undefined) creator.rating = rating
      const tags = normalizeTags(value.tags)
      if (tags) creator.tags = tags
      const previews = sanitizePreviews(value.previews)
      if (previews) creator.previews = previews

      creators[key] = creator
    }
  }

  const hosts: Partial<Record<WatchSite, string>> = {}
  if (isRecord(raw.hosts)) {
    for (const site of WATCH_SITES) {
      const val = raw.hosts[site]
      if (typeof val === 'string' && siteOfHost(val) === site) {
        hosts[site] = val
      }
    }
  }

  return {
    version: 1,
    folders,
    creators,
    hosts,
  }
}

export function sortedFolders(data: { folders: WatchFolder[] }): WatchFolder[] {
  return [...data.folders].sort((a, b) => {
    if (a.id === UNSORTED_FOLDER_ID && b.id !== UNSORTED_FOLDER_ID) return -1
    if (b.id === UNSORTED_FOLDER_ID && a.id !== UNSORTED_FOLDER_ID) return 1
    if (a.order !== b.order) return a.order - b.order
    return a.createdAt - b.createdAt
  })
}

export function creatorsInFolder(
  data: WatchData,
  folderId: string
): WatchedCreator[] {
  return Object.values(data.creators).filter((c) => c.folderId === folderId)
}

export function totalUnread(data: WatchData): number {
  let count = 0
  for (const creator of Object.values(data.creators)) {
    if (creator.tracking?.enabled) {
      count += creator.tracking.unread.length
    }
  }
  return count
}
