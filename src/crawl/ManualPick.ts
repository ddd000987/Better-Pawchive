/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * Manual pick mode: while it is on, a plain click on a post card does not open
 * the post but adds it to (or removes it from) a selection, and picked cards
 * get a frame and a badge. "Save to cache" then crawls the picked posts and
 * saves them as one crawl cache entry (engine.crawlIds with picked), ignoring the filter settings.
 *
 * The mode and the selection live in this tab only: they survive SPA page
 * switches and are gone after a reload. Clicks are taken in the capture phase
 * on window, before the site's router (Kemono SPA links, Pawchive htmx boost)
 * sees them. Ctrl/Shift/Meta/Alt clicks and the middle button are left alone,
 * so opening a post in a new tab still works.
 */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { parsePostKeyFromHref } from '../preview/previewAssets'
import { states } from '../store/States'
import type { IDData } from '../store/StoreType'
import { toast } from '../Toast'
import { engine } from './engine'

/** Attribute set on picked post links; its value is the badge text */
const PICKED_ATTR = 'data-pwp-picked'
/** Links that may be post cards (the post key is checked on the href) */
const POST_LINK = 'a[href*="/post/"]'

/** The picked post keys, in the order they were picked */
export class PickSelection {
  private keys: string[] = []

  /** Pick the post, or unpick it if it was picked; returns whether it is
   * picked now */
  public toggle(postKey: string): boolean {
    const i = this.keys.indexOf(postKey)
    if (i === -1) {
      this.keys.push(postKey)
      return true
    }
    this.keys.splice(i, 1)
    return false
  }

  public has(postKey: string): boolean {
    return this.keys.includes(postKey)
  }

  public get size(): number {
    return this.keys.length
  }

  public list(): string[] {
    return [...this.keys]
  }

  /** Remove the given keys (posts that were crawled); others stay picked */
  public remove(postKeys: readonly string[]): void {
    const gone = new Set(postKeys)
    this.keys = this.keys.filter((k) => !gone.has(k))
  }

  public clear(): void {
    this.keys = []
  }
}

/** A click that would open the link in the same tab: left button and no
 * modifier. Other clicks (new tab, new window, download) are not taken. */
export function isPlainLeftClick(ev: {
  button: number
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  return (
    ev.button === 0 && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey && !ev.altKey
  )
}

class ManualPick {
  private on = false
  private readonly selection = new PickSelection()
  private observer: MutationObserver | null = null
  private markTimer = 0
  /** Post keys sent to the crawl started by save(), while it runs */
  private saving: string[] | null = null

  constructor() {
    EVT.on(EVT.list.pageSwitch, () => this.scheduleMark(500))
    EVT.on(EVT.list.langChange, () => {
      this.mark()
      this.changed()
    })
    // Busy state decides whether "Save to cache" can be pressed
    for (const ev of [
      EVT.list.crawlStart,
      EVT.list.crawlComplete,
      EVT.list.crawlEmpty,
      EVT.list.downloadStart,
      EVT.list.downloadComplete,
      EVT.list.downloadStop,
      EVT.list.downloadPause,
    ]) {
      EVT.on(ev, () => this.changed())
    }
  }

  public get active(): boolean {
    return this.on
  }

  public get count(): number {
    return this.selection.size
  }

  /** "Save to cache" can start: something is picked and nothing is running */
  public get canSave(): boolean {
    return (
      this.selection.size > 0 &&
      this.saving === null &&
      !states.busy &&
      !states.hasDownloadTask
    )
  }

  public setActive(on: boolean): void {
    if (on === this.on) {
      return
    }
    this.on = on
    if (on) {
      window.addEventListener('click', this.onClick, true)
      this.observer = new MutationObserver(() => this.scheduleMark(100))
      this.observer.observe(document.body, { childList: true, subtree: true })
    } else {
      window.removeEventListener('click', this.onClick, true)
      this.observer?.disconnect()
      this.observer = null
    }
    this.mark()
    this.changed()
  }

  public clear(): void {
    this.selection.clear()
    this.mark()
    this.changed()
  }

  /** Crawl the picked posts and save them as one crawl cache entry. The
   * posts that were added are unpicked once the crawl ends; the ones that
   * failed stay picked. A stopped crawl keeps all of them picked, since its
   * result is not saved. */
  public async save(): Promise<void> {
    if (this.selection.size === 0 || this.saving !== null) {
      return
    }
    if (states.busy || states.hasDownloadTask) {
      toast.warning(lang.transl('_pickBusy'))
      return
    }
    const keys = this.selection.list()
    const idList: IDData[] = keys.map((id) => ({ id, type: 'post' }))
    this.saving = keys
    this.changed()
    let started = false
    const onStart = () => {
      started = true
    }
    EVT.on(EVT.list.crawlStart, onStart, { once: true })
    let added: string[]
    try {
      added = await engine.crawlIds(idList, { picked: true })
    } finally {
      EVT.off(EVT.list.crawlStart, onStart)
      this.saving = null
    }
    if (started && !states.stopCrawl) {
      // Only the posts that made it into the result; a failed one stays
      // picked so that it can be tried again
      this.selection.remove(added)
      this.mark()
    }
    this.changed()
  }

  private readonly onClick = (ev: MouseEvent): void => {
    if (!this.on || !isPlainLeftClick(ev)) {
      return
    }
    const target = ev.target
    if (!(target instanceof Element)) {
      return
    }
    // Our own panels and floats are not post cards
    if (target.closest('[data-pwp-root]')) {
      return
    }
    const link = target.closest<HTMLAnchorElement>(POST_LINK)
    if (!link) {
      return
    }
    const postKey = parsePostKeyFromHref(link.href)
    if (!postKey) {
      return
    }
    ev.preventDefault()
    ev.stopImmediatePropagation()
    // No toast per click: the count is shown in the fixed bar (PickBar)
    this.selection.toggle(postKey)
    this.mark()
    this.changed()
  }

  /** Mark the visible cards later (cards re-rendered by the site lose the
   * attribute; several mutations in a row cost one pass) */
  private scheduleMark(delay: number): void {
    if (this.markTimer) {
      return
    }
    this.markTimer = window.setTimeout(() => {
      this.markTimer = 0
      this.mark()
    }, delay)
  }

  /** Put the frame and badge on picked cards and take them off the others.
   * Hidden while the mode is off; the selection itself is kept. */
  private mark(): void {
    const label = lang.transl('_pickedBadge')
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      POST_LINK
    )) {
      if (link.closest('[data-pwp-root]')) {
        continue
      }
      const postKey = this.on ? parsePostKeyFromHref(link.href) : null
      if (postKey && this.selection.has(postKey)) {
        if (link.getAttribute(PICKED_ATTR) !== label) {
          link.setAttribute(PICKED_ATTR, label)
        }
      } else if (link.hasAttribute(PICKED_ATTR)) {
        link.removeAttribute(PICKED_ATTR)
      }
    }
  }

  private changed(): void {
    EVT.fire('manualPickChange')
  }
}

const manualPick = new ManualPick()
export { manualPick }
