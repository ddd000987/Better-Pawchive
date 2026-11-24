/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Data types of the watchlist: the extension's own list of followed
 * creators, sorted into folders, with optional tracking of new posts.
 * Everything here lives in the browser only (chrome.storage.local and
 * IndexedDB); nothing is sent anywhere. */

import type { KemonoService } from '../kemono/apiTypes'

/** Site family. kemono.su / kemono.party / kemono.cr all count as 'kemono' */
export type WatchSite = 'pawchive' | 'kemono'

export const WATCH_SITES: readonly WatchSite[] = ['pawchive', 'kemono']

/** chrome.storage.local key holding WatchData */
export const STORE_KEY = 'pawchiveProWatchlist'

/** The folder every creator falls back to. It cannot be deleted or renamed;
 * its display name comes from the locale files. */
export const UNSORTED_FOLDER_ID = 'unsorted'

export interface WatchFolder {
  id: string
  name: string
  /** Sort position in the sidebar, ascending */
  order: number
  createdAt: number
}

/** A custom cover: a picture from one of the creator's posts (stored as a
 * file path, so it does not depend on the host), or an image the user
 * uploaded (stored in IndexedDB under `id`). */
export type WatchCover =
  { kind: 'post'; path: string } | { kind: 'upload'; id: string }

/** A post found by tracking that the user has not read yet */
export interface UnreadPost {
  id: string
  title: string
  /** As the API gives it (ISO-like date string) */
  published: string
  /** File path of the post's cover image, if it has one */
  coverPath?: string
}

/** A new post found by a check, with the creator it belongs to */
export interface AddedPost extends UnreadPost {
  key: string
}

export interface WatchTracking {
  enabled: boolean
  /** When tracking was turned on (ms) */
  since: number
  /** Newest `published` seen so far; '' until the first check */
  baselinePublished: string
  /** Post ids seen on the newest page at the last check (capped) */
  seenIds: string[]
  unread: UnreadPost[]
  /** The whole newest page was new at some check: show "50+" */
  overflow?: boolean
  lastCheckedAt?: number
  /** Last check failed; cleared by the next good check */
  lastError?: string
}

export interface WatchedCreator {
  /** `${site}/${service}/${creatorId}` */
  key: string
  site: WatchSite
  service: KemonoService
  creatorId: string
  /** Name from the site, refreshed when the creator is fetched again */
  name: string
  alias?: string
  note?: string
  cover?: WatchCover
  folderId: string
  addedAt: number
  tracking?: WatchTracking
}

/** Everything stored under the watchlist storage key */
export interface WatchData {
  version: 1
  folders: WatchFolder[]
  creators: Record<string, WatchedCreator>
  /** Host last seen for each site (API and image hosts are built from it) */
  hosts: Partial<Record<WatchSite, string>>
}

/** One post in a creator snapshot (a light copy of the newest page) */
export interface SnapshotPost {
  id: string
  title: string
  published: string
  coverPath?: string
}

/** Light copy of a creator's newest page of posts, so the watch page can
 * draw without sending requests */
export interface CreatorSnapshot {
  key: string
  fetchedAt: number
  posts: SnapshotPost[]
}
