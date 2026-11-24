/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Shared post metadata and URL helpers for on-site favorite entry points. */

import { api } from '../kemono/api'
import type { KemonoService, PostApiResponse } from '../kemono/apiTypes'
import { imageFiles } from '../preview/previewAssets'
import { IMAGE_PATH_RE, makeCreatorKey } from './watchKey'
import { watchStore } from './watchStore'
import type { WatchSite } from './watchTypes'

export interface PostMeta {
  title: string
  published?: string
  coverPath?: string
  creatorName: string
}

export interface PostTarget {
  site: WatchSite
  service: KemonoService
  creatorId: string
  postId: string
}

/** Pick the post's cover image path: post.file if it is an image, else the
 * first image attachment path. */
export function pickCoverPath(data: PostApiResponse): string | undefined {
  const first = imageFiles(data)[0]
  if (first?.path && IMAGE_PATH_RE.test(first.path)) {
    return first.path
  }
  return undefined
}

/** Extract the original file name from a site data link's `?f=` query param. */
export function extractFileNameFromUrl(url: string): string | undefined {
  if (!url) return undefined
  try {
    const f = new URL(url, 'https://pwp.invalid').searchParams.get('f')?.trim()
    return f || undefined
  } catch {
    return undefined
  }
}

/** Resolve a creator's display name from watchStore, api.profile, optional DOM
 * selector, or fall back to creatorId. */
export async function resolvePostCreatorName(
  site: WatchSite,
  service: KemonoService,
  creatorId: string,
  domSelector?: string
): Promise<string> {
  const watched = watchStore.getCreator(
    makeCreatorKey(site, service, creatorId)
  )
  if (watched?.name) return watched.name

  try {
    const profile = await api.profile({ service, creatorId })
    if (!api.isErrorResponse(profile) && profile?.name) {
      return profile.name
    }
  } catch {
    // Fall back to DOM or creatorId
  }

  if (domSelector && typeof document !== 'undefined') {
    const domName = document.querySelector(domSelector)?.textContent?.trim()
    if (domName) return domName
  }

  return creatorId
}

/** Resolve title, published date, cover path, and creator name for a post.
 * Shares api.post / api.profile in-memory caches and in-flight deduplication. */
export async function resolvePostMeta(target: PostTarget): Promise<PostMeta> {
  let title = ''
  let published: string | undefined
  let coverPath: string | undefined

  try {
    const res = await api.post({
      service: target.service,
      creatorId: target.creatorId,
      postId: target.postId,
    })
    if (!api.isErrorResponse(res) && res?.post) {
      title = res.post.title?.trim() ?? ''
      published = res.post.published || undefined
      coverPath = pickCoverPath(res)
    }
  } catch {
    // Fall back to DOM below
  }

  if (!title && typeof document !== 'undefined') {
    title = document.querySelector('.post__title')?.textContent?.trim() ?? ''
  }

  const creatorName = await resolvePostCreatorName(
    target.site,
    target.service,
    target.creatorId,
    '.post__user-name'
  )

  return { title, published, coverPath, creatorName }
}
