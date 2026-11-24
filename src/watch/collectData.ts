/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure validation and sanitization helpers for favorite posts and favorite images. */

import { isKemonoService } from '../kemono/pages'
import type { CollectData, FavImage, FavPost } from './collectTypes'
import { normalizeTags, sanitizeRating } from './labels'
import { sanitizeFolders } from './watchData'
import { IMAGE_PATH_RE, makeFavImageKey, makeFavPostKey } from './watchKey'
import { UNSORTED_FOLDER_ID, WATCH_SITES, type WatchSite } from './watchTypes'

const MAX_TITLE_LEN = 500
const MAX_NAME_LEN = 200
const MAX_FILENAME_LEN = 300
const MAX_NOTE_LEN = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidIdPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/')
}

export function emptyCollectData<T>(): CollectData<T> {
  return {
    version: 1,
    folders: [{ id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 }],
    items: {},
  }
}

export function validateFavPosts(raw: unknown): CollectData<FavPost> {
  if (!isRecord(raw)) return emptyCollectData<FavPost>()

  const { folders, folderIds } = sanitizeFolders(raw.folders)
  const items: Record<string, FavPost> = {}

  if (isRecord(raw.items)) {
    for (const [key, value] of Object.entries(raw.items)) {
      if (!isRecord(value)) continue
      if (
        typeof value.site !== 'string' ||
        !WATCH_SITES.includes(value.site as WatchSite) ||
        typeof value.service !== 'string' ||
        !isKemonoService(value.service) ||
        !isValidIdPart(value.creatorId) ||
        !isValidIdPart(value.postId)
      ) {
        continue
      }

      const site = value.site as WatchSite
      const expectedKey = makeFavPostKey(
        site,
        value.service,
        value.creatorId,
        value.postId
      )
      if (key !== expectedKey) continue

      const folderId =
        typeof value.folderId === 'string' && folderIds.has(value.folderId)
          ? value.folderId
          : UNSORTED_FOLDER_ID
      const addedAt = isFiniteNumber(value.addedAt) ? value.addedAt : 0

      const post: FavPost = {
        key: expectedKey,
        site,
        service: value.service,
        creatorId: value.creatorId,
        postId: value.postId,
        title:
          typeof value.title === 'string'
            ? value.title.slice(0, MAX_TITLE_LEN)
            : '',
        creatorName:
          typeof value.creatorName === 'string'
            ? value.creatorName.slice(0, MAX_NAME_LEN)
            : '',
        folderId,
        addedAt,
      }

      if (typeof value.published === 'string' && value.published) {
        post.published = value.published
      }
      if (
        typeof value.coverPath === 'string' &&
        IMAGE_PATH_RE.test(value.coverPath)
      ) {
        post.coverPath = value.coverPath
      }
      if (typeof value.note === 'string') {
        const note = value.note.trim().slice(0, MAX_NOTE_LEN)
        if (note) post.note = note
      }
      const rating = sanitizeRating(value.rating)
      if (rating !== undefined) post.rating = rating
      const tags = normalizeTags(value.tags)
      if (tags) post.tags = tags

      items[expectedKey] = post
    }
  }

  return { version: 1, folders, items }
}

export function validateFavImages(raw: unknown): CollectData<FavImage> {
  if (!isRecord(raw)) return emptyCollectData<FavImage>()

  const { folders, folderIds } = sanitizeFolders(raw.folders)
  const items: Record<string, FavImage> = {}

  if (isRecord(raw.items)) {
    for (const [key, value] of Object.entries(raw.items)) {
      if (!isRecord(value)) continue
      if (
        typeof value.site !== 'string' ||
        !WATCH_SITES.includes(value.site as WatchSite) ||
        typeof value.path !== 'string' ||
        !IMAGE_PATH_RE.test(value.path) ||
        typeof value.service !== 'string' ||
        !isKemonoService(value.service) ||
        !isValidIdPart(value.creatorId) ||
        !isValidIdPart(value.postId)
      ) {
        continue
      }

      const site = value.site as WatchSite
      const expectedKey = makeFavImageKey(site, value.path)
      if (key !== expectedKey) continue

      const folderId =
        typeof value.folderId === 'string' && folderIds.has(value.folderId)
          ? value.folderId
          : UNSORTED_FOLDER_ID
      const addedAt = isFiniteNumber(value.addedAt) ? value.addedAt : 0

      const image: FavImage = {
        key: expectedKey,
        site,
        path: value.path,
        service: value.service,
        creatorId: value.creatorId,
        postId: value.postId,
        folderId,
        addedAt,
      }

      if (typeof value.fileName === 'string' && value.fileName) {
        image.fileName = value.fileName.slice(0, MAX_FILENAME_LEN)
      }
      if (typeof value.postTitle === 'string' && value.postTitle) {
        image.postTitle = value.postTitle.slice(0, MAX_TITLE_LEN)
      }
      if (typeof value.creatorName === 'string' && value.creatorName) {
        image.creatorName = value.creatorName.slice(0, MAX_NAME_LEN)
      }
      if (typeof value.note === 'string') {
        const note = value.note.trim().slice(0, MAX_NOTE_LEN)
        if (note) image.note = note
      }
      const rating = sanitizeRating(value.rating)
      if (rating !== undefined) image.rating = rating
      const tags = normalizeTags(value.tags)
      if (tags) image.tags = tags

      items[expectedKey] = image
    }
  }

  return { version: 1, folders, items }
}
