/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure helpers for the creator page preview (no DOM): which link is a creator
 * link, which picture stands for a post, and how big the cover grid is. */

import type { KemonoService, PostsApiItem } from '../kemono/apiTypes'
import { isImageFile } from '../kemono/fileType'
import { creatorRegPath } from '../kemono/pages'
import { coverUrl } from './previewAssets'

/** How many posts one page of the posts API returns */
export const CREATOR_PAGE_SIZE = 50

/** Widest grid, in covers */
const MAX_COLS = 6

export interface CreatorRef {
  service: KemonoService
  creatorId: string
}

/** `/patreon/user/123` (relative or absolute) → creator; anything else → null */
export function parseCreatorHref(href: string): CreatorRef | null {
  let pathname: string
  try {
    // Only the path matters; the dummy base also lets node tests parse it
    pathname = new URL(href, 'https://preview.invalid').pathname
  } catch {
    return null
  }
  const m = pathname.match(creatorRegPath)
  if (!m) return null
  return { service: m[1] as KemonoService, creatorId: m[2] }
}

/** The post's cover thumbnail: its own cover when that is an image, else the
 * first image attachment; '' when the post has no image at all */
export function creatorPostCover(item: PostsApiItem, host: string): string {
  const files = [item.file, ...(item.attachments ?? [])]
  for (const f of files) {
    if (f?.path && isImageFile(f)) return coverUrl(f, host)
  }
  return ''
}

/** Grid columns and visible rows for `count` covers. Prefers a column count
 * that divides `count`, so the covers fill the grid with no empty cell. */
export function creatorGridShape(count: number): {
  cols: number
  rows: number
} {
  const n = Math.max(1, Math.floor(count) || 1)
  if (n <= MAX_COLS) return { cols: n, rows: 1 }
  let cols = MAX_COLS
  for (const c of [6, 5, 4]) {
    if (n % c === 0) {
      cols = c
      break
    }
  }
  return { cols, rows: Math.ceil(n / cols) }
}

/** Site path of one of the creator's posts */
export function creatorPostPath(ref: CreatorRef, postId: string): string {
  return `/${ref.service}/user/${ref.creatorId}/post/${postId}`
}

/** "50+" when the API returned a full page (there may be more), else the count */
export function creatorPostCountLabel(n: number): string {
  return n >= CREATOR_PAGE_SIZE ? `${n}+` : String(n)
}
