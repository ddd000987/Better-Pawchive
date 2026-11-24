/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Data types for favorite posts, favorite images, ratings, and tags. */

import type { KemonoService } from '../kemono/apiTypes'
import type { WatchFolder, WatchSite } from './watchTypes'

export type Rating = 1 | 2 | 3 | 4 | 5

/** Rating and tags shared by creators, favorite posts and favorite images.
 * Tags are plain strings; one tag pool is shared across all three kinds. */
export interface Labels {
  rating?: Rating
  tags?: string[]
}

export const FAV_POSTS_KEY = 'pawchiveProFavPosts'
export const FAV_IMAGES_KEY = 'pawchiveProFavImages'

export interface FavPost extends Labels {
  /** `${site}/${service}/${creatorId}/${postId}` */
  key: string
  site: WatchSite
  service: KemonoService
  creatorId: string
  postId: string
  title: string
  published?: string
  /** data file path of the post's cover image, e.g. '/5a/48/<hash>.jpeg' */
  coverPath?: string
  creatorName: string
  folderId: string
  addedAt: number
  note?: string
}

export interface FavImage extends Labels {
  /** `${site}${path}` e.g. 'pawchive/5a/48/<hash>.jpeg' */
  key: string
  site: WatchSite
  /** data file path, always starts with '/', e.g. '/5a/48/<hash>.jpeg' */
  path: string
  /** original file name if known (the `?f=` value on the site) */
  fileName?: string
  service: KemonoService
  creatorId: string
  postId: string
  postTitle?: string
  creatorName?: string
  folderId: string
  addedAt: number
  note?: string
}

export interface CollectData<T> {
  version: 1
  folders: WatchFolder[]
  items: Record<string, T>
}
