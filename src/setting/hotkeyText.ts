/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Help and description texts that name hotkeys as they are currently bound
 * (the user may have changed or cleared them). An unbound hotkey is left out;
 * a text whose only hotkey is unbound uses its `...NoHotkey` variant. */

import { Config } from '../Config'
import { lang } from '../Language'
import type { LangTextKey } from '../localeTypes'
import { formatHotkeyCombo } from './hotkeyRules'
import { settings, type HotkeyCombo } from './Settings'

/** Settings whose change can alter the texts below */
export const hotkeyTextSettings: readonly string[] = [
  'hotkeys',
  'previewHotkeys',
]

function comboLabel(combo: HotkeyCombo | undefined): string | undefined {
  if (!combo) return undefined
  const platform = Config.isMac ? 'mac' : Config.isWin ? 'win' : 'other'
  return formatHotkeyCombo(combo, platform)
}

/** `key` with the combo filled in, or `key`NoHotkey when it is unbound */
function single(
  key: LangTextKey,
  noKey: LangTextKey,
  combo: HotkeyCombo | undefined
): string {
  const label = comboLabel(combo)
  return label ? lang.transl(key, label) : lang.transl(noKey)
}

/** One piece per bound hotkey (each piece key has a {} for the combo) */
function pieces<C extends string>(
  map: Partial<Record<C, HotkeyCombo>>,
  items: ReadonlyArray<readonly [C, LangTextKey]>
): string[] {
  return items.flatMap(([command, key]) => {
    const label = comboLabel(map[command])
    return label ? [lang.transl(key, label)] : []
  })
}

const joinList = (parts: string[]) => parts.join(lang.transl('_listSep'))

const texts: Partial<Record<LangTextKey, () => string>> = {
  _help_quick_1: () =>
    single(
      '_help_quick_1',
      '_help_quick_1NoHotkey',
      settings.get('hotkeys').commandToggleCrawlPanel
    ),
  _help_quick_2: () =>
    single(
      '_help_quick_2',
      '_help_quick_2NoHotkey',
      settings.get('hotkeys').commandStartDefaultCrawl
    ),
  _help_preview_1: () =>
    single(
      '_help_preview_1',
      '_help_preview_1NoHotkey',
      settings.get('hotkeys').commandTogglePreviewWork
    ),
  _d_showFloatingButton: () =>
    single(
      '_d_showFloatingButton',
      '_d_showFloatingButtonNoHotkey',
      settings.get('hotkeys').commandToggleCrawlPanel
    ),
  _help_hotkey_1: () => {
    const parts = pieces(settings.get('hotkeys'), [
      ['commandToggleCrawlPanel', '_hkHelp_togglePanel'],
      ['commandStartDefaultCrawl', '_hkHelp_startCrawl'],
      ['commandTogglePreviewWork', '_hkHelp_togglePreview'],
    ])
    return parts.length > 0
      ? lang.transl('_help_hotkey_1', joinList(parts))
      : lang.transl('_help_hotkey_1NoHotkey')
  },
  _help_hotkey_2: () => {
    const parts = pieces(settings.get('previewHotkeys'), [
      ['previewDownloadPost', '_hkHelp_downloadPost'],
      ['previewDownloadImage', '_hkHelp_downloadImage'],
      ['previewFavoriteImage', '_hkHelp_favoriteImage'],
      ['previewOpenOriginal', '_hkHelp_openOriginal'],
      ['previewOpenWindow', '_hkHelp_openWindow'],
    ])
    const list = joinList([
      lang.transl('_hkHelp_wheel'),
      ...parts,
      lang.transl('_hkHelp_esc'),
    ])
    return parts.length > 0
      ? lang.transl('_help_hotkey_2', list)
      : lang.transl('_help_hotkey_2NoHotkey', list)
  },
}

/** The text for `key` with the current hotkeys, or undefined when `key` does
 * not name a hotkey */
export function hotkeyText(key: LangTextKey): string | undefined {
  return texts[key]?.()
}
