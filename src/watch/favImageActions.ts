/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Save / move / remove a favorite image, with the toasts the on-site entry
 * points (post page image buttons) share. */

import { lang } from '../Language'
import { toast } from '../Toast'
import { favImages } from './collectStore'
import { savedLabel } from './favPostActions'
import { sanitizeRating } from './labels'
import { resolvePostMeta, type PostTarget } from './postMeta'

export interface FavImageTarget extends PostTarget {
  key: string
  path: string
  fileName?: string
}

/** Save the image into a folder, or move it there when it is already saved;
 * `rating` (1-5) is set too when given */
export async function saveImageToFolder(
  target: FavImageTarget,
  folderId: string,
  folderLabel: string,
  rating?: number
): Promise<void> {
  const r = sanitizeRating(rating)
  try {
    await favImages.ready()
    if (favImages.has(target.key)) {
      await favImages.move([target.key], folderId)
    } else {
      const meta = await resolvePostMeta(target)
      await favImages.add(
        {
          key: target.key,
          site: target.site,
          path: target.path,
          fileName: target.fileName,
          service: target.service,
          creatorId: target.creatorId,
          postId: target.postId,
          postTitle: meta.title || undefined,
          creatorName: meta.creatorName || undefined,
        },
        folderId
      )
    }
    if (r) await favImages.updateMany([target.key], { rating: r })
    toast.success(lang.transl('_fs_imageSavedTo', savedLabel(folderLabel, r)))
  } catch (err) {
    toast.error(lang.transl('_ws_saveFailed', String(err)))
  }
}

export async function removeImageFromFav(
  target: FavImageTarget
): Promise<void> {
  try {
    await favImages.remove([target.key])
    toast.success(lang.transl('_fs_removed'))
  } catch (err) {
    toast.error(lang.transl('_ws_saveFailed', String(err)))
  }
}
