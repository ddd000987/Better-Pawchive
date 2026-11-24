/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Modal cover picker for choosing a post thumbnail, uploading an image, or resetting. */

import { lang } from '../Language'
import { thumbUrl } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import type { SnapshotPost, WatchedCreator } from '../watch/watchTypes'
import { coverStore, makeCoverId, resizeCoverImage } from './coverStore'
import { el } from './dom'

type PickerTab = 'posts' | 'upload'

export interface CoverPickerOptions {
  creator: WatchedCreator
  posts: SnapshotPost[]
  host: string
  triggerEl?: HTMLElement | null
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  return Array.from(nodes).filter((n) => n.offsetParent !== null)
}

async function deleteOldUpload(creator: WatchedCreator): Promise<void> {
  if (creator.cover?.kind === 'upload') {
    await coverStore.delete(creator.cover.id)
  }
}

export function openCoverPicker(opts: CoverPickerOptions): void {
  const { creator, posts, host, triggerEl } = opts
  const postsWithCover = posts.filter((p) => Boolean(p.coverPath))

  let activeTab: PickerTab = postsWithCover.length > 0 ? 'posts' : 'upload'
  let errorMsg = ''
  let busy = false

  const backdrop = el('div', 'w-modal-backdrop')
  const dialog = el('div', 'w-modal')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', lang.transl('_w_coverModalTitle'))
  backdrop.appendChild(dialog)

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown)
    backdrop.remove()
    if (triggerEl && triggerEl.isConnected) {
      triggerEl.focus()
    }
  }

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
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
    if (ev.target === backdrop) close()
  })

  const render = (): void => {
    dialog.replaceChildren()

    const header = el('div', 'w-modal-header')
    header.appendChild(
      el('h2', 'w-modal-title', lang.transl('_w_coverModalTitle'))
    )
    const closeBtn = el('button', 'w-icon-btn')
    closeBtn.type = 'button'
    closeBtn.textContent = '✕'
    closeBtn.setAttribute('aria-label', lang.transl('_w_close'))
    closeBtn.addEventListener('click', close)
    header.appendChild(closeBtn)
    dialog.appendChild(header)

    // Tabs
    const tabs = el('div', 'w-tabs')
    tabs.setAttribute('role', 'tablist')

    const postsTab = el(
      'button',
      activeTab === 'posts' ? 'w-tab is-active' : 'w-tab',
      lang.transl('_w_coverTabPosts')
    )
    postsTab.type = 'button'
    postsTab.setAttribute('role', 'tab')
    postsTab.setAttribute('aria-selected', String(activeTab === 'posts'))
    postsTab.addEventListener('click', () => {
      activeTab = 'posts'
      errorMsg = ''
      render()
    })

    const uploadTab = el(
      'button',
      activeTab === 'upload' ? 'w-tab is-active' : 'w-tab',
      lang.transl('_w_coverTabUpload')
    )
    uploadTab.type = 'button'
    uploadTab.setAttribute('role', 'tab')
    uploadTab.setAttribute('aria-selected', String(activeTab === 'upload'))
    uploadTab.addEventListener('click', () => {
      activeTab = 'upload'
      errorMsg = ''
      render()
    })

    tabs.appendChild(postsTab)
    tabs.appendChild(uploadTab)
    dialog.appendChild(tabs)

    // Body
    const body = el('div', 'w-modal-body')
    if (activeTab === 'posts') {
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
                await deleteOldUpload(creator)
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
            await deleteOldUpload(creator)
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

    // Footer
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
          await deleteOldUpload(creator)
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
  }

  document.body.appendChild(backdrop)
  document.addEventListener('keydown', onKeyDown)
  render()
  const focusable = getFocusable(dialog)
  focusable[0]?.focus()
}
