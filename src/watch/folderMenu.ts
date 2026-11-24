/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Reusable folder picker popover menu anchored to an on-site button. */

import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { UNSORTED_FOLDER_ID, type WatchFolder } from './watchTypes'

export interface FolderMenuExtraItem {
  label: string
  onClick: () => void
}

export interface OpenFolderMenuOptions {
  anchor: HTMLElement
  folders: WatchFolder[]
  currentFolderId: string | null
  unsortedLabel: string
  newFolderLabel?: string
  folderNamePlaceholder?: string
  removeLabel?: string
  onPick: (folderId: string, label: string) => void | Promise<void>
  onCreateFolder: (name: string) => Promise<string>
  onRemove?: () => void | Promise<void>
  extraItems?: FolderMenuExtraItem[]
  onError?: (err: unknown) => void
  onClose?: () => void
}

function positionMenu(menu: HTMLDivElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  const pad = 8
  const left = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad))
  let top = r.bottom + 4
  if (top + h > window.innerHeight - pad && r.top - h - 4 >= pad) {
    top = r.top - h - 4
  }
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

export function openFolderMenu(options: OpenFolderMenuOptions): () => void {
  const { anchor, folders, currentFolderId, unsortedLabel } = options
  let closed = false

  const menu = document.createElement('div')
  menu.className = 'pwpWatchMenu'
  menu.setAttribute('role', 'menu')
  menu.lang = lang.htmlLang()
  markTransient(menu)

  const onDocPointerDown = (ev: MouseEvent) => {
    const node = ev.target as Node | null
    if (node && (menu.contains(node) || anchor.contains(node))) return
    close()
  }
  const onWinKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('mousedown', onDocPointerDown, true)
    window.removeEventListener('keydown', onWinKeyDown, true)
    menu.remove()
    anchor.setAttribute('aria-expanded', 'false')
    options.onClose?.()
  }

  for (const folder of folders) {
    const label = folder.id === UNSORTED_FOLDER_ID ? unsortedLabel : folder.name
    const isCurrent = currentFolderId !== null && currentFolderId === folder.id
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'pwpWatchMenu-item'
    item.setAttribute('role', 'menuitem')
    if (isCurrent) {
      item.classList.add('is-active')
      item.setAttribute('aria-current', 'true')
    }
    const mark = document.createElement('span')
    mark.className = 'pwpWatchMenu-mark'
    mark.textContent = isCurrent ? '✓' : ''
    const text = document.createElement('span')
    text.className = 'pwpWatchMenu-label'
    text.textContent = label
    item.append(mark, text)
    item.addEventListener('click', () => {
      close()
      void options.onPick(folder.id, label)
    })
    menu.appendChild(item)
  }

  const sep1 = document.createElement('div')
  sep1.className = 'pwpWatchMenu-sep'
  menu.appendChild(sep1)

  const newFolderSlot = document.createElement('div')
  newFolderSlot.className = 'pwpWatchMenu-newSlot'
  const newFolderBtn = document.createElement('button')
  newFolderBtn.type = 'button'
  newFolderBtn.className = 'pwpWatchMenu-item'
  newFolderBtn.setAttribute('role', 'menuitem')
  newFolderBtn.textContent =
    options.newFolderLabel ?? lang.transl('_ws_newFolder')
  newFolderBtn.addEventListener('click', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'pwpWatchMenu-input'
    input.placeholder =
      options.folderNamePlaceholder ?? lang.transl('_w_folderNamePlaceholder')
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        const name = input.value.trim()
        if (!name) return
        close()
        void (async () => {
          try {
            const folderId = await options.onCreateFolder(name)
            if (folderId) {
              await options.onPick(folderId, name)
            }
          } catch (err) {
            if (options.onError) {
              options.onError(err)
            } else {
              console.error('[PawchivePro] create folder failed', err)
            }
          }
        })()
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        close()
      }
    })
    newFolderSlot.replaceChildren(input)
    input.focus()
  })
  newFolderSlot.appendChild(newFolderBtn)
  menu.appendChild(newFolderSlot)

  if (options.onRemove) {
    const removeFn = options.onRemove
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'pwpWatchMenu-item is-danger'
    removeBtn.setAttribute('role', 'menuitem')
    removeBtn.textContent =
      options.removeLabel ?? lang.transl('_w_removeSelected')
    removeBtn.addEventListener('click', () => {
      close()
      void removeFn()
    })
    menu.appendChild(removeBtn)
  }

  if (options.extraItems && options.extraItems.length > 0) {
    const sep2 = document.createElement('div')
    sep2.className = 'pwpWatchMenu-sep'
    menu.appendChild(sep2)

    for (const extra of options.extraItems) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pwpWatchMenu-item'
      btn.setAttribute('role', 'menuitem')
      btn.textContent = extra.label
      btn.addEventListener('click', () => {
        close()
        extra.onClick()
      })
      menu.appendChild(btn)
    }
  }

  document.body.appendChild(menu)
  anchor.setAttribute('aria-expanded', 'true')
  positionMenu(menu, anchor)

  document.addEventListener('mousedown', onDocPointerDown, true)
  window.addEventListener('keydown', onWinKeyDown, true)

  return close
}
