/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Favorite post button and folder popover mounted on post pages. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import type { KemonoService } from '../kemono/apiTypes'
import { detectPage, MOUNT } from '../kemono/pages'
import { favPosts } from './collectStore'
import { openFolderMenu } from './folderMenu'
import { resolvePostMeta } from './postMeta'
import { sortedFolders } from './watchData'
import { makeFavPostKey, siteOfHost } from './watchKey'
import {
  UNSORTED_FOLDER_ID,
  type WatchFolder,
  type WatchSite,
} from './watchTypes'

const MOUNT_WAIT_MS = 10_000

interface PagePost {
  site: WatchSite
  service: KemonoService
  creatorId: string
  postId: string
  key: string
}

function folderDisplayName(folder: WatchFolder | undefined): string {
  if (!folder || folder.id === UNSORTED_FOLDER_ID) {
    return lang.transl('_w_unsorted')
  }
  return folder.name
}

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

    const target: PagePost = {
      site,
      service: page.service,
      creatorId: page.creatorId,
      postId: page.postId,
      key: makeFavPostKey(site, page.service, page.creatorId, page.postId),
    }
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
      onPick: (folderId, label) => this.saveToFolder(target, folderId, label),
      onCreateFolder: async (name) => (await favPosts.addFolder(name)).id,
      onRemove: saved ? () => this.removeFromFav(target) : undefined,
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

  private async saveToFolder(
    target: PagePost,
    folderId: string,
    folderLabel: string
  ): Promise<void> {
    try {
      await favPosts.ready()
      if (favPosts.has(target.key)) {
        await favPosts.move([target.key], folderId)
      } else {
        const meta = await resolvePostMeta(target)
        await favPosts.add(
          {
            key: target.key,
            site: target.site,
            service: target.service,
            creatorId: target.creatorId,
            postId: target.postId,
            title: meta.title,
            published: meta.published,
            coverPath: meta.coverPath,
            creatorName: meta.creatorName,
          },
          folderId
        )
      }
      toast.success(lang.transl('_fs_postSaved', folderLabel))
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    }
  }

  private async removeFromFav(target: PagePost): Promise<void> {
    try {
      await favPosts.remove([target.key])
      toast.success(lang.transl('_fs_removed'))
    } catch (err) {
      toast.error(lang.transl('_ws_saveFailed', String(err)))
    }
  }
}

export const postFavButton = new PostFavButton()
