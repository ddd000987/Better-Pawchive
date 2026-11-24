/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Modal image picker: single-select cover picker and multi-select card preview picker. */

import { lang } from '../Language'
import { favImages } from '../watch/collectStore'
import { MAX_PREVIEWS } from '../watch/labels'
import { thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import type {
  SnapshotPost,
  WatchCover,
  WatchedCreator,
} from '../watch/watchTypes'
import {
  appendPreviews,
  previewKey,
  removedUploadIds,
  sameWatchCover,
  togglePreviewItem,
} from './cardPreview'
import { coverStore, makeCoverId, resizeCoverImage } from './coverStore'
import { el } from './dom'

type CoverTab = 'posts' | 'upload'
type PreviewTab = 'favImages' | 'posts' | 'upload'

/** Gives the creator page's current post list and loads older posts into it. */
export interface PostLoader {
  posts(): SnapshotPost[]
  hasMore(): boolean
  /** Resolves to an error message, or null on success */
  load(): Promise<string | null>
}

export interface CoverPickerOptions {
  creator: WatchedCreator
  /** Posts when no loader is given */
  posts: SnapshotPost[]
  host: string
  loader?: PostLoader
  triggerEl?: HTMLElement | null
}

export interface PreviewPickerOptions {
  creator: WatchedCreator
  /** Posts when no loader is given */
  posts: SnapshotPost[]
  host: string
  loader?: PostLoader
  max?: number
  triggerEl?: HTMLElement | null
}

/** Remember the scroll position and the focused choice before a re-render,
 * and return a function that puts them back afterwards. */
function keepViewState(dialog: HTMLElement): () => void {
  const body = dialog.querySelector<HTMLElement>('.w-modal-body')
  const bodyTop = body?.scrollTop ?? 0
  const dialogTop = dialog.scrollTop
  const active = document.activeElement
  const focusKey =
    active instanceof HTMLElement && dialog.contains(active)
      ? active.dataset.choiceKey
      : undefined
  return () => {
    const nextBody = dialog.querySelector<HTMLElement>('.w-modal-body')
    if (nextBody) nextBody.scrollTop = bodyTop
    dialog.scrollTop = dialogTop
    if (focusKey) {
      dialog
        .querySelector<HTMLElement>(
          `[data-choice-key="${CSS.escape(focusKey)}"]`
        )
        ?.focus({ preventScroll: true })
    }
  }
}

/** "Load older posts" button (or its error) under the posts grid. */
function makeLoadMore(
  loader: PostLoader | undefined,
  state: { loading: boolean; error: string },
  rerender: () => void,
  isClosed: () => boolean
): HTMLElement | null {
  if (!loader) return null
  if (!loader.hasMore() && !state.error) return null
  const wrap = el('div', 'w-picker-load-more')
  if (state.error) {
    const err = el('p', 'w-error-text', state.error)
    err.setAttribute('role', 'alert')
    wrap.appendChild(err)
  }
  if (loader.hasMore()) {
    const btn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl(state.loading ? '_w_loadingMore' : '_w_loadOlderPosts')
    )
    btn.type = 'button'
    btn.disabled = state.loading
    btn.dataset.choiceKey = 'load-more'
    btn.addEventListener('click', () => {
      if (state.loading) return
      state.loading = true
      state.error = ''
      rerender()
      void loader.load().then((error) => {
        state.loading = false
        state.error = error ?? ''
        if (!isClosed()) rerender()
      })
    })
    wrap.appendChild(btn)
  }
  return wrap
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  return Array.from(nodes).filter((n) => n.offsetParent !== null)
}

function createModalShell(
  ariaLabel: string,
  onClose: () => void
): {
  backdrop: HTMLElement
  dialog: HTMLElement
  mount: () => void
  unmount: () => void
} {
  const backdrop = el('div', 'w-modal-backdrop')
  const dialog = el('div', 'w-modal')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', ariaLabel)
  backdrop.appendChild(dialog)

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      onClose()
      return
    }
    if (ev.key === 'Tab') {
      const focusable = getFocusable(dialog)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (ev.shiftKey) {
        if (
          document.activeElement === first ||
          !dialog.contains(document.activeElement)
        ) {
          ev.preventDefault()
          last.focus()
        }
      } else if (
        document.activeElement === last ||
        !dialog.contains(document.activeElement)
      ) {
        ev.preventDefault()
        first.focus()
      }
    }
  }

  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) onClose()
  })

  return {
    backdrop,
    dialog,
    mount() {
      document.body.appendChild(backdrop)
      document.addEventListener('keydown', onKeyDown)
    },
    unmount() {
      document.removeEventListener('keydown', onKeyDown)
      backdrop.remove()
    },
  }
}

async function deleteOldCoverUpload(creator: WatchedCreator): Promise<void> {
  if (creator.cover?.kind !== 'upload') return
  const id = creator.cover.id
  const usedInPreviews = creator.previews?.some(
    (p) => p.kind === 'upload' && p.id === id
  )
  if (!usedInPreviews) {
    await coverStore.delete(id)
  }
}

function makeModalHeader(title: string, onClose: () => void): HTMLElement {
  const header = el('div', 'w-modal-header')
  header.appendChild(el('h2', 'w-modal-title', title))
  const closeBtn = el('button', 'w-icon-btn')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', lang.transl('_w_close'))
  closeBtn.addEventListener('click', onClose)
  header.appendChild(closeBtn)
  return header
}

function makeTabButton(
  label: string,
  active: boolean,
  onClick: () => void
): HTMLButtonElement {
  const btn = el('button', active ? 'w-tab is-active' : 'w-tab', label)
  btn.type = 'button'
  btn.setAttribute('role', 'tab')
  btn.setAttribute('aria-selected', String(active))
  btn.addEventListener('click', onClick)
  return btn
}

export function openCoverPicker(opts: CoverPickerOptions): void {
  const { creator, posts, host, triggerEl } = opts
  const coverPosts = (): SnapshotPost[] =>
    (opts.loader?.posts() ?? posts).filter((p) => Boolean(p.coverPath))

  let activeTab: CoverTab = coverPosts().length > 0 ? 'posts' : 'upload'
  let renderedTab: CoverTab | null = null
  let errorMsg = ''
  let busy = false
  let closed = false
  const loadState = { loading: false, error: '' }

  const close = (): void => {
    closed = true
    shell.unmount()
    if (triggerEl && triggerEl.isConnected) {
      triggerEl.focus()
    }
  }

  const shell = createModalShell(lang.transl('_w_coverModalTitle'), close)
  const { dialog } = shell

  const render = (): void => {
    const restore = renderedTab === activeTab ? keepViewState(dialog) : null
    renderedTab = activeTab
    dialog.replaceChildren()
    dialog.appendChild(
      makeModalHeader(lang.transl('_w_coverModalTitle'), close)
    )

    const tabs = el('div', 'w-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.appendChild(
      makeTabButton(
        lang.transl('_w_coverTabPosts'),
        activeTab === 'posts',
        () => {
          activeTab = 'posts'
          errorMsg = ''
          render()
        }
      )
    )
    tabs.appendChild(
      makeTabButton(
        lang.transl('_w_coverTabUpload'),
        activeTab === 'upload',
        () => {
          activeTab = 'upload'
          errorMsg = ''
          render()
        }
      )
    )
    dialog.appendChild(tabs)

    const body = el('div', 'w-modal-body')
    if (activeTab === 'posts') {
      const postsWithCover = coverPosts()
      if (postsWithCover.length === 0) {
        body.appendChild(el('p', 'w-muted', lang.transl('_w_coverNoPosts')))
      } else {
        const grid = el('div', 'w-cover-grid')
        for (const post of postsWithCover) {
          const path = post.coverPath!
          const isCurrent =
            creator.cover?.kind === 'post' && creator.cover.path === path
          const btn = el(
            'button',
            isCurrent ? 'w-cover-choice is-selected' : 'w-cover-choice'
          )
          btn.type = 'button'
          btn.disabled = busy
          btn.dataset.choiceKey = 'post:' + path
          btn.setAttribute(
            'aria-label',
            post.title || lang.transl('_w_untitledPost')
          )

          const img = el('img', 'w-cover-choice-img')
          img.loading = 'lazy'
          img.decoding = 'async'
          img.alt = ''
          img.src = thumbUrl(host, path)
          btn.appendChild(img)

          btn.addEventListener('click', () => {
            if (busy) return
            busy = true
            void (async () => {
              try {
                await deleteOldCoverUpload(creator)
                await watchStore.updateCreator(creator.key, {
                  cover: { kind: 'post', path },
                })
                close()
              } finally {
                busy = false
              }
            })()
          })
          grid.appendChild(btn)
        }
        body.appendChild(grid)
      }
      const more = makeLoadMore(opts.loader, loadState, render, () => closed)
      if (more) body.appendChild(more)
    } else {
      const uploadBox = el('div', 'w-upload-box')
      uploadBox.appendChild(
        el('p', 'w-muted', lang.transl('_w_coverUploadHint'))
      )
      const fileInput = el('input', 'w-file-input')
      fileInput.type = 'file'
      fileInput.accept = 'image/*'
      fileInput.disabled = busy
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0]
        if (!file || busy) return
        busy = true
        errorMsg = ''
        render()
        void (async () => {
          try {
            const blob = await resizeCoverImage(file)
            const id = makeCoverId()
            await coverStore.put(id, blob)
            await deleteOldCoverUpload(creator)
            await watchStore.updateCreator(creator.key, {
              cover: { kind: 'upload', id },
            })
            close()
          } catch (e) {
            errorMsg = lang.transl(
              '_w_coverUploadFailed',
              e instanceof Error ? e.message : String(e)
            )
            busy = false
            render()
          }
        })()
      })
      uploadBox.appendChild(fileInput)
      if (errorMsg) {
        const err = el('p', 'w-error-text', errorMsg)
        err.setAttribute('role', 'alert')
        uploadBox.appendChild(err)
      }
      body.appendChild(uploadBox)
    }
    dialog.appendChild(body)

    const footer = el('div', 'w-modal-footer')
    const resetBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_w_coverReset')
    )
    resetBtn.type = 'button'
    resetBtn.disabled = busy || !creator.cover
    resetBtn.addEventListener('click', () => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          await deleteOldCoverUpload(creator)
          await watchStore.updateCreator(creator.key, { cover: null })
          close()
        } finally {
          busy = false
        }
      })()
    })
    footer.appendChild(resetBtn)

    const doneBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_w_close')
    )
    doneBtn.type = 'button'
    doneBtn.addEventListener('click', close)
    footer.appendChild(doneBtn)

    dialog.appendChild(footer)
    restore?.()
  }

  shell.mount()
  render()
  getFocusable(dialog)[0]?.focus()
}

export function openPreviewPicker(opts: PreviewPickerOptions): void {
  const { creator, posts, host, triggerEl } = opts
  const max = opts.max ?? MAX_PREVIEWS

  // Saved images for this creator (newest first, deduplicated by path)
  const seenFavPaths = new Set<string>()
  const creatorFavImages = Object.values(favImages.data.items)
    .filter(
      (img) =>
        img.site === creator.site &&
        img.service === creator.service &&
        img.creatorId === creator.creatorId
    )
    .sort((a, b) => b.addedAt - a.addedAt)
    .filter((img) => {
      if (seenFavPaths.has(img.path)) return false
      seenFavPaths.add(img.path)
      return true
    })

  // Snapshot/page post covers (deduplicated by coverPath). Recomputed on
  // each render because the loader appends older posts to `posts`.
  const coverPosts = (): SnapshotPost[] => {
    const seenPostPaths = new Set<string>()
    return (opts.loader?.posts() ?? posts).filter((p) => {
      if (!p.coverPath || seenPostPaths.has(p.coverPath)) return false
      seenPostPaths.add(p.coverPath)
      return true
    })
  }

  const initialPreviews: WatchCover[] = creator.previews
    ? [...creator.previews]
    : []
  let selection: WatchCover[] = [...initialPreviews]

  // Track all upload IDs created in this session or initially present
  const sessionUploadIds = new Set<string>()
  const knownUploadIds: string[] = []
  for (const item of initialPreviews) {
    if (item.kind === 'upload' && !knownUploadIds.includes(item.id)) {
      knownUploadIds.push(item.id)
    }
  }

  let activeTab: PreviewTab =
    creatorFavImages.length > 0
      ? 'favImages'
      : coverPosts().length > 0
        ? 'posts'
        : 'upload'
  let renderedTab: PreviewTab | null = null
  let errorMsg = ''
  let busy = false
  let closed = false
  const loadState = { loading: false, error: '' }

  const finishClose = (): void => {
    if (closed) return
    closed = true
    shell.unmount()
    if (triggerEl && triggerEl.isConnected) {
      triggerEl.focus()
    }
  }

  const cancel = (): void => {
    if (closed) return
    // Clean up any uploads created during this cancelled session
    const toDelete = Array.from(sessionUploadIds)
    sessionUploadIds.clear()
    finishClose()
    for (const id of toDelete) {
      void coverStore.delete(id)
    }
  }

  const save = async (): Promise<void> => {
    if (busy || closed) return
    busy = true
    render()
    try {
      const next = selection.slice(0, max)
      await watchStore.updateCreator(creator.key, {
        previews: next.length > 0 ? next : null,
      })

      // Delete uploads removed from initialPreviews and any session uploads not kept
      const keepIds = new Set<string>()
      for (const item of next) {
        if (item.kind === 'upload') keepIds.add(item.id)
      }
      if (creator.cover?.kind === 'upload') {
        keepIds.add(creator.cover.id)
      }

      const toDelete = new Set<string>(
        removedUploadIds(initialPreviews, next, creator.cover)
      )
      for (const id of sessionUploadIds) {
        if (!keepIds.has(id)) toDelete.add(id)
      }
      sessionUploadIds.clear()

      for (const id of toDelete) {
        await coverStore.delete(id)
      }
      finishClose()
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e)
      busy = false
      if (!closed) render()
    }
  }

  const shell = createModalShell(lang.transl('_pv_modalTitle'), cancel)
  const { dialog } = shell

  const buildChoiceButton = (
    cover: WatchCover,
    label: string,
    imgSrcPromise: string | Promise<string | undefined>
  ): HTMLButtonElement => {
    const orderIdx = selection.findIndex((s) => sameWatchCover(s, cover))
    const isSelected = orderIdx !== -1
    const atCap = !isSelected && selection.length >= max

    const btn = el(
      'button',
      isSelected
        ? 'w-cover-choice w-preview-choice is-selected'
        : atCap
          ? 'w-cover-choice w-preview-choice is-capped'
          : 'w-cover-choice w-preview-choice'
    )
    btn.type = 'button'
    btn.disabled = busy || atCap
    btn.dataset.choiceKey = previewKey(cover)
    btn.setAttribute('aria-pressed', String(isSelected))
    btn.setAttribute('aria-label', label)

    const appendImg = (url: string): void => {
      const img = el('img', 'w-cover-choice-img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = ''
      img.addEventListener('error', () => {
        img.remove()
      })
      img.src = url
      btn.appendChild(img)
    }

    if (typeof imgSrcPromise === 'string') {
      if (imgSrcPromise) appendImg(imgSrcPromise)
    } else {
      void imgSrcPromise.then((url) => {
        if (!closed && btn.isConnected && url) appendImg(url)
      })
    }

    if (isSelected) {
      const badge = el('span', 'w-cover-order-badge', String(orderIdx + 1))
      badge.setAttribute('aria-hidden', 'true')
      btn.appendChild(badge)
    }

    btn.addEventListener('click', () => {
      if (busy) return
      selection = togglePreviewItem(selection, cover, max)
      render()
    })

    return btn
  }

  const render = (): void => {
    const restore = renderedTab === activeTab ? keepViewState(dialog) : null
    renderedTab = activeTab
    dialog.replaceChildren()
    dialog.appendChild(makeModalHeader(lang.transl('_pv_modalTitle'), cancel))

    const tabs = el('div', 'w-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.appendChild(
      makeTabButton(
        lang.transl('_pv_tabFavImages'),
        activeTab === 'favImages',
        () => {
          activeTab = 'favImages'
          errorMsg = ''
          render()
        }
      )
    )
    tabs.appendChild(
      makeTabButton(
        lang.transl('_w_coverTabPosts'),
        activeTab === 'posts',
        () => {
          activeTab = 'posts'
          errorMsg = ''
          render()
        }
      )
    )
    tabs.appendChild(
      makeTabButton(
        lang.transl('_w_coverTabUpload'),
        activeTab === 'upload',
        () => {
          activeTab = 'upload'
          errorMsg = ''
          render()
        }
      )
    )
    dialog.appendChild(tabs)

    const body = el('div', 'w-modal-body')
    if (activeTab === 'favImages') {
      if (creatorFavImages.length === 0) {
        body.appendChild(el('p', 'w-muted', lang.transl('_pv_noFavImages')))
      } else {
        const grid = el('div', 'w-cover-grid')
        for (const item of creatorFavImages) {
          const cover: WatchCover = { kind: 'post', path: item.path }
          const label =
            item.fileName || item.postTitle || lang.transl('_w_untitledPost')
          grid.appendChild(
            buildChoiceButton(cover, label, thumbUrl(host, item.path))
          )
        }
        body.appendChild(grid)
      }
    } else if (activeTab === 'posts') {
      const postsWithCover = coverPosts()
      if (postsWithCover.length === 0) {
        body.appendChild(el('p', 'w-muted', lang.transl('_w_coverNoPosts')))
      } else {
        const grid = el('div', 'w-cover-grid')
        for (const post of postsWithCover) {
          const path = post.coverPath!
          const cover: WatchCover = { kind: 'post', path }
          const label = post.title || lang.transl('_w_untitledPost')
          grid.appendChild(
            buildChoiceButton(cover, label, thumbUrl(host, path))
          )
        }
        body.appendChild(grid)
      }
      const more = makeLoadMore(opts.loader, loadState, render, () => closed)
      if (more) body.appendChild(more)
    } else {
      const uploadBox = el('div', 'w-upload-box')
      uploadBox.appendChild(
        el('p', 'w-muted', lang.transl('_pv_uploadHint', String(max)))
      )
      const fileInput = el('input', 'w-file-input')
      fileInput.type = 'file'
      fileInput.accept = 'image/*'
      fileInput.multiple = true
      fileInput.disabled = busy || selection.length >= max
      fileInput.addEventListener('change', () => {
        const files = fileInput.files ? Array.from(fileInput.files) : []
        if (files.length === 0 || busy) return
        const remaining = max - selection.length
        if (remaining <= 0) return

        busy = true
        errorMsg = ''
        render()
        void (async () => {
          const added: WatchCover[] = []
          try {
            for (const file of files.slice(0, remaining)) {
              const blob = await resizeCoverImage(file)
              const id = makeCoverId()
              await coverStore.put(id, blob)
              if (closed) {
                await coverStore.delete(id)
                return
              }
              sessionUploadIds.add(id)
              if (!knownUploadIds.includes(id)) knownUploadIds.push(id)
              added.push({ kind: 'upload', id })
            }
            if (added.length > 0) {
              selection = appendPreviews(selection, added, max)
            }
          } catch (e) {
            errorMsg = lang.transl(
              '_w_coverUploadFailed',
              e instanceof Error ? e.message : String(e)
            )
          } finally {
            busy = false
            if (!closed) render()
          }
        })()
      })
      uploadBox.appendChild(fileInput)
      if (errorMsg) {
        const err = el('p', 'w-error-text', errorMsg)
        err.setAttribute('role', 'alert')
        uploadBox.appendChild(err)
      }

      if (knownUploadIds.length > 0) {
        uploadBox.appendChild(
          el('div', 'w-field-label', lang.transl('_pv_uploadedHeading'))
        )
        const grid = el('div', 'w-cover-grid')
        for (const id of knownUploadIds) {
          const cover: WatchCover = { kind: 'upload', id }
          grid.appendChild(
            buildChoiceButton(
              cover,
              lang.transl('_w_coverTabUpload'),
              coverStore.objectUrl(id)
            )
          )
        }
        uploadBox.appendChild(grid)
      }
      body.appendChild(uploadBox)
    }
    dialog.appendChild(body)

    const footer = el('div', 'w-modal-footer w-preview-picker-footer')
    const left = el('div', 'w-preview-picker-status')
    left.appendChild(
      el(
        'span',
        'w-muted',
        lang.transl('_pv_selectedCount', String(selection.length), String(max))
      )
    )
    const clearBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_pv_clearAll')
    )
    clearBtn.type = 'button'
    clearBtn.disabled = busy || selection.length === 0
    clearBtn.addEventListener('click', () => {
      selection = []
      render()
    })
    left.appendChild(clearBtn)
    footer.appendChild(left)

    const right = el('div', 'w-preview-picker-actions')
    const cancelBtn = el(
      'button',
      'w-btn w-btn-secondary',
      lang.transl('_w_close')
    )
    cancelBtn.type = 'button'
    cancelBtn.disabled = busy
    cancelBtn.addEventListener('click', cancel)
    right.appendChild(cancelBtn)

    const saveBtn = el('button', 'w-btn w-btn-primary', lang.transl('_pv_save'))
    saveBtn.type = 'button'
    saveBtn.disabled = busy
    saveBtn.addEventListener('click', () => {
      void save()
    })
    right.appendChild(saveBtn)
    footer.appendChild(right)

    dialog.appendChild(footer)
    restore?.()
  }

  shell.mount()
  render()
  getFocusable(dialog)[0]?.focus()
}
