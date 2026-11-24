/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Shared DOM, formatting, avatar, and cover image helpers for the watch page. */

import { lang } from '../Language'
import { avatarUrl, bannerUrl, thumbUrl } from '../watch/watchKey'
import {
  UNSORTED_FOLDER_ID,
  type CreatorSnapshot,
  type WatchFolder,
  type WatchSite,
  type WatchedCreator,
} from '../watch/watchTypes'
import { coverStore } from './coverStore'
import { displayName } from './listModel'

export const MIME_CREATOR = 'application/x-pawchive-creator'
export const MIME_FOLDER = 'application/x-pawchive-folder'
export const MIME_FAV_POST = 'application/x-pwp-favpost'
export const MIME_FAV_IMAGE = 'application/x-pwp-favimage'
export const MIME_FAV_POST_FOLDER = 'application/x-pwp-favpost-folder'
export const MIME_FAV_IMAGE_FOLDER = 'application/x-pwp-favimage-folder'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function siteLabel(site: WatchSite): string {
  return site === 'pawchive' ? 'Pawchive' : 'Kemono'
}

export function folderLabel(folder: WatchFolder): string {
  return folder.id === UNSORTED_FOLDER_ID
    ? lang.transl('_w_unsorted')
    : folder.name
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString(lang.htmlLang())
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(lang.htmlLang())
}

/** Build a fallback avatar element (image with initial-letter circle fallback). */
export function createAvatar(
  creator: WatchedCreator,
  host: string,
  className: string
): HTMLElement {
  const wrap = el('span', className)
  const name = displayName(creator).trim()
  const initial = (name ? Array.from(name)[0] : '?').toUpperCase()
  const fallback = el('span', 'w-avatar-initial', initial)
  fallback.setAttribute('aria-hidden', 'true')
  wrap.appendChild(fallback)

  const img = el('img', 'w-avatar-img')
  img.loading = 'lazy'
  img.decoding = 'async'
  img.alt = ''
  img.src = avatarUrl(host, creator.service, creator.creatorId)
  img.addEventListener('error', () => {
    img.remove()
  })
  wrap.appendChild(img)
  return wrap
}

function attachFallbackImage(container: HTMLElement, urls: string[]): void {
  const unique: string[] = []
  for (const u of urls) {
    if (u && !unique.includes(u)) unique.push(u)
  }
  if (unique.length === 0) return

  let idx = 0
  const img = el('img', 'w-cover-img')
  img.loading = 'lazy'
  img.decoding = 'async'
  img.alt = ''
  img.addEventListener('error', () => {
    idx += 1
    if (idx < unique.length) {
      img.src = unique[idx]
    } else {
      img.remove()
    }
  })
  img.src = unique[0]
  container.appendChild(img)
}

/**
 * Populate a cover container using the fallback chain:
 * custom cover (upload or post) -> creator banner -> newest snapshot post cover -> CSS gradient.
 */
export function populateCover(
  container: HTMLElement,
  creator: WatchedCreator,
  snap: CreatorSnapshot | undefined,
  host: string
): void {
  const existing = container.querySelector('.w-cover-img')
  if (existing) existing.remove()

  const fallbacks: string[] = []
  if (creator.cover?.kind === 'post') {
    fallbacks.push(thumbUrl(host, creator.cover.path))
  }
  fallbacks.push(bannerUrl(host, creator.service, creator.creatorId))
  if (snap) {
    const withCover = snap.posts.find((p) => p.coverPath)
    if (withCover?.coverPath) {
      fallbacks.push(thumbUrl(host, withCover.coverPath))
    }
  }

  if (creator.cover?.kind === 'upload') {
    const uploadId = creator.cover.id
    const token = String(Date.now()) + Math.random()
    container.dataset.coverToken = token
    void coverStore.objectUrl(uploadId).then((url) => {
      if (container.dataset.coverToken !== token) return
      const urls = url ? [url, ...fallbacks] : fallbacks
      attachFallbackImage(container, urls)
    })
  } else {
    delete container.dataset.coverToken
    attachFallbackImage(container, fallbacks)
  }
}
