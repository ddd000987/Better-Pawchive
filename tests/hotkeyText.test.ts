import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/Config'
import { lang } from '../src/Language'
import { hotkeyText } from '../src/setting/hotkeyText'
import { formatHotkeyCombo } from '../src/setting/hotkeyRules'
import {
  defaultHotkeys,
  defaultPreviewHotkeys,
  settings,
  type HotkeyCombo,
} from '../src/setting/Settings'

const platform = Config.isMac ? 'mac' : Config.isWin ? 'win' : 'other'
const label = (c: HotkeyCombo | undefined) => formatHotkeyCombo(c!, platform)

afterEach(() => {
  settings.set('hotkeys', { ...defaultHotkeys })
  settings.set('previewHotkeys', { ...defaultPreviewHotkeys })
  lang.applyUserLang('en')
})

describe('hotkeyText', () => {
  it('is undefined for texts that name no hotkey', () => {
    expect(hotkeyText('_startCrawl')).toBeUndefined()
  })

  it('names the bound combo, and drops it when unbound', () => {
    const crawl = label(defaultHotkeys.commandStartDefaultCrawl)
    expect(hotkeyText('_help_quick_2')).toBe(
      lang.transl('_help_quick_2', crawl)
    )
    expect(hotkeyText('_help_quick_2')).toContain(crawl)
    settings.set('hotkeys', {
      ...defaultHotkeys,
      commandStartDefaultCrawl: undefined,
    })
    expect(hotkeyText('_help_quick_2')).toBe(
      lang.transl('_help_quick_2NoHotkey')
    )
    expect(hotkeyText('_d_showFloatingButton')).toContain(
      label(defaultHotkeys.commandToggleCrawlPanel)
    )
  })

  it('follows a rebound combo', () => {
    const combo = {
      key: 'KeyQ',
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
    }
    settings.set('hotkeys', {
      ...defaultHotkeys,
      commandTogglePreviewWork: combo,
    })
    expect(hotkeyText('_help_preview_1')).toContain(label(combo))
  })

  it('lists only the bound panel hotkeys', () => {
    const all = hotkeyText('_help_hotkey_1')!
    for (const c of Object.values(defaultHotkeys)) {
      expect(all).toContain(label(c))
    }
    settings.set('hotkeys', {
      commandToggleCrawlPanel: defaultHotkeys.commandToggleCrawlPanel,
    })
    expect(hotkeyText('_help_hotkey_1')).toBe(
      lang.transl(
        '_help_hotkey_1',
        lang.transl(
          '_hkHelp_togglePanel',
          label(defaultHotkeys.commandToggleCrawlPanel)
        )
      )
    )
    settings.set('hotkeys', {})
    expect(hotkeyText('_help_hotkey_1')).toBe(
      lang.transl('_help_hotkey_1NoHotkey')
    )
  })

  it('keeps the wheel and Esc when no preview key is bound', () => {
    settings.set('previewHotkeys', {
      previewOpenWindow: defaultPreviewHotkeys.previewOpenWindow,
    })
    const one = hotkeyText('_help_hotkey_2')!
    expect(one).toContain(label(defaultPreviewHotkeys.previewOpenWindow))
    expect(one).not.toContain(label(defaultPreviewHotkeys.previewDownloadPost))
    settings.set('previewHotkeys', {})
    expect(hotkeyText('_help_hotkey_2')).toBe(
      lang.transl(
        '_help_hotkey_2NoHotkey',
        [lang.transl('_hkHelp_wheel'), lang.transl('_hkHelp_esc')].join(
          lang.transl('_listSep')
        )
      )
    )
  })

  it('uses the current UI language', () => {
    lang.applyUserLang('zh-tw')
    settings.set('hotkeys', {})
    expect(hotkeyText('_help_hotkey_1')).toBe(
      '目前沒有設定快捷鍵，可以在「通用」頁設定。'
    )
  })
})
