/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* 設定中心：幫助分頁 */

import { Config } from '../../Config'
import { EVT } from '../../EVT'
import { LangTextKey } from '../../langText'
import { formatHotkeyCombo } from '../hotkeyRules'
import { settings } from '../Settings'
import { helpItem, section, setHelpText } from './controls'

/** 幫助頁分區：標題 key＋條目 key */
const HELP_SECTIONS: Array<{ titleKey: LangTextKey; items: LangTextKey[] }> = [
  {
    titleKey: '_help_quick_title',
    items: ['_help_quick_1', '_help_quick_2', '_help_quick_3', '_help_quick_4'],
  },
  {
    titleKey: '_help_crawl_title',
    items: ['_help_crawl_1', '_help_crawl_2', '_help_crawl_3', '_help_crawl_4'],
  },
  {
    titleKey: '_help_download_title',
    items: [
      '_help_download_1',
      '_help_download_2',
      '_help_download_3',
      '_help_download_4',
      '_help_download_5',
      '_help_download_6',
      '_help_download_7',
      '_help_download_8',
    ],
  },
  {
    titleKey: '_help_cache_title',
    items: [
      '_help_cache_1',
      '_help_cache_2',
      '_help_cache_3',
      '_help_cache_4',
      '_help_cache_5',
      '_help_cache_6',
      '_help_cache_7',
    ],
  },
  {
    titleKey: '_help_preview_title',
    items: ['_help_preview_1', '_help_preview_2', '_help_preview_3'],
  },
  {
    titleKey: '_help_trouble_title',
    items: [
      '_help_trouble_1',
      '_help_trouble_2',
      '_help_trouble_3',
      '_help_trouble_4',
      '_help_trouble_5',
      '_help_trouble_6',
    ],
  },
  {
    titleKey: '_help_hotkey_title',
    items: ['_help_hotkey_1', '_help_hotkey_2'],
  },
]

/** Text of the first quick-start step: names the panel hotkey as currently
 * bound (the user may have changed it, or cleared it). */
function setPanelStep(p: HTMLElement): void {
  const combo = settings.get('hotkeys').commandToggleCrawlPanel
  if (!combo) {
    setHelpText(p, '_help_quick_1NoHotkey')
    return
  }
  const platform = Config.isMac ? 'mac' : Config.isWin ? 'win' : 'other'
  setHelpText(p, '_help_quick_1', [formatHotkeyCombo(combo, platform)])
}

export function buildHelp(host: HTMLDivElement): void {
  let panelStep: HTMLElement | undefined
  HELP_SECTIONS.forEach(({ titleKey, items }, i) => {
    const body = section(host, titleKey)
    // 只展開第一區，其餘預設收合（搜尋時會自動展開）
    if (i > 0) body.parentElement?.classList.add('collapsed')
    for (const k of items) {
      const p = helpItem(body, k)
      if (k === '_help_quick_1') panelStep = p
    }
  })
  if (panelStep) {
    const step = panelStep
    setPanelStep(step)
    // Follow rebinding (or reset) of the hotkey; also settings import / other tabs
    EVT.on(EVT.list.settingChange, (ev) => {
      if (
        (ev.detail?.data as { key?: string } | undefined)?.key === 'hotkeys'
      ) {
        setPanelStep(step)
      }
    })
  }
}
