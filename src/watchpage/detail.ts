/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Creator detail view: metadata editing, cover picker trigger, and paginated posts grid. */

import { api } from '../kemono/api'
import { lang } from '../Language'
import {
  isSnapshotStale,
  snapshotFromPosts,
  snapshots,
} from '../watch/snapshot'
import { sortedFolders } from '../watch/watchData'
import { creatorPageUrl, postPageUrl, thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import type {
  CreatorSnapshot,
  SnapshotPost,
  WatchData,
  WatchedCreator,
} from '../watch/watchTypes'
import { openCoverPicker } from './coverPicker'
import {
  createAvatar,
  el,
  folderLabel,
  formatDate,
  formatDateTime,
  populateCover,
  siteLabel,
} from './dom'
import { displayName } from './listModel'
import { firstIdsOf, pageCache } from './pageCache'

const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000
const PAGE_SIZE = 50
const NOTE_DEBOUNCE_MS = 600

export interface DetailCallbacks {
  onBack: () => void
  onGoAll: () => void
  onSnapshotUpdated: (snap: CreatorSnapshot) => void
}

export interface DetailController {
  readonly key: string
  sync(creator: WatchedCreator | undefined, data: WatchData): void
  destroy(): void
}

export function mountDetailView(
  root: HTMLElement,
  key: string,
  initialSnap: CreatorSnapshot | undefined,
  callbacks: DetailCallbacks
): DetailController {
  let destroyed = false
  let currentCreator = watchStore.getCreator(key)
  let currentSnap = initialSnap
  let posts: SnapshotPost[] = initialSnap ? [...initialSnap.posts] : []
  let firstIds = firstIdsOf(posts)
  let nextOffset = PAGE_SIZE
  let hasMore = posts.length >= PAGE_SIZE
  let loadingInitial = false
  let loadingMore = false
  let loadError = ''

  let noteTimer: number | null = null
  let savedHintTimer: number | null = null
  const abortController = new AbortController()

  // Persistent elements updated in-place to preserve focus during live updates
  let coverEl: HTMLElement | null = null
  let avatarSlot: HTMLElement | null = null
  let displayNameEl: HTMLElement | null = null
  let origNameEl: HTMLElement | null = null
  let trackBtnEl: HTMLButtonElement | null = null
  let trackingBarEl: HTMLElement | null = null
  let folderSelectEl: HTMLSelectElement | null = null
  let aliasInputEl: HTMLInputElement | null = null
  let noteTextareaEl: HTMLTextAreaElement | null = null
  let savedHintEl: HTMLElement | null = null
  let postsSectionEl: HTMLElement | null = null
  let trackBusy = false
  let lastUnreadKey = ''

  const unreadSignature = (creator: WatchedCreator | undefined): string => {
    if (!creator?.tracking?.enabled) return ''
    return creator.tracking.unread.map((p) => p.id).join(',')
  }

  const renderNotFound = (): void => {
    root.replaceChildren()
    const box = el('div', 'w-empty')
    box.appendChild(el('p', 'w-empty-text', lang.transl('_w_notFound')))
    const link = el('a', 'w-btn w-btn-primary', lang.transl('_w_backToAll'))
    link.href = '#/all'
    link.addEventListener('click', (ev) => {
      ev.preventDefault()
      callbacks.onGoAll()
    })
    box.appendChild(link)
    root.appendChild(box)
  }

  const showSavedHint = (): void => {
    if (!savedHintEl) return
    savedHintEl.textContent = lang.transl('_w_saved')
    savedHintEl.classList.add('is-visible')
    if (savedHintTimer !== null) window.clearTimeout(savedHintTimer)
    savedHintTimer = window.setTimeout(() => {
      savedHintEl?.classList.remove('is-visible')
    }, 1800)
  }

  const saveAlias = (): void => {
    if (!aliasInputEl || !currentCreator) return
    const next = aliasInputEl.value.trim()
    const prev = currentCreator.alias ?? ''
    if (next === prev) return
    void watchStore.updateCreator(key, { alias: next || null })
  }

  const saveNote = (): void => {
    if (!noteTextareaEl || !currentCreator) return
    const next = noteTextareaEl.value
    const prev = currentCreator.note ?? ''
    if (next === prev) return
    void watchStore
      .updateCreator(key, { note: next.trim() ? next : null })
      .then(() => {
        if (!destroyed) showSavedHint()
      })
  }

  const renderPostsSection = (): void => {
    if (!postsSectionEl || !currentCreator) return
    const host = watchStore.hostFor(currentCreator.site)
    postsSectionEl.replaceChildren()

    const head = el('div', 'w-posts-head')
    head.appendChild(
      el('h2', 'w-section-title', lang.transl('_w_postsHeading'))
    )
    if (loadingInitial) {
      head.appendChild(el('span', 'w-muted', lang.transl('_w_loadingPosts')))
    }
    postsSectionEl.appendChild(head)

    if (loadError) {
      const err = el('p', 'w-error-text', loadError)
      err.setAttribute('role', 'alert')
      postsSectionEl.appendChild(err)
    }

    if (posts.length === 0 && !loadingInitial) {
      postsSectionEl.appendChild(el('p', 'w-muted', lang.transl('_w_noPosts')))
      return
    }

    const unreadIds = new Set(
      currentCreator.tracking?.enabled
        ? currentCreator.tracking.unread.map((p) => p.id)
        : []
    )
    const grid = el('div', 'w-post-grid')
    for (const post of posts) {
      const tile = el('a', 'w-post-tile')
      tile.href = postPageUrl(
        host,
        currentCreator.service,
        currentCreator.creatorId,
        post.id
      )
      tile.target = '_blank'
      tile.rel = 'noopener'

      const thumb = el('div', 'w-post-thumb')
      const titleText = post.title || lang.transl('_w_untitledPost')

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
      if (unreadIds.has(post.id)) {
        thumb.appendChild(
          el('span', 'w-new-ribbon', lang.transl('_wt_newRibbon'))
        )
      }
      tile.appendChild(thumb)

      const info = el('div', 'w-post-info')
      info.appendChild(el('div', 'w-post-title', titleText))
      if (post.published) {
        info.appendChild(el('div', 'w-post-date', formatDate(post.published)))
      }
      tile.appendChild(info)

      grid.appendChild(tile)
    }
    postsSectionEl.appendChild(grid)

    if (hasMore) {
      const moreWrap = el('div', 'w-load-more-wrap')
      const moreBtn = el(
        'button',
        'w-btn w-btn-secondary',
        loadingMore ? lang.transl('_w_loadingMore') : lang.transl('_w_loadMore')
      )
      moreBtn.type = 'button'
      moreBtn.disabled = loadingMore || loadingInitial
      moreBtn.addEventListener('click', () => {
        void loadNextPage()
      })
      moreWrap.appendChild(moreBtn)
      postsSectionEl.appendChild(moreWrap)
    }
  }

  const refreshFirstPage = async (): Promise<void> => {
    if (!currentCreator) return
    const creator = currentCreator
    const host = watchStore.hostFor(creator.site)
    loadingInitial = true
    loadError = ''
    renderPostsSection()

    try {
      const res = await api.posts(
        {
          service: creator.service,
          creatorId: creator.creatorId,
          index: 0,
          host,
        },
        abortController.signal
      )
      if (destroyed) return
      if (api.isErrorResponse(res)) {
        loadError = lang.transl('_w_loadPostsFailed', res.error)
      } else {
        const snap = snapshotFromPosts(key, res)
        await snapshots.set(snap)
        if (destroyed) return
        currentSnap = snap
        posts = [...snap.posts]
        firstIds = firstIdsOf(posts)
        nextOffset = PAGE_SIZE
        hasMore = snap.posts.length >= PAGE_SIZE
        callbacks.onSnapshotUpdated(snap)
        if (coverEl && currentCreator) {
          populateCover(coverEl, currentCreator, currentSnap, host)
        }
      }
    } catch (e) {
      if (destroyed || (e as { name?: string })?.name === 'AbortError') return
      loadError = lang.transl(
        '_w_loadPostsFailed',
        e instanceof Error ? e.message : String(e)
      )
    } finally {
      if (!destroyed) {
        loadingInitial = false
        renderPostsSection()
      }
    }
  }

  const loadNextPage = async (): Promise<void> => {
    if (!currentCreator || loadingMore || !hasMore) return
    const creator = currentCreator
    const host = watchStore.hostFor(creator.site)
    const offset = nextOffset
    loadingMore = true
    loadError = ''
    renderPostsSection()

    try {
      let pagePosts = await pageCache.get(key, offset, firstIds)
      if (!pagePosts) {
        const res = await api.posts(
          {
            service: creator.service,
            creatorId: creator.creatorId,
            index: offset,
            host,
          },
          abortController.signal
        )
        if (destroyed) return
        if (api.isErrorResponse(res)) {
          loadError = lang.transl('_w_loadPostsFailed', res.error)
          return
        }
        pagePosts = snapshotFromPosts(key, res).posts
        if (firstIds) {
          await pageCache.set(key, offset, firstIds, pagePosts)
        }
      }
      if (destroyed) return
      const seen = new Set(posts.map((p) => p.id))
      for (const p of pagePosts) {
        if (!seen.has(p.id)) {
          seen.add(p.id)
          posts.push(p)
        }
      }
      nextOffset = offset + PAGE_SIZE
      hasMore = pagePosts.length >= PAGE_SIZE
    } catch (e) {
      if (destroyed || (e as { name?: string })?.name === 'AbortError') return
      loadError = lang.transl(
        '_w_loadPostsFailed',
        e instanceof Error ? e.message : String(e)
      )
    } finally {
      if (!destroyed) {
        loadingMore = false
        renderPostsSection()
      }
    }
  }

  const syncFolderOptions = (
    select: HTMLSelectElement,
    data: WatchData,
    selectedFolderId: string
  ): void => {
    select.replaceChildren()
    for (const folder of sortedFolders(data)) {
      const opt = el('option', undefined, folderLabel(folder))
      opt.value = folder.id
      opt.selected = folder.id === selectedFolderId
      select.appendChild(opt)
    }
  }

  const toggleTracking = async (): Promise<void> => {
    if (!currentCreator || trackBusy) return
    const creator = currentCreator
    trackBusy = true
    syncHeaderFields(creator, watchStore.data)
    try {
      if (creator.tracking?.enabled) {
        await watchStore.disableTracking([key])
      } else {
        const host = watchStore.hostFor(creator.site)
        const res = await api.posts(
          {
            service: creator.service,
            creatorId: creator.creatorId,
            index: 0,
            host,
          },
          abortController.signal
        )
        if (destroyed) return
        if (api.isErrorResponse(res)) {
          loadError = lang.transl('_wt_trackFailed', res.error)
          renderPostsSection()
          return
        }
        const snap = snapshotFromPosts(key, res)
        await snapshots.set(snap)
        if (destroyed) return
        currentSnap = snap
        posts = [...snap.posts]
        firstIds = firstIdsOf(posts)
        nextOffset = PAGE_SIZE
        hasMore = snap.posts.length >= PAGE_SIZE
        callbacks.onSnapshotUpdated(snap)
        await watchStore.enableTracking(
          {
            site: creator.site,
            service: creator.service,
            creatorId: creator.creatorId,
            name: creator.name,
          },
          res
        )
        if (!destroyed) {
          loadError = ''
          renderPostsSection()
        }
      }
    } catch (e) {
      if (destroyed || (e as { name?: string })?.name === 'AbortError') return
      loadError = lang.transl(
        '_wt_trackFailed',
        e instanceof Error ? e.message : String(e)
      )
      renderPostsSection()
    } finally {
      trackBusy = false
      if (!destroyed && currentCreator) {
        syncHeaderFields(currentCreator, watchStore.data)
      }
    }
  }

  const syncHeaderFields = (creator: WatchedCreator, data: WatchData): void => {
    const host = watchStore.hostFor(creator.site)
    if (coverEl) {
      populateCover(coverEl, creator, currentSnap, host)
    }
    if (avatarSlot) {
      avatarSlot.replaceChildren(createAvatar(creator, host, 'w-avatar-lg'))
    }
    if (displayNameEl) {
      displayNameEl.textContent = displayName(creator)
    }
    if (origNameEl) {
      origNameEl.textContent = creator.alias ? creator.name : ''
      origNameEl.hidden = !creator.alias
    }
    if (trackBtnEl) {
      const tracked = creator.tracking?.enabled === true
      trackBtnEl.textContent = `🔔 ${lang.transl(tracked ? '_wt_tracking' : '_wt_track')}`
      trackBtnEl.className = tracked
        ? 'w-btn w-btn-primary w-track-btn is-tracking'
        : 'w-btn w-btn-secondary w-track-btn'
      trackBtnEl.setAttribute('aria-pressed', String(tracked))
      trackBtnEl.disabled = trackBusy
    }
    if (trackingBarEl) {
      const tracking = creator.tracking
      if (tracking?.enabled) {
        trackingBarEl.hidden = false
        trackingBarEl.replaceChildren()
        const checkedText = tracking.lastCheckedAt
          ? lang.transl(
              '_wt_lastChecked',
              formatDateTime(tracking.lastCheckedAt)
            )
          : lang.transl('_wt_lastCheckedNever')
        trackingBarEl.appendChild(el('span', 'w-tracking-meta', checkedText))
        if (tracking.lastError) {
          const errSpan = el(
            'span',
            'w-error-text w-tracking-err',
            `⚠ ${tracking.lastError}`
          )
          errSpan.title = lang.transl('_wt_checkError', tracking.lastError)
          trackingBarEl.appendChild(errSpan)
        }
        if (tracking.unread.length > 0) {
          const markBtn = el(
            'button',
            'w-btn w-btn-secondary w-btn-sm',
            lang.transl('_wt_markRead')
          )
          markBtn.type = 'button'
          markBtn.addEventListener('click', () => {
            void watchStore.markRead([key])
          })
          trackingBarEl.appendChild(markBtn)
        }
      } else {
        trackingBarEl.hidden = true
        trackingBarEl.replaceChildren()
      }
    }
    if (folderSelectEl) {
      syncFolderOptions(folderSelectEl, data, creator.folderId)
    }
    if (aliasInputEl && document.activeElement !== aliasInputEl) {
      aliasInputEl.placeholder = creator.name
      aliasInputEl.value = creator.alias ?? ''
    }
    if (noteTextareaEl && document.activeElement !== noteTextareaEl) {
      noteTextareaEl.value = creator.note ?? ''
    }
  }

  const buildShell = (creator: WatchedCreator, data: WatchData): void => {
    const host = watchStore.hostFor(creator.site)
    root.replaceChildren()

    const page = el('div', 'w-detail')

    // Top bar with back button
    const topBar = el('div', 'w-detail-top')
    const backBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_w_back')
    )
    backBtn.type = 'button'
    backBtn.addEventListener('click', () => callbacks.onBack())
    topBar.appendChild(backBtn)
    page.appendChild(topBar)

    // Header card
    const header = el('section', 'w-detail-header')

    const cover = el('div', 'w-detail-cover')
    coverEl = cover
    const changeCoverBtn = el(
      'button',
      'w-btn w-cover-edit-btn',
      lang.transl('_w_changeCover')
    )
    changeCoverBtn.type = 'button'
    changeCoverBtn.addEventListener('click', () => {
      if (!currentCreator) return
      openCoverPicker({
        creator: currentCreator,
        posts,
        host: watchStore.hostFor(currentCreator.site),
        triggerEl: changeCoverBtn,
      })
    })
    cover.appendChild(changeCoverBtn)
    header.appendChild(cover)

    const infoRow = el('div', 'w-detail-info')
    const identity = el('div', 'w-detail-identity')

    avatarSlot = el('div', 'w-detail-avatar-slot')
    identity.appendChild(avatarSlot)

    const titles = el('div', 'w-detail-titles')
    // The name links to the creator page on the original site
    const nameHeading = el('h1', 'w-detail-name')
    const nameLink = el('a', 'w-detail-name-link')
    nameLink.href = creatorPageUrl(host, creator.service, creator.creatorId)
    nameLink.target = '_blank'
    nameLink.rel = 'noopener'
    nameLink.title = lang.transl('_w_openOnSite')
    nameHeading.appendChild(nameLink)
    displayNameEl = nameLink
    origNameEl = el('div', 'w-detail-orig')
    titles.appendChild(nameHeading)
    titles.appendChild(origNameEl)

    const badges = el('div', 'w-badges')
    badges.appendChild(
      el('span', `w-badge w-badge-${creator.site}`, siteLabel(creator.site))
    )
    badges.appendChild(el('span', 'w-badge', creator.service))
    titles.appendChild(badges)

    identity.appendChild(titles)
    infoRow.appendChild(identity)

    // Actions: tracking, folder select, remove
    const actions = el('div', 'w-detail-actions')

    const trackBtn = el('button', 'w-btn w-btn-secondary w-track-btn')
    trackBtn.type = 'button'
    trackBtn.addEventListener('click', () => {
      void toggleTracking()
    })
    trackBtnEl = trackBtn
    actions.appendChild(trackBtn)

    const folderSelect = el('select', 'w-select')
    folderSelect.setAttribute('aria-label', lang.transl('_w_folderLabel'))
    folderSelect.addEventListener('change', () => {
      void watchStore.moveCreators([key], folderSelect.value)
    })
    folderSelectEl = folderSelect
    actions.appendChild(folderSelect)

    const removeBtn = el(
      'button',
      'w-btn w-btn-danger',
      lang.transl('_w_remove')
    )
    removeBtn.type = 'button'
    removeBtn.addEventListener('click', () => {
      if (!currentCreator) return
      const ok = window.confirm(
        lang.transl('_w_removeConfirm', displayName(currentCreator))
      )
      if (!ok) return
      void watchStore.removeCreators([key]).then(() => {
        callbacks.onGoAll()
      })
    })
    actions.appendChild(removeBtn)

    infoRow.appendChild(actions)
    header.appendChild(infoRow)

    trackingBarEl = el('div', 'w-detail-tracking')
    trackingBarEl.hidden = true
    header.appendChild(trackingBarEl)

    page.appendChild(header)

    // Alias & Note fields
    const fields = el('section', 'w-detail-fields')

    const aliasGroup = el('div', 'w-field')
    const aliasLabel = el(
      'label',
      'w-field-label',
      lang.transl('_w_aliasLabel')
    )
    aliasLabel.htmlFor = 'w-alias-input'
    const aliasInput = el('input', 'w-input')
    aliasInput.id = 'w-alias-input'
    aliasInput.type = 'text'
    aliasInput.maxLength = 100
    aliasInput.addEventListener('change', saveAlias)
    aliasInput.addEventListener('blur', saveAlias)
    aliasInputEl = aliasInput
    aliasGroup.appendChild(aliasLabel)
    aliasGroup.appendChild(aliasInput)
    fields.appendChild(aliasGroup)

    const noteGroup = el('div', 'w-field')
    const noteHead = el('div', 'w-field-head')
    const noteLabel = el('label', 'w-field-label', lang.transl('_w_noteLabel'))
    noteLabel.htmlFor = 'w-note-input'
    savedHintEl = el('span', 'w-saved-hint')
    savedHintEl.setAttribute('role', 'status')
    noteHead.appendChild(noteLabel)
    noteHead.appendChild(savedHintEl)

    const noteTextarea = el('textarea', 'w-textarea')
    noteTextarea.id = 'w-note-input'
    noteTextarea.rows = 3
    noteTextarea.maxLength = 5000
    noteTextarea.placeholder = lang.transl('_w_notePlaceholder')
    noteTextarea.addEventListener('input', () => {
      if (noteTimer !== null) window.clearTimeout(noteTimer)
      noteTimer = window.setTimeout(() => {
        noteTimer = null
        saveNote()
      }, NOTE_DEBOUNCE_MS)
    })
    noteTextarea.addEventListener('blur', () => {
      if (noteTimer !== null) {
        window.clearTimeout(noteTimer)
        noteTimer = null
      }
      saveNote()
    })
    noteTextareaEl = noteTextarea
    noteGroup.appendChild(noteHead)
    noteGroup.appendChild(noteTextarea)
    fields.appendChild(noteGroup)

    page.appendChild(fields)

    // Posts section
    postsSectionEl = el('section', 'w-posts-section')
    page.appendChild(postsSectionEl)

    root.appendChild(page)
    lastUnreadKey = unreadSignature(creator)
    syncHeaderFields(creator, data)
    renderPostsSection()
  }

  if (!currentCreator) {
    renderNotFound()
  } else {
    buildShell(currentCreator, watchStore.data)
    void (async () => {
      if (!currentSnap) {
        const stored = await snapshots.get(key)
        if (destroyed) return
        if (stored) {
          currentSnap = stored
          posts = [...stored.posts]
          firstIds = firstIdsOf(posts)
          hasMore = stored.posts.length >= PAGE_SIZE
          callbacks.onSnapshotUpdated(stored)
          if (coverEl && currentCreator) {
            populateCover(
              coverEl,
              currentCreator,
              currentSnap,
              watchStore.hostFor(currentCreator.site)
            )
          }
          renderPostsSection()
        }
      }
      if (isSnapshotStale(currentSnap, SNAPSHOT_MAX_AGE_MS)) {
        await refreshFirstPage()
      }
    })()
  }

  return {
    key,
    sync(creator, data) {
      if (destroyed) return
      currentCreator = creator
      if (!creator) {
        renderNotFound()
        return
      }
      if (!coverEl) {
        buildShell(creator, data)
      } else {
        syncHeaderFields(creator, data)
        const nextUnreadKey = unreadSignature(creator)
        if (nextUnreadKey !== lastUnreadKey) {
          lastUnreadKey = nextUnreadKey
          renderPostsSection()
        }
      }
    },
    destroy() {
      destroyed = true
      abortController.abort()
      if (noteTimer !== null) window.clearTimeout(noteTimer)
      if (savedHintTimer !== null) window.clearTimeout(savedHintTimer)
    },
  }
}
