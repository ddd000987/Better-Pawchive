/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Creator post snapshots stored per creator in chrome.storage.local. */

import type { PostsApiItem, PostsApiResponse } from '../kemono/apiTypes'
import { isImageFile } from '../kemono/fileType'
import type { CreatorSnapshot, SnapshotPost } from './watchTypes'

const SNAP_PREFIX = 'pawchiveProWatchSnap:'
const MAX_SNAPSHOT_POSTS = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateSnapshot(
  raw: unknown,
  expectedKey?: string
): CreatorSnapshot | undefined {
  if (!isRecord(raw)) return undefined
  if (typeof raw.key !== 'string' || !raw.key) return undefined
  if (expectedKey !== undefined && raw.key !== expectedKey) return undefined
  if (typeof raw.fetchedAt !== 'number' || !Number.isFinite(raw.fetchedAt)) {
    return undefined
  }
  if (!Array.isArray(raw.posts)) return undefined

  const posts: SnapshotPost[] = []
  for (const item of raw.posts) {
    if (posts.length >= MAX_SNAPSHOT_POSTS) break
    if (!isRecord(item)) continue
    if (typeof item.id !== 'string' || !item.id) continue
    const post: SnapshotPost = {
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      published: typeof item.published === 'string' ? item.published : '',
    }
    if (typeof item.coverPath === 'string' && item.coverPath) {
      post.coverPath = item.coverPath
    }
    posts.push(post)
  }

  return {
    key: raw.key,
    fetchedAt: raw.fetchedAt,
    posts,
  }
}

export function postCoverPath(item: PostsApiItem): string | undefined {
  if (
    item.file &&
    typeof item.file.path === 'string' &&
    item.file.path &&
    isImageFile(item.file)
  ) {
    return item.file.path
  }
  if (Array.isArray(item.attachments)) {
    for (const att of item.attachments) {
      if (att && typeof att.path === 'string' && att.path && isImageFile(att)) {
        return att.path
      }
    }
  }
  return undefined
}

export function snapshotFromPosts(
  key: string,
  items: PostsApiResponse,
  now = Date.now()
): CreatorSnapshot {
  const posts: SnapshotPost[] = []
  for (const item of items) {
    if (posts.length >= MAX_SNAPSHOT_POSTS) break
    if (!item || typeof item.id !== 'string' || !item.id) continue

    const coverPath = postCoverPath(item)

    const post: SnapshotPost = {
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      published: typeof item.published === 'string' ? item.published : '',
    }
    if (coverPath) post.coverPath = coverPath
    posts.push(post)
  }

  return {
    key,
    fetchedAt: now,
    posts,
  }
}

export function isSnapshotStale(
  snap: CreatorSnapshot | undefined,
  maxAgeMs: number,
  now = Date.now()
): boolean {
  if (!snap) return true
  return now - snap.fetchedAt >= maxAgeMs
}

export const snapshots = {
  async get(key: string): Promise<CreatorSnapshot | undefined> {
    const storageKey = SNAP_PREFIX + key
    const res = await chrome.storage.local.get(storageKey)
    return validateSnapshot(res?.[storageKey], key)
  },

  async getMany(keys: string[]): Promise<Map<string, CreatorSnapshot>> {
    const out = new Map<string, CreatorSnapshot>()
    if (keys.length === 0) return out
    const storageKeys = keys.map((k) => SNAP_PREFIX + k)
    const res = await chrome.storage.local.get(storageKeys)
    for (const key of keys) {
      const snap = validateSnapshot(res?.[SNAP_PREFIX + key], key)
      if (snap) out.set(key, snap)
    }
    return out
  },

  async set(snap: CreatorSnapshot): Promise<void> {
    await chrome.storage.local.set({ [SNAP_PREFIX + snap.key]: snap })
  },

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    await chrome.storage.local.remove(keys.map((k) => SNAP_PREFIX + k))
  },
}
