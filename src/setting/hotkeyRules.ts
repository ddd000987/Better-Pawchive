/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 *
 * Single source of truth for which hotkey combos may be bound. Used by the
 * interactive recorder (HotkeyEditor) and by the settings sanitizer, so a
 * hotkey that arrives from storage or an imported file is held to exactly the
 * same rules as one recorded in the panel.
 *
 * Pure module: type-only import from Settings (no runtime cycle).
 */

import type { HotkeyCombo } from './Settings'

/** Ctrl 下瀏覽器不允許頁面攔截的按鍵（Ctrl+T/W/N/Q/Tab；其餘頁面可攔截） */
const RESERVED_CTRL_KEYS = new Set(['KeyT', 'KeyW', 'KeyN', 'KeyQ', 'Tab'])
/** Ctrl+Shift 下瀏覽器不允許頁面攔截的按鍵（重開／新視窗／關閉視窗） */
const RESERVED_CTRL_SHIFT_KEYS = new Set(['KeyT', 'KeyN', 'KeyW'])

/** The main key must be a letter or a digit (KeyboardEvent.code). */
const MAIN_KEY_PATTERN = /^(Key[A-Z]|Digit[0-9])$/

/** Whether a KeyboardEvent.code is an acceptable main key (letter or digit). */
export function isHotkeyMainKey(code: string): boolean {
  return MAIN_KEY_PATTERN.test(code)
}

/** 是否為瀏覽器／系統保留組合（設了也不會到達頁面 keydown） */
export function isReservedHotkey(combo: HotkeyCombo): boolean {
  // Ctrl（Mac 為 Cmd）的保留鍵；Shift 要納入判斷，否則 Ctrl+Shift+X 會被誤擋
  const primary = combo.ctrl || combo.meta
  if (primary && !(combo.ctrl && combo.meta) && !combo.alt) {
    const keys = combo.shift ? RESERVED_CTRL_SHIFT_KEYS : RESERVED_CTRL_KEYS
    if (keys.has(combo.key)) {
      return true
    }
    // Ctrl+數字切換標籤頁（Ctrl+Shift+數字多數瀏覽器沒有預設行為）
    if (combo.ctrl && !combo.shift && combo.key.startsWith('Digit')) {
      return true
    }
  }
  // Meta 單修飾鍵（macOS Cmd／Windows Win）多為系統或瀏覽器保留
  if (combo.meta && !combo.ctrl && !combo.alt) {
    return true
  }
  return false
}

/** Whether a combo may be bound: letter/digit main key and not reserved. */
export function isAllowedHotkeyCombo(combo: HotkeyCombo): boolean {
  return isHotkeyMainKey(combo.key) && !isReservedHotkey(combo)
}

/** Whether two combos are the same key with the same modifiers. */
export function sameHotkeyCombo(a: HotkeyCombo, b: HotkeyCombo): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  )
}

/** Whether a keydown is exactly this combo (key by KeyboardEvent.code). */
export function matchesHotkey(
  ev: Pick<
    KeyboardEvent,
    'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
  >,
  combo: HotkeyCombo | undefined
): boolean {
  return (
    !!combo &&
    sameHotkeyCombo(combo, {
      key: ev.code,
      ctrl: ev.ctrlKey,
      alt: ev.altKey,
      shift: ev.shiftKey,
      meta: ev.metaKey,
    })
  )
}

/** Platform for key names: macOS uses symbols, Windows calls Meta ⊞ */
export type HotkeyPlatform = 'mac' | 'win' | 'other'

/** Readable combo text, e.g. "Alt+P", "⌥P", "D" */
export function formatHotkeyCombo(
  combo: HotkeyCombo,
  platform: HotkeyPlatform
): string {
  const mac = platform === 'mac'
  const parts: string[] = []
  if (combo.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
  if (combo.alt) parts.push(mac ? '⌥' : 'Alt')
  if (combo.shift) parts.push(mac ? '⇧' : 'Shift')
  if (combo.meta) parts.push(mac ? '⌘' : platform === 'win' ? '⊞' : 'Meta')
  parts.push(hotkeyCodeName(combo.key))
  return parts.join(mac ? '' : '+')
}

/** KeyboardEvent.code → key name ("KeyD" → "D", "Digit1" → "1") */
function hotkeyCodeName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}
