/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Entry point for the full-page watchlist tab (watch.html). */

import { EVT } from './EVT'
import { lang } from './Language'
import { settings } from './setting/Settings'
import { WatchApp } from './watchpage/app'

function syncHtmlLang(): void {
  document.documentElement.lang = lang.htmlLang()
}

async function init(): Promise<void> {
  await settings.restore()
  syncHtmlLang()
  EVT.on(EVT.list.langChange, syncHtmlLang)

  const root = document.getElementById('app')
  if (!root) return
  const app = new WatchApp(root)
  await app.start()
}

void init()
