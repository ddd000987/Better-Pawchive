/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* New posts feed view showing all unread posts across tracked creators. */

import { lang } from '../Language'
import { comparePublished } from '../watch/tracker'
import { postPageUrl, thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import type { UnreadPost, WatchData, WatchedCreator } from '../watch/watchTypes'
import { el, formatDate } from './dom'
import { displayName } from './listModel'

export interface FeedCallbacks {
  onOpenCreator: (key: string) => void
  onMarkPostRead: (key: string, postId: string) => Promise<void>
  onMarkAllRead: (keys: string[]) => Promise<void>
}

interface FeedEntry {
  creator: WatchedCreator
  post: UnreadPost
}

function collectFeedEntries(data: WatchData): FeedEntry[] {
  const entries: FeedEntry[] = []
  for (const creator of Object.values(data.creators)) {
    if (!creator.tracking?.enabled) continue
    for (const post of creator.tracking.unread) {
      entries.push({ creator, post })
    }
  }
  entries.sort((a, b) => comparePublished(b.post.published, a.post.published))
  return entries
}

export function renderFeedToolbar(
  root: HTMLElement,
  data: WatchData,
  callbacks: FeedCallbacks
): void {
  const keysWithUnread = Object.values(data.creators)
    .filter((c) => c.tracking?.enabled && c.tracking.unread.length > 0)
    .map((c) => c.key)

  root.replaceChildren()
  root.className = 'w-toolbar-wrap'

  const topRow = el('div', 'w-toolbar')
  topRow.appendChild(el('h1', 'w-view-title', lang.transl('_wt_feed')))

  const controls = el('div', 'w-toolbar-controls')
  const markAllBtn = el(
    'button',
    'w-btn w-btn-secondary',
    lang.transl('_wt_markAllRead')
  )
  markAllBtn.type = 'button'
  markAllBtn.disabled = keysWithUnread.length === 0
  markAllBtn.addEventListener('click', () => {
    if (window.confirm(lang.transl('_wt_markAllReadConfirm'))) {
      void callbacks.onMarkAllRead(keysWithUnread)
    }
  })
  controls.appendChild(markAllBtn)

  topRow.appendChild(controls)
  root.appendChild(topRow)
}

export function renderFeedView(
  root: HTMLElement,
  data: WatchData,
  callbacks: FeedCallbacks
): void {
  const entries = collectFeedEntries(data)
  root.replaceChildren()

  if (entries.length === 0) {
    const empty = el('div', 'w-empty')
    empty.appendChild(el('p', 'w-empty-text', lang.transl('_wt_emptyFeed')))
    root.appendChild(empty)
    return
  }

  const grid = el('div', 'w-post-grid w-feed-grid')

  for (const { creator, post } of entries) {
    const host = watchStore.hostFor(creator.site)
    const titleText = post.title || lang.transl('_w_untitledPost')
    const url = postPageUrl(host, creator.service, creator.creatorId, post.id)

    const tile = el('article', 'w-post-tile w-feed-tile')

    const link = el('a', 'w-feed-link')
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener'
    link.addEventListener('click', () => {
      void callbacks.onMarkPostRead(creator.key, post.id)
    })

    const thumb = el('div', 'w-post-thumb')
    if (post.coverPath) {
      const img = el('img', 'w-post-img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = ''
      img.src = thumbUrl(host, post.coverPath)
      img.addEventListener('error', () => {
        img.remove()
        thumb.appendChild(el('div', 'w-post-placeholder', titleText))
      })
      thumb.appendChild(img)
    } else {
      thumb.appendChild(el('div', 'w-post-placeholder', titleText))
    }
    link.appendChild(thumb)

    const info = el('div', 'w-post-info')
    info.appendChild(el('div', 'w-post-title', titleText))
    link.appendChild(info)

    tile.appendChild(link)

    const footer = el('div', 'w-feed-footer')
    const meta = el('div', 'w-feed-meta')

    const creatorLink = el('a', 'w-feed-creator', displayName(creator))
    creatorLink.href = `#/creator/${encodeURIComponent(creator.key)}`
    creatorLink.addEventListener('click', (ev) => {
      ev.preventDefault()
      callbacks.onOpenCreator(creator.key)
    })
    meta.appendChild(creatorLink)

    if (post.published) {
      meta.appendChild(el('div', 'w-post-date', formatDate(post.published)))
    }
    footer.appendChild(meta)

    const readBtn = el('button', 'w-feed-read-btn', '✓')
    readBtn.type = 'button'
    readBtn.title = lang.transl('_wt_markPostRead')
    readBtn.setAttribute('aria-label', lang.transl('_wt_markPostRead'))
    readBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      void callbacks.onMarkPostRead(creator.key, post.id)
    })
    footer.appendChild(readBtn)

    tile.appendChild(footer)
    grid.appendChild(tile)
  }

  root.appendChild(grid)
}
