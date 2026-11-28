/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Creator page preview: hovering a creator's avatar (or a creator link that
 * has no avatar, such as the creator name above a post) shows a float with
 * the covers of the creator's latest posts (first page of the posts API).
 * The float shows exactly `previewCreatorCount` covers and does not scroll,
 * so only that many cover images are downloaded.
 *
 * Hover is tracked with delegated mouseover/mouseout on the document, so
 * cards the site renders later need no binding. The float sits beside the
 * hovered card, off the cursor (fitPreview). With keepCreatorPreviewOnFloatHover on, it stays open
 * while the cursor is on it: clicking a cover opens that post, clicking
 * anywhere else opens the creator's page. With it off, the float closes as
 * soon as the cursor leaves the avatar. */

import { EVT } from '../EVT'
import { lang } from '../Language'
import { markTransient } from '../PageRoots'
import { toast } from '../Toast'
import { api } from '../kemono/api'
import type { PostsApiResponse } from '../kemono/apiTypes'
import { settings } from '../setting/Settings'
import { states } from '../store/States'
import { snapshotFromPosts, snapshots } from '../watch/snapshot'
import { makeCreatorKey, siteOfHost } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'
import { UNSORTED_FOLDER_ID } from '../watch/watchTypes'
import {
  creatorGridShape,
  creatorPostCountLabel,
  creatorPostCover,
  creatorPostPath,
  parseCreatorHref,
  type CreatorRef,
} from './creatorPreviewModel'
import { fitPreview } from './previewLayout'

/** Delay before closing after the cursor leaves the avatar or the float (ms).
 * Gives the cursor time to cross the gap between the avatar and the float. */
const CLOSE_DELAY = 200

/** Cover size before the float is scaled down to fit the window (px) */
const TILE = 112

/** Space around and between covers (px); matches the grid's CSS */
const GAP = 4

/** What the cursor is on: the creator link and the part of it that triggers */
interface Trigger {
  anchor: HTMLAnchorElement
  /** The avatar when the link has one, else the whole link */
  zone: Element
  ref: CreatorRef
  key: string
}

/** Resolve the creator trigger under an event target, or null */
function triggerAt(target: EventTarget | null): Trigger | null {
  if (!(target instanceof Element)) return null
  // Our own UI (this float, the settings center, ...) never triggers
  if (target.closest('[data-pwp-root]')) return null
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return null
  const ref = parseCreatorHref(anchor.getAttribute('href') ?? '')
  if (!ref) return null
  const avatar =
    anchor.querySelector('.user-card__icon') ??
    anchor.querySelector('img[src*="/icons/"]')
  const zone = avatar ?? anchor
  if (!zone.contains(target)) return null
  return { anchor, zone, ref, key: `${ref.service}/${ref.creatorId}` }
}

class PreviewCreator {
  private wrap: HTMLDivElement | null = null
  private grid: HTMLDivElement | null = null
  private countEl: HTMLSpanElement | null = null
  private statusEl: HTMLDivElement | null = null
  /** The trigger the float belongs to (or is about to open for) */
  private trigger: Trigger | null = null
  private pendingTimer = 0
  private closeTimer = 0
  private loadToken = 0
  private abort: AbortController | null = null
  private cursor: { x: number; y: number } | null = null
  /** Cursor position when the float opened; a re-layout keeps the same spot */
  private anchorPt = { x: 0, y: 0 }
  private unsubWatch: (() => void) | null = null
  private loadedPosts: PostsApiResponse | null = null
  private currentWatchKey: string | null = null

  constructor() {
    document.addEventListener('mouseover', (ev) => this.onOver(ev), true)
    document.addEventListener('mouseout', (ev) => this.onOut(ev), true)
    window.addEventListener(
      'pointermove',
      (ev) => (this.cursor = { x: ev.clientX, y: ev.clientY }),
      { capture: true, passive: true }
    )
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.wrap) this.close()
    })
    window.addEventListener('pagehide', () => this.close())
    window.addEventListener('popstate', () => this.close())
    EVT.on(EVT.list.pageSwitch, () => this.close())
    EVT.on(EVT.list.settingChange, (ev: CustomEventInit) => {
      const key = ev.detail?.data?.key
      if (key === 'PreviewCreator' && !settings.get('PreviewCreator')) {
        this.close()
      }
    })
  }

  private onOver(ev: MouseEvent): void {
    const t = triggerAt(ev.target)
    if (!t) return
    window.clearTimeout(this.closeTimer)
    // Same creator: already shown or about to be
    if (this.trigger?.key === t.key && (this.wrap || this.pendingTimer)) {
      this.trigger = t
      return
    }
    if (!settings.get('PreviewCreator')) return
    // The post preview and the full-size viewer take priority
    if (states.previewWorkIsShow) return
    if (document.querySelector('#originSizeWrap')) return
    window.clearTimeout(this.pendingTimer)
    this.trigger = t
    this.cursor = { x: ev.clientX, y: ev.clientY }
    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = 0
      void this.show(t)
    }, settings.get('previewWorkWait'))
  }

  private onOut(ev: MouseEvent): void {
    const t = triggerAt(ev.target)
    if (!t) return
    const to = ev.relatedTarget
    // Moving between the avatar's own child elements
    if (to instanceof Node && t.zone.contains(to)) return
    // Left before the delay ran out: do not open
    if (this.pendingTimer) {
      window.clearTimeout(this.pendingTimer)
      this.pendingTimer = 0
      if (!this.wrap) this.trigger = null
    }
    this.scheduleClose()
  }

  /** Close after CLOSE_DELAY unless the cursor is back on the avatar, or on
   * the float when keepCreatorPreviewOnFloatHover is on */
  private scheduleClose(): void {
    if (!this.wrap) return
    window.clearTimeout(this.closeTimer)
    this.closeTimer = window.setTimeout(() => {
      if (this.keepOnFloat() && this.cursorOn(this.wrap)) return
      if (this.trigger && this.cursorOn(this.trigger.zone)) return
      this.close()
    }, CLOSE_DELAY)
  }

  private keepOnFloat(): boolean {
    return settings.get('keepCreatorPreviewOnFloatHover')
  }

  /** Hit-test by the last known cursor position as well as :hover, since
   * :hover is not updated for an element that appears under a still cursor */
  private cursorOn(el: Element | null): boolean {
    if (!el || !el.isConnected) return false
    if (el.matches(':hover')) return true
    const c = this.cursor
    if (!c) return false
    const r = el.getBoundingClientRect()
    return c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom
  }

  private async show(t: Trigger): Promise<void> {
    if (!t.anchor.isConnected || !settings.get('PreviewCreator')) return
    if (states.previewWorkIsShow) return
    this.close()
    this.trigger = t
    const token = ++this.loadToken
    this.build(t)
    this.setStatus(lang.transl('_loading'))

    const abort = new AbortController()
    this.abort = abort
    let posts
    try {
      posts = await api.posts(t.ref, abort.signal)
    } catch {
      if (token === this.loadToken) this.setStatus(lang.transl('_loadFailed'))
      return
    }
    if (token !== this.loadToken) return
    if (api.isErrorResponse(posts) || !Array.isArray(posts)) {
      this.setStatus(lang.transl('_loadFailed'))
      return
    }
    this.loadedPosts = posts
    if (this.currentWatchKey && watchStore.isWatched(this.currentWatchKey)) {
      const snapKey = this.currentWatchKey
      void snapshots
        .set(snapshotFromPosts(snapKey, posts))
        .catch((err) =>
          console.warn('[Better Pawchive] save watch snapshot failed', err)
        )
    }
    if (this.countEl) {
      this.countEl.textContent = lang.transl(
        '_creatorPreviewPosts',
        creatorPostCountLabel(posts.length)
      )
    }
    if (posts.length === 0) {
      this.setStatus(lang.transl('_creatorPreviewEmpty'))
      return
    }
    this.setStatus(null)
    // Only the set number of posts: the float does not scroll, so no cover
    // past this number is ever downloaded
    const shown = posts.slice(0, settings.get('previewCreatorCount'))
    // Fewer posts than the setting: shrink the float to fit them
    if (shown.length < settings.get('previewCreatorCount')) {
      this.layout(shown.length)
    }
    const host = location.host
    for (const post of shown) {
      const tile = document.createElement('div')
      tile.className = 'pwpCP-tile'
      tile.title = post.title
      tile.dataset.path = creatorPostPath(t.ref, post.id)
      const src = creatorPostCover(post, host)
      const noCover = () => {
        tile.classList.add('pwpCP-noCover')
        tile.textContent = post.title || '—'
      }
      if (src) {
        const img = document.createElement('img')
        img.decoding = 'async'
        img.alt = ''
        img.onerror = () => noCover()
        img.src = src
        tile.appendChild(img)
      } else {
        noCover()
      }
      this.grid?.appendChild(tile)
    }
  }

  /** Create the float beside the cursor, sized for previewCreatorCount covers */
  private build(t: Trigger): void {
    const wrap = document.createElement('div')
    wrap.id = 'pwpCreatorPreview'
    const head = document.createElement('div')
    head.className = 'pwpCP-head'
    const name = document.createElement('span')
    name.className = 'pwpCP-name'
    const creatorName =
      t.anchor.querySelector('.user-card__name')?.textContent?.trim() ||
      t.anchor.textContent?.trim() ||
      t.ref.creatorId
    name.textContent = creatorName
    const count = document.createElement('span')
    count.className = 'pwpCP-count'
    head.append(name, count)

    const site = siteOfHost(location.host)
    if (site) {
      const watchKey = makeCreatorKey(site, t.ref.service, t.ref.creatorId)
      this.currentWatchKey = watchKey
      const star = document.createElement('button')
      star.type = 'button'
      star.className = 'pwpCP-star'
      const syncStar = () => {
        const watched = watchStore.isWatched(watchKey)
        star.textContent = watched ? '★' : '☆'
        star.classList.toggle('is-active', watched)
        const label = lang.transl(
          watched ? '_ws_removeFromWatch' : '_ws_addToWatch'
        )
        star.title = label
        star.setAttribute('aria-label', label)
        star.setAttribute('aria-pressed', String(watched))
      }
      syncStar()
      this.unsubWatch = watchStore.onChange(syncStar)
      star.addEventListener('auxclick', (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
      })
      star.addEventListener('click', (ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        void (async () => {
          try {
            if (watchStore.isWatched(watchKey)) {
              await watchStore.removeCreators([watchKey])
              await snapshots.remove([watchKey]).catch(() => {})
              toast.success(lang.transl('_ws_removed'))
            } else {
              await watchStore.addCreator(
                {
                  site,
                  service: t.ref.service,
                  creatorId: t.ref.creatorId,
                  name: creatorName,
                },
                UNSORTED_FOLDER_ID
              )
              toast.success(
                lang.transl('_ws_added', lang.transl('_w_unsorted'))
              )
              if (this.currentWatchKey === watchKey && this.loadedPosts) {
                void snapshots
                  .set(snapshotFromPosts(watchKey, this.loadedPosts))
                  .catch((err) =>
                    console.warn(
                      '[Better Pawchive] save watch snapshot failed',
                      err
                    )
                  )
              }
            }
          } catch (err) {
            toast.error(lang.transl('_ws_saveFailed', String(err)))
          }
        })()
      })
      head.appendChild(star)
    }
    const grid = document.createElement('div')
    grid.className = 'pwpCP-grid'
    const status = document.createElement('div')
    status.className = 'pwpCP-status'
    wrap.append(head, grid, status)

    wrap.addEventListener('mouseenter', () => {
      // Off: being on the float does not keep it open
      if (this.keepOnFloat()) window.clearTimeout(this.closeTimer)
    })
    wrap.addEventListener('mouseleave', () => this.scheduleClose())
    wrap.addEventListener('click', (ev) => this.open(t, ev))
    wrap.addEventListener('auxclick', (ev) => {
      if (ev.button === 1) this.open(t, ev)
    })

    document.body.appendChild(wrap)
    markTransient(wrap)
    this.wrap = wrap
    this.grid = grid
    this.countEl = count
    this.statusEl = status
    this.anchorPt = this.cursor ?? { x: 0, y: 0 }
    this.layout(settings.get('previewCreatorCount'))
  }

  /** Size and place the float for `count` covers: `rows` rows of `cols`
   * covers before scaling, scaled down (never up) to fit beside the hovered
   * card (or the point where the preview opened) */
  private layout(count: number): void {
    if (!this.wrap || !this.grid) return
    const { cols, rows } = creatorGridShape(count)
    const naturalW = cols * TILE + (cols + 1) * GAP
    const naturalH = rows * TILE + (rows + 1) * GAP
    const head = this.wrap.querySelector<HTMLElement>('.pwpCP-head')
    const chromeH = (head?.offsetHeight ?? 0) + 2
    const c = this.anchorPt
    const fit = fitPreview({
      mouseX: c.x,
      mouseY: c.y,
      // Stay off the hovered creator card too
      avoid: this.trigger?.anchor.isConnected
        ? this.trigger.anchor.getBoundingClientRect()
        : null,
      naturalW,
      naturalH,
      chromeW: 2,
      chromeH,
      // clientWidth/Height exclude a classic scrollbar; the float is fixed
      viewW: document.documentElement.clientWidth,
      viewH: document.documentElement.clientHeight,
    })
    const tile = Math.max(24, (fit.imgW - (cols + 1) * GAP) / cols)
    this.grid.style.setProperty('--pwpcp-cols', String(cols))
    this.grid.style.setProperty('--pwpcp-tile', `${tile}px`)
    this.grid.style.width = `${fit.imgW}px`
    this.grid.style.height = `${fit.imgH}px`
    // Fix the wrap width (content box, plus the 1px borders = chromeW 2) so a
    // long creator name in the nowrap head cannot widen the float past the
    // planned size; the name ellipsizes instead
    this.wrap.style.width = `${fit.imgW}px`
    this.wrap.style.left = `${fit.x}px`
    this.wrap.style.top = `${fit.y}px`
  }

  private setStatus(text: string | null): void {
    if (!this.statusEl) return
    this.statusEl.textContent = text ?? ''
    this.statusEl.style.display = text === null ? 'none' : ''
  }

  /** Open what was clicked: a cover opens that post, anywhere else opens the
   * creator's page. A plain click on the creator goes through the site's own
   * link, so Kemono's router / Pawchive's htmx boost handle it like a normal
   * click; a post has no link on this page, so it loads as a new page. */
  private open(t: Trigger, ev: MouseEvent): void {
    ev.preventDefault()
    ev.stopPropagation()
    const tile =
      ev.target instanceof Element
        ? ev.target.closest<HTMLElement>('.pwpCP-tile')
        : null
    const postPath = tile?.dataset.path
    const url = postPath ? new URL(postPath, location.href).href : t.anchor.href
    const newTab = ev.button === 1 || ev.ctrlKey || ev.metaKey || ev.shiftKey
    this.close()
    if (newTab) {
      window.open(url, '_blank', 'noopener')
    } else if (!postPath && t.anchor.isConnected) {
      t.anchor.click()
    } else {
      location.assign(url)
    }
  }

  private close(): void {
    window.clearTimeout(this.pendingTimer)
    window.clearTimeout(this.closeTimer)
    this.pendingTimer = 0
    this.loadToken++
    this.abort?.abort()
    this.abort = null
    this.unsubWatch?.()
    this.unsubWatch = null
    this.loadedPosts = null
    this.currentWatchKey = null
    this.trigger = null
    this.wrap?.remove()
    this.wrap = null
    this.grid = null
    this.countEl = null
    this.statusEl = null
  }
}

const previewCreator = new PreviewCreator()

export { previewCreator }
