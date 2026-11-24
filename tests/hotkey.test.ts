import { afterEach, describe, expect, it } from 'vitest'
import { EVT, type eventNames } from '../src/EVT'
import { HotkeyListener } from '../src/HotkeyListener'
import { isReservedHotkey } from '../src/setting/HotkeyEditor'
import {
  formatHotkeyCombo,
  isAllowedHotkeyCombo,
  matchesHotkey,
} from '../src/setting/hotkeyRules'
import {
  sanitizeHotkeys,
  sanitizePreviewHotkeys,
  settings,
  defaultHotkeys,
  defaultPreviewHotkeys,
} from '../src/setting/Settings'

/** 在 stub window 上派發假 keydown（需自帶 preventDefault）。
 * Returns how many times preventDefault was called. */
function keydown(
  code: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
  target?: unknown,
  repeat = false
): number {
  let prevented = 0
  ;(window.dispatchEvent as (ev: unknown) => void)({
    type: 'keydown',
    code,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
    target,
    repeat,
    preventDefault: () => {
      prevented++
    },
  })
  return prevented
}

// EVT 的私有匯流排不會被 setup.ts 清空，用完要自己解除監聽
const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((fn) => fn())
})

function listenOnce(type: eventNames): { count: () => number } {
  let n = 0
  const listener = () => {
    n++
  }
  EVT.on(type, listener)
  disposers.push(() => EVT.off(type, listener))
  return { count: () => n }
}

describe('sanitizeHotkeys', () => {
  it('非法輸入回空表（派發端跳過無鍵命令）', () => {
    expect(sanitizeHotkeys(undefined)).toEqual({})
    expect(sanitizeHotkeys('alt+x')).toEqual({})
    expect(sanitizeHotkeys({})).toEqual({})
  })

  it('只收已知命令的有效組合：未知丟棄、非法丟棄、缺鍵保持缺', () => {
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: {
        key: 'KeyY',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
      },
      commandBogus: {
        key: 'KeyB',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
      },
      commandStartDefaultCrawl: {
        key: '',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
      },
    })
    expect(out.commandToggleCrawlPanel).toEqual({
      key: 'KeyY',
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
    })
    expect(out).not.toHaveProperty('commandBogus')
    // 非法組合被丟棄（不是回退預設——「清除」後重載不復活）
    expect(out).not.toHaveProperty('commandStartDefaultCrawl')
    expect(out).not.toHaveProperty('commandTogglePreviewWork')
  })
})

describe('isReservedHotkey', () => {
  const combo = (
    key: string,
    mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>>
  ) => ({
    key,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    ...mods,
  })

  it('Ctrl 與 Ctrl+Shift 的瀏覽器保留鍵都擋下', () => {
    expect(isReservedHotkey(combo('KeyT', { ctrl: true }))).toBe(true)
    expect(isReservedHotkey(combo('KeyT', { ctrl: true, shift: true }))).toBe(
      true
    )
    expect(isReservedHotkey(combo('Digit1', { ctrl: true }))).toBe(true)
    expect(isReservedHotkey(combo('Digit1', { ctrl: true, shift: true }))).toBe(
      false
    )
  })

  it('頁面可攔截的組合不擋（Ctrl+C／Ctrl+Shift+X 等）', () => {
    expect(isReservedHotkey(combo('KeyC', { ctrl: true }))).toBe(false)
    expect(isReservedHotkey(combo('KeyF', { ctrl: true }))).toBe(false)
    expect(isReservedHotkey(combo('KeyX', { ctrl: true, shift: true }))).toBe(
      false
    )
    expect(isReservedHotkey(combo('KeyQ', { ctrl: true, shift: true }))).toBe(
      false
    )
    expect(isReservedHotkey(combo('KeyW', { ctrl: true, shift: true }))).toBe(
      true
    )
    expect(isReservedHotkey(combo('KeyN', { ctrl: true, shift: true }))).toBe(
      true
    )
    expect(isReservedHotkey(combo('Tab', { ctrl: true }))).toBe(true)
    expect(isReservedHotkey(combo('KeyQ', { ctrl: true }))).toBe(true)
  })

  it('一般 Alt 組合仍可錄製', () => {
    expect(isReservedHotkey(combo('KeyX', { alt: true }))).toBe(false)
    expect(isReservedHotkey(combo('KeyX', { ctrl: true, alt: true }))).toBe(
      false
    )
  })
})

describe('HotkeyListener', () => {
  it('預設 Alt+X/Z/P 派發三個命令', () => {
    new HotkeyListener()
    const panel = listenOnce(EVT.list.commandToggleCrawlPanel)
    const crawl = listenOnce(EVT.list.commandStartDefaultCrawl)
    const preview = listenOnce(EVT.list.commandTogglePreviewWork)

    keydown('KeyX', { alt: true })
    keydown('KeyZ', { alt: true })
    keydown('KeyP', { alt: true })
    // 修飾鍵不對的不觸發
    keydown('KeyX', {})
    keydown('KeyX', { ctrl: true })

    expect(panel.count()).toBe(1)
    expect(crawl.count()).toBe(1)
    expect(preview.count()).toBe(1)
  })

  it('輸入框內的按鍵不派發', () => {
    new HotkeyListener()
    const panel = listenOnce(EVT.list.commandToggleCrawlPanel)
    keydown('KeyX', { alt: true }, { tagName: 'INPUT' })
    keydown('KeyX', { alt: true }, { tagName: 'TEXTAREA' })
    expect(panel.count()).toBe(0)
  })

  it('shortcuts still work with a checkbox focused, but not in a text field', () => {
    new HotkeyListener()
    const panel = listenOnce(EVT.list.commandToggleCrawlPanel)
    keydown('KeyX', { alt: true }, { tagName: 'INPUT', type: 'checkbox' })
    expect(panel.count()).toBe(1)
    keydown('KeyX', { alt: true }, { tagName: 'INPUT', type: 'text' })
    expect(panel.count()).toBe(1)
  })

  it('a repeated keydown does not fire the command but still prevents the default', () => {
    new HotkeyListener()
    const panel = listenOnce(EVT.list.commandToggleCrawlPanel)
    expect(keydown('KeyX', { alt: true }, undefined, false)).toBe(1)
    expect(panel.count()).toBe(1)
    expect(keydown('KeyX', { alt: true }, undefined, true)).toBe(1)
    expect(panel.count()).toBe(1)
  })

  it('set hotkeys 後熱更新映射（舊組合失效、新組合生效）', () => {
    new HotkeyListener()
    const panel = listenOnce(EVT.list.commandToggleCrawlPanel)
    settings.set('hotkeys', {
      ...defaultHotkeys,
      commandToggleCrawlPanel: {
        key: 'KeyY',
        ctrl: false,
        alt: true,
        shift: false,
        meta: false,
      },
    })
    keydown('KeyX', { alt: true })
    expect(panel.count()).toBe(0)
    keydown('KeyY', { alt: true })
    expect(panel.count()).toBe(1)
    // 還原預設，避免污染其他測試（同檔共用 settings 單例）
    settings.set('hotkeys', { ...defaultHotkeys })
  })
})

describe('hotkeys 事件位', () => {
  it('三個命令都在 EVT.list（fire 型別安全）', () => {
    expect(EVT.list.commandToggleCrawlPanel).toBe('commandToggleCrawlPanel')
    expect(EVT.list.commandStartDefaultCrawl).toBe('commandStartDefaultCrawl')
    expect(EVT.list.commandTogglePreviewWork).toBe('commandTogglePreviewWork')
  })
})

describe('stored and imported hotkeys are validated', () => {
  const alt = (key: string, extra: Record<string, boolean> = {}) => ({
    key,
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
    ...extra,
  })

  it('drops an HTML payload used as the key', () => {
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('<img src=x onerror=alert(1)>'),
      commandStartDefaultCrawl: alt('KeyZ'),
    })
    expect(out).not.toHaveProperty('commandToggleCrawlPanel')
    expect(out.commandStartDefaultCrawl?.key).toBe('KeyZ')
  })

  it('drops keys that are not a letter or digit (Tab, Space, F-keys)', () => {
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('Tab'),
      commandStartDefaultCrawl: alt('Space'),
      commandTogglePreviewWork: alt('F5'),
    })
    expect(out).toEqual({})
    // lower-case or longer look-alikes are not main keys either
    expect(isAllowedHotkeyCombo(alt('Keya'))).toBe(false)
    expect(isAllowedHotkeyCombo(alt('KeyAB'))).toBe(false)
    expect(isAllowedHotkeyCombo(alt('Digit10'))).toBe(false)
  })

  it('drops reserved combos and keeps valid ones', () => {
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('KeyT', { alt: false, ctrl: true }),
      commandStartDefaultCrawl: alt('KeyK', { alt: false, meta: true }),
      commandTogglePreviewWork: alt('Digit5', { shift: true }),
    })
    expect(out).not.toHaveProperty('commandToggleCrawlPanel')
    expect(out).not.toHaveProperty('commandStartDefaultCrawl')
    expect(out.commandTogglePreviewWork?.key).toBe('Digit5')
  })

  it('every default hotkey passes the validator', () => {
    for (const combo of Object.values(defaultHotkeys)) {
      expect(isAllowedHotkeyCombo(combo!)).toBe(true)
    }
    expect(sanitizeHotkeys(defaultHotkeys)).toEqual(defaultHotkeys)
  })

  it('settings.set sanitizes hotkeys through the same validator', () => {
    settings.set('hotkeys', { commandToggleCrawlPanel: alt('Tab') })
    expect(settings.get('hotkeys')).toEqual({})
    settings.set('hotkeys', { ...defaultHotkeys })
  })
})

// The test environment has no DOM (document.createElement is stubbed to
// throw), so the row-rendering fix in HotkeyEditor.createList (combo text set
// via textContent, never interpolated into innerHTML) is not covered here.

describe('preview keys', () => {
  const plain = (key: string) => ({
    key,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  })
  const ev = (code: string, mods: { shift?: boolean; alt?: boolean } = {}) => ({
    code,
    ctrlKey: false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: false,
  })

  it('defaults are plain D / C / S / V / F and pass the validator', () => {
    expect(defaultPreviewHotkeys).toEqual({
      previewDownloadPost: plain('KeyD'),
      previewDownloadImage: plain('KeyC'),
      previewFavoriteImage: plain('KeyS'),
      previewOpenOriginal: plain('KeyV'),
      previewOpenWindow: plain('KeyF'),
    })
    expect(sanitizePreviewHotkeys(defaultPreviewHotkeys)).toEqual(
      defaultPreviewHotkeys
    )
  })

  it('a cleared key stays cleared; unknown and bad entries are dropped', () => {
    expect(
      sanitizePreviewHotkeys({
        previewDownloadImage: plain('KeyS'),
        previewOpenOriginal: plain('Space'),
        commandToggleCrawlPanel: plain('KeyX'),
      })
    ).toEqual({ previewDownloadImage: plain('KeyS') })
    expect(sanitizePreviewHotkeys(null)).toEqual({})
  })

  it('settings.set sanitizes preview keys too', () => {
    settings.set('previewHotkeys', { previewDownloadPost: plain('Tab') })
    expect(settings.get('previewHotkeys')).toEqual({})
    settings.set('previewHotkeys', { ...defaultPreviewHotkeys })
  })

  it('a key matches only with exactly its modifiers', () => {
    const d = plain('KeyD')
    expect(matchesHotkey(ev('KeyD'), d)).toBe(true)
    expect(matchesHotkey(ev('KeyD', { shift: true }), d)).toBe(false)
    expect(matchesHotkey(ev('KeyD', { alt: true }), d)).toBe(false)
    expect(matchesHotkey(ev('KeyD'), undefined)).toBe(false)
  })

  it('formats combos per platform', () => {
    const combo = { ...plain('Digit1'), ctrl: true, shift: true }
    expect(formatHotkeyCombo(combo, 'win')).toBe('Ctrl+Shift+1')
    expect(formatHotkeyCombo(combo, 'mac')).toBe('⌃⇧1')
    expect(formatHotkeyCombo({ ...plain('KeyA'), meta: true }, 'win')).toBe(
      '⊞+A'
    )
    expect(formatHotkeyCombo({ ...plain('KeyA'), meta: true }, 'other')).toBe(
      'Meta+A'
    )
  })
})
