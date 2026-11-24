/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Settings center home page: a guide for new users. It says what the current
 * page can do, walks through the two steps (crawl, then download), offers to
 * watch the creator of this page, and keeps a few common switches. Detailed
 * settings stay on the other pages. On Kemono, which has no original files
 * left, it skips the steps and says only previews and the watchlist work. */

import { EVT } from '../../EVT'
import { detectPage } from '../../kemono/pages'
import { lang } from '../../Language'
import { LangTextKey } from '../../localeTypes'
import { hasOriginalFiles } from '../../preview/previewAssets'
import { states } from '../../store/States'
import { store } from '../../store/Store'
import { totalUnread } from '../../watch/watchData'
import { siteOfHost } from '../../watch/watchKey'
import { watchButton } from '../../watch/WatchButton'
import { watchStore } from '../../watch/watchStore'
import { UNSORTED_FOLDER_ID } from '../../watch/watchTypes'
import { checkRow, section } from './controls'
import { CrawlControls } from './crawlControls'
import { CrawlProgressView } from './crawlProgress'
import { DownloadControls } from './downloadControls'
import { StatusRows } from './status'

/** Set a text element to a lang key, kept in sync on language change */
function setText(node: HTMLElement, key: LangTextKey, args: string[] = []) {
  if (args.length === 0) {
    delete node.dataset.xztextargs
    node.dataset.xztext = key
  } else {
    delete node.dataset.xztext
    node.dataset.xztextargs = [key, ...args].join(',')
  }
  node.textContent = lang.transl(key, ...args)
}

function div(className: string, textKey?: LangTextKey): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  if (textKey) setText(node, textKey)
  return node
}

/** One numbered step: number badge, title, one-line explanation, then the
 * controls the caller appends to the returned body */
function step(
  host: HTMLElement,
  num: string,
  titleKey: LangTextKey,
  descKey: LangTextKey
): { root: HTMLDivElement; body: HTMLDivElement } {
  const root = div('pwpSC-step')
  const badge = div('pwpSC-stepNum')
  badge.textContent = num
  const body = div('pwpSC-stepBody')
  body.append(div('pwpSC-stepTitle', titleKey), div('pwpSC-stepDesc', descKey))
  root.append(badge, body)
  host.appendChild(root)
  return { root, body }
}

export class HomeView {
  /** Context card and steps; absent on Kemono */
  private context?: HTMLDivElement
  private step1?: HTMLDivElement
  private step2?: HTMLDivElement
  private watchSection!: HTMLElement
  private watchStatus!: HTMLDivElement
  private watchBtn!: HTMLButtonElement
  private openWatchBtn!: HTMLButtonElement

  public build(
    host: HTMLDivElement,
    views: {
      status: StatusRows
      crawlControls: CrawlControls
      crawlProgress: CrawlProgressView
      dlControls: DownloadControls
    }
  ): void {
    const body = section(host, '_sc_home')
    const downloads = hasOriginalFiles()

    const intro = div('pwpSC-homeIntro')
    intro.append(
      div(
        'pwpSC-homeIntroTitle',
        downloads ? '_hm_introTitle' : '_hm_kemonoIntroTitle'
      ),
      div(
        'pwpSC-homeIntroText',
        downloads ? '_hm_introText' : '_hm_kemonoIntroText'
      )
    )
    body.appendChild(intro)

    if (downloads) {
      this.context = div('pwpSC-homeContext')
      body.appendChild(this.context)

      const steps = div('pwpSC-steps')
      body.appendChild(steps)

      const s1 = step(steps, '1', '_hm_step1Title', '_hm_step1Desc')
      this.step1 = s1.root
      s1.body.appendChild(views.status.createCrawl())
      views.crawlControls.build(s1.body)
      views.crawlProgress.build(s1.body)

      const s2 = step(steps, '2', '_hm_step2Title', '_hm_step2Desc')
      this.step2 = s2.root
      s2.body.appendChild(views.status.createDownload())
      views.dlControls.build(s2.body, { requireResult: true })
    }

    // Watch this page's creator (shown on creator pages only)
    const watchBody = section(host, '_hm_watchTitle')
    this.watchSection = watchBody.parentElement as HTMLElement
    watchBody.appendChild(div('pwpSC-homeHint', '_hm_watchDesc'))
    this.watchStatus = div('pwpSC-row pwpSC-status')
    watchBody.appendChild(this.watchStatus)
    const btnRow = div('pwpSC-row pwpSC-btnRow')
    btnRow.dataset.key = '_hm_watchTitle'
    this.watchBtn = document.createElement('button')
    this.watchBtn.type = 'button'
    this.watchBtn.setAttribute('aria-haspopup', 'menu')
    this.watchBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      watchButton.toggleMenuAt(this.watchBtn)
    })
    this.openWatchBtn = document.createElement('button')
    this.openWatchBtn.type = 'button'
    this.openWatchBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({ msg: 'watch_open' })
    })
    btnRow.append(this.watchBtn, this.openWatchBtn)
    watchBody.appendChild(btnRow)

    // Common switches; everything else is on the other pages
    const quick = section(host, '_hm_quickTitle')
    checkRow(quick, 'PreviewWork', '_f_PreviewWork')
    checkRow(quick, 'PreviewCreator', '_f_PreviewCreator')
    if (downloads) {
      checkRow(quick, 'showDownloadBtnOnThumb', '_f_showDownloadBtnOnThumb')
    }
    quick.appendChild(div('pwpSC-homeHint', '_hm_moreHint'))

    EVT.on(EVT.list.pageSwitch, () => this.refresh())
    EVT.on(EVT.list.langChange, () => this.refresh())
    watchStore.onChange(() => this.refresh())
    for (const ev of [
      EVT.list.crawlStart,
      EVT.list.crawlComplete,
      EVT.list.crawlEmpty,
      EVT.list.stopCrawl,
      EVT.list.resultChange,
      EVT.list.mountChange,
      EVT.list.downloadStart,
      EVT.list.downloadStop,
      EVT.list.downloadComplete,
    ]) {
      EVT.on(ev, () => this.refreshSteps())
    }
    this.refresh()
  }

  public refresh(): void {
    if (!this.watchSection) return
    this.refreshContext()
    this.refreshSteps()
    this.refreshWatch()
  }

  /** What this page is and what crawling it does */
  private refreshContext(): void {
    if (!this.context) return
    const page = detectPage()
    const key: LangTextKey =
      page.kind === 'creator'
        ? '_hm_ctxCreator'
        : page.kind === 'post'
          ? '_hm_ctxPost'
          : '_hm_ctxOther'
    setText(this.context, key)
    this.context.classList.toggle('is-unsupported', page.kind === 'other')
  }

  /** Step 1 is current until something is crawled, then step 2 is */
  private refreshSteps(): void {
    if (!this.step1 || !this.step2) return
    const crawled = store.result.length > 0
    const crawling = states.busy && !states.hasDownloadTask
    this.step1.classList.toggle('is-current', !crawled || crawling)
    this.step1.classList.toggle('is-done', crawled && !crawling)
    this.step2.classList.toggle('is-current', crawled && !crawling)
  }

  private refreshWatch(): void {
    const key = watchButton.pageCreatorKey
    const onCreatorPage =
      detectPage().kind === 'creator' && siteOfHost(location.host) !== null
    this.watchSection.hidden = !onCreatorPage
    const creator = key ? watchStore.getCreator(key) : undefined
    if (creator) {
      const folder = watchStore.data.folders.find(
        (f) => f.id === creator.folderId
      )
      const name =
        !folder || folder.id === UNSORTED_FOLDER_ID
          ? lang.transl('_w_unsorted')
          : folder.name
      // Folder names may hold commas, so this text is not kept in
      // data-xztextargs; refresh() runs again on language change
      delete this.watchStatus.dataset.xztext
      delete this.watchStatus.dataset.xztextargs
      this.watchStatus.textContent = lang.transl('_hm_watchingIn', name)
      setText(this.watchBtn, '_hm_watchChange')
    } else {
      setText(this.watchStatus, '_hm_notWatching')
      setText(this.watchBtn, '_hm_watchAdd')
    }
    const unread = totalUnread(watchStore.data)
    if (unread > 0) {
      setText(this.openWatchBtn, '_hm_openWatchUnread', [String(unread)])
    } else {
      setText(this.openWatchBtn, '_ws_openWatchPage')
    }
  }
}
