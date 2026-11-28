/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Save / move / remove a favorite post, with the toasts the on-site entry
 * points (post page button, card button) share. */

import { lang } from '../Language'
import { toast } from '../Toast'
import type { KemonoService } from '../kemono/apiTypes'
import type { Rating } from './collectTypes'
import { favPosts } from './collectStore'
import { sanitizeRating } from './labels'
import { resolvePostMeta } from './postMeta'
import { makeFavPostKey } from './watchKey'
import {
  UNSORTED_FOLDER_ID,
  type WatchFolder,
  type WatchSite,
} from './watchTypes'

export interface FavPostTarget {
  site: WatchSite
  service: KemonoService
  creatorId: string
  postId: string
  key: string
}

export function makeFavPostTarget(
  site: WatchSite,
  service: KemonoService,
  creatorId: string,
  postId: string
): FavPostTarget {
  return {
    site,
    service,
    creatorId,
    postId,
    key: makeFavPostKey(site, service, creatorId, postId),
  }
}

export function folderDisplayName(folder: WatchFolder | undefined): string {
  if (!folder || folder.id === UNSORTED_FOLDER_ID) {
    return lang.transl('_w_unsorted')
  }
  return folder.name
}

/** Toast text for a save: the folder, plus the rating when one was set */
export function savedLabel(folderLabel: string, rating?: Rating): string {
  return rating ? `${folderLabel} ${'★'.repeat(rating)}` : folderLabel
}

/** Save the post into a folder, or move it there when it is already saved;
 * `rating` (1-5) is set too when given */
export async function savePostToFolder(
  target: FavPostTarget,
  folderId: string,
  folderLabel: string,
  rating?: number
): Promise<void> {
  const r = sanitizeRating(rating)
  try {
    await favPosts.ready()
    if (favPosts.has(target.key)) {
      await favPosts.move([target.key], folderId)
    } else {
      const meta = await resolvePostMeta(target)
      await favPosts.add(
        {
          key: target.key,
          site: target.site,
          service: target.service,
          creatorId: target.creatorId,
          postId: target.postId,
          title: meta.title,
          published: meta.published,
          coverPath: meta.coverPath,
          creatorName: meta.creatorName,
        },
        folderId
      )
    }
    if (r) await favPosts.updateMany([target.key], { rating: r })
    toast.success(lang.transl('_fs_postSaved', savedLabel(folderLabel, r)))
  } catch (err) {
    toast.error(lang.transl('_ws_saveFailed', String(err)))
  }
}

export async function removePostFromFav(target: FavPostTarget): Promise<void> {
  try {
    await favPosts.remove([target.key])
    toast.success(lang.transl('_fs_removed'))
  } catch (err) {
    toast.error(lang.transl('_ws_saveFailed', String(err)))
  }
}
