/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Settings center: Watchlist page (live summary, open watch page button, and tracking settings). */

import { EVT } from '../../EVT'
import { lang } from '../../Language'
import { totalUnread } from '../../watch/watchData'
import { watchStore } from '../../watch/watchStore'
import { btnRow, checkRow, inputRow, section, tipCard } from './controls'

export function buildWatch(host: HTMLDivElement): void {
  const body = section(host, '_sc_watch')
  tipCard(body, '_ws_settingsTip')

  const summary = document.createElement('div')
  summary.className = 'pwpSC-row pwpSC-status'
  const renderSummary = () => {
    const data = watchStore.data
    const creators = Object.keys(data.creators).length
    const folders = data.folders.length
    summary.textContent = lang.transl(
      '_ws_summary',
      String(creators),
      String(folders)
    )
  }
  renderSummary()
  watchStore.onChange(renderSummary)
  EVT.on(EVT.list.langChange, renderSummary)
  body.appendChild(summary)

  btnRow(body, [
    {
      labelKey: '_ws_openWatchPage',
      key: 'watch_open',
      onClick: () => {
        void chrome.runtime.sendMessage({ msg: 'watch_open' })
      },
    },
  ])

  const trackBody = section(host, '_wt_secTracking')

  const trackSummary = document.createElement('div')
  trackSummary.className = 'pwpSC-row pwpSC-status'
  const renderTrackSummary = () => {
    const data = watchStore.data
    const tracked = Object.values(data.creators).filter(
      (c) => c.tracking?.enabled
    ).length
    const unread = totalUnread(data)
    trackSummary.textContent = lang.transl(
      '_wt_trackingSummary',
      String(tracked),
      String(unread)
    )
  }
  renderTrackSummary()
  watchStore.onChange(renderTrackSummary)
  EVT.on(EVT.list.langChange, renderTrackSummary)
  trackBody.appendChild(trackSummary)

  checkRow(trackBody, 'watchScanEnabled', '_wt_scanEnabled')
  inputRow(
    trackBody,
    'watchScanIntervalHours',
    '_wt_scanIntervalHours',
    'number',
    undefined,
    { min: '1', max: '168', step: '1' }
  )
  checkRow(trackBody, 'watchNotice', '_wt_noticeEnabled')
}
