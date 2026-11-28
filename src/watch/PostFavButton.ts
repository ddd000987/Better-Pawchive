/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Favorite post button and folder popover mounted on post pages. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import { detectPage, MOUNT } from '../kemono/pages'
import { favPosts } from './collectStore'
import { openFolderMenu } from './folderMenu'
import {
  folderDisplayName,
  makeFavPostTarget,
  removePostFromFav,
  savePostToFolder,
  type FavPostTarget,
} from './favPostActions'
import { sortedFolders } from './watchData'
import { siteOfHost } from './watchKey'

const MOUNT_WAIT_MS = 10_000

type PagePost = FavPostTarget

class PostFavButton {
  private gen = 0
  private current: PagePost | null = null
  private btn: HTMLButtonElement | null = null
  private row: HTMLElement | null = null
  private closeMenuFn: (() => void) | null = null
  private observer: MutationObserver | null = null
  private mountTimer = 0

  constructor() {
    if (typeof document === 'undefined') return
    EVT.on(EVT.list.pageSwitch, () => this.onPage())
    EVT.on(EVT.list.langChange, () => this.updateButton())
    favPosts.onChange(() => this.updateButton())
    this.onPage()
  }

  private onPage(): void {
    const gen = ++this.gen
    this.disconnectMountWait()
    this.closeMenu()
    this.removeButton()
    this.current = null

    const page = detectPage()
    const site = siteOfHost(location.host)
    if (page.kind !== 'post' || !site) return

    const target: PagePost = makeFavPostTarget(
      site,
      page.service,
      page.creatorId,
      page.postId
    )
    this.current = target
    void favPosts.ready().then(() => {
      if (gen === this.gen) this.updateButton()
    })
    this.waitForMount(gen, target)
  }

  private waitForMount(gen: number, target: PagePost): void {
    const existing = document.querySelector<HTMLElement>(MOUNT.post)
    if (existing) {
      this.mountButton(existing, target)
      return
    }
    const observer = new MutationObserver(() => {
      if (gen !== this.gen) {
        this.disconnectMountWait()
        return
      }
      const mount = document.querySelector<HTMLElement>(MOUNT.post)
      if (mount) {
        this.disconnectMountWait()
        this.mountButton(mount, target)
      }
    })
    this.observer = observer
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    this.mountTimer = window.setTimeout(() => {
      this.disconnectMountWait()
    }, MOUNT_WAIT_MS)
  }

  private disconnectMountWait(): void {
    this.observer?.disconnect()
    this.observer = null
    if (this.mountTimer) {
      window.clearTimeout(this.mountTimer)
      this.mountTimer = 0
    }
  }

  private mountButton(actions: HTMLElement, target: PagePost): void {
    this.removeButton()
    for (const stale of document.querySelectorAll('.pwpPostFavRow')) {
      stale.remove()
    }
    const mount = document.createElement('div')
    mount.className = 'pwpWatchRow pwpPostFavRow'
    markTransient(mount)
    actions.after(mount)
    this.row = mount

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pwpWatchBtn pwpPostFavBtn'
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (this.closeMenuFn) {
        this.closeMenu()
      } else {
        this.openMenu(target)
      }
    })
    markTransient(btn)
    mount.appendChild(btn)
    this.btn = btn

    this.updateButton()
  }

  private removeButton(): void {
    this.row?.remove()
    this.row = null
    this.btn?.remove()
    this.btn = null
  }

  private updateButton(): void {
    if (!this.btn || !this.current) return
    const saved = favPosts.get(this.current.key)
    if (saved) {
      const folder = favPosts.data.folders.find((f) => f.id === saved.folderId)
      this.btn.textContent = `★ ${folderDisplayName(folder)}`
      this.btn.classList.add('is-saved')
    } else {
      this.btn.textContent = `☆ ${lang.transl('_fs_favPost')}`
      this.btn.classList.remove('is-saved')
    }
  }

  private openMenu(target: PagePost): void {
    if (!this.btn) return
    this.closeMenu()

    const saved = favPosts.get(target.key)
    const folders = sortedFolders(favPosts.data)

    this.closeMenuFn = openFolderMenu({
      anchor: this.btn,
      folders,
      currentFolderId: saved?.folderId ?? null,
      unsortedLabel: lang.transl('_w_unsorted'),
      removeLabel: lang.transl('_fs_removeFav'),
      onPick: (folderId, label) => savePostToFolder(target, folderId, label),
      onCreateFolder: async (name) => (await favPosts.addFolder(name)).id,
      onRemove: saved ? () => removePostFromFav(target) : undefined,
      extraItems: [
        {
          label: lang.transl('_fs_openFavPosts'),
          onClick: () => {
            void chrome.runtime.sendMessage({
              msg: 'watch_open',
              hash: '#/posts',
            })
          },
        },
      ],
      onError: (err) => {
        toast.error(lang.transl('_ws_saveFailed', String(err)))
      },
      onClose: () => {
        this.closeMenuFn = null
      },
    })
  }

  private closeMenu(): void {
    this.closeMenuFn?.()
    this.closeMenuFn = null
  }
}

export const postFavButton = new PostFavButton()
