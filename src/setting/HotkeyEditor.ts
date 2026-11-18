/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/setting/HotkeyEditor.ts
 *          (xuejianxianzun): record/conflict/reserved-combo validation,
 *          formatCombo/codeToName, reset-to-default flows.
 * changes: no useSlot/theme/msgBox/svg-icon dependencies —
 *          renders into a container given by SettingsCenter; feedback via
 *          toast (errors) + window.confirm (reset). Command list reduced
 *          to our 3 HotkeyCommands. settingChange payload is {key, value}.
 *          One editor class serves two tables: the global hotkeys and the
 *          keys used inside the hover preview; conflicts are checked across
 *          both, since a global hotkey always wins over a preview key.
 */

import { Config } from '../Config'
import { EVT } from '../EVT'
import { lang } from '../Language'
import { LangTextKey } from '../langText'
import { toast } from '../Toast'
import { setHotkeyRecording } from '../HotkeyListener'
import {
  settings,
  setSetting,
  defaultHotkeys,
  defaultPreviewHotkeys,
  HotkeyCombo,
} from './Settings'
import {
  formatHotkeyCombo,
  isHotkeyMainKey,
  isReservedHotkey,
  sameHotkeyCombo,
} from './hotkeyRules'

export { isReservedHotkey }

/** Which key table an editor shows */
type HotkeyTableName = 'global' | 'preview'

/** Setting key holding a table */
type TableSettingKey = 'hotkeys' | 'previewHotkeys'

/** A combo map read loosely: command name → combo */
type ComboMap = Partial<Record<string, HotkeyCombo>>

interface HotkeyTable {
  settingKey: TableSettingKey
  defaults: ComboMap
  /** 命令與顯示說明的對應（順序即列表順序） */
  rows: { command: string; nameKey: LangTextKey }[]
}

const TABLES: Record<HotkeyTableName, HotkeyTable> = {
  global: {
    settingKey: 'hotkeys',
    defaults: defaultHotkeys,
    rows: [
      { command: 'commandToggleCrawlPanel', nameKey: '_hk_togglePanel' },
      { command: 'commandStartDefaultCrawl', nameKey: '_hk_startCrawl' },
      { command: 'commandTogglePreviewWork', nameKey: '_hk_togglePreview' },
    ],
  },
  preview: {
    settingKey: 'previewHotkeys',
    defaults: defaultPreviewHotkeys,
    rows: [
      { command: 'previewDownloadPost', nameKey: '_hk_previewDownloadPost' },
      { command: 'previewDownloadImage', nameKey: '_hk_previewDownloadImage' },
      { command: 'previewOpenOriginal', nameKey: '_hk_previewOpenOriginal' },
      { command: 'previewOpenWindow', nameKey: '_hk_previewOpenWindow' },
    ],
  },
}

/** Combo text for this browser's platform */
function formatCombo(combo: HotkeyCombo): string {
  return formatHotkeyCombo(
    combo,
    Config.isMac ? 'mac' : Config.isWin ? 'win' : 'other'
  )
}

/** 在設定面板裡查看和修改一組快捷鍵（一級快捷鍵或預覽快捷鍵） */
class HotkeyEditor {
  constructor(mount: HTMLDivElement, tableName: HotkeyTableName = 'global') {
    this.table = TABLES[tableName]
    this.wrap = document.createElement('div')
    this.wrap.className = 'pwp-hotkeys-table'
    this.wrap.innerHTML = `
      <div class="pwp-hotkeys-head">
        <div class="cell" data-xztext="_hk_command"></div>
        <div class="cell" data-xztext="_hk_hotkey"></div>
        <div class="cell" data-xztext="_hk_action"></div>
      </div>
      <div class="listWrap"></div>
      <div class="pwp-hotkeys-btns">
        <button type="button" class="reset" data-xztext="_hk_reset"></button>
      </div>`
    mount.appendChild(this.wrap)
    lang.register(this.wrap)
    this.createAllList()
    this.bindEvents()
  }

  private table: HotkeyTable
  private wrap: HTMLDivElement
  private listWrap!: HTMLDivElement

  /** 是否正在錄製某個快捷鍵，避免同時錄製多個導致錯行 */
  private recording = false

  /** This table's current combos */
  private map(): ComboMap {
    return settings.get(this.table.settingKey) as ComboMap
  }

  /** Save this table's combos */
  private save(map: ComboMap): void {
    // Each table's setting holds a combo map of its own commands
    setSetting(this.table.settingKey, map as never)
  }

  /** 依設定裡的快捷鍵，重建整個列表 */
  private createAllList(): void {
    this.listWrap = this.wrap.querySelector('.listWrap') as HTMLDivElement
    this.listWrap.innerHTML = ''
    for (const info of this.table.rows) {
      this.createList(info.command, info.nameKey)
    }
    lang.register(this.listWrap)
  }

  /** 為某個命令建一行 */
  private createList(command: string, nameKey: LangTextKey): void {
    const combo = this.map()[command]
    const valueText =
      combo && combo.key ? formatCombo(combo) : lang.transl('_hk_unset')

    const item = document.createElement('div')
    item.className = 'pwp-hotkeys-row'
    item.dataset.command = command
    item.innerHTML = `
      <div class="cell cellCommand">
        <span data-xztext="${nameKey}">${lang.transl(nameKey)}</span>
      </div>
      <div class="cell cellHotkey">
        <span class="value"></span>
        <button type="button" class="escCancel" data-xztext="_hk_escCancel">${lang.transl('_hk_escCancel')}</button>
      </div>
      <div class="cell cellAction">
        <button type="button" class="edit" data-xztitle="_hk_edit">✎ <span data-xztext="_hk_edit">${lang.transl('_hk_edit')}</span></button>
        <button type="button" class="delete" data-xztitle="_hk_clear">× <span data-xztext="_hk_clear">${lang.transl('_hk_clear')}</span></button>
      </div>`
    // Combo text can derive from stored/imported data: never put it in HTML
    ;(item.querySelector('.value') as HTMLElement).textContent = valueText
    this.listWrap.appendChild(item)
    lang.register(item)

    const editBtn = item.querySelector('.edit') as HTMLButtonElement
    const deleteBtn = item.querySelector('.delete') as HTMLButtonElement
    editBtn.addEventListener('click', () => {
      this.startRecord(item, command)
    })
    deleteBtn.addEventListener('click', () => {
      this.deleteHotkey(command)
    })
  }

  /** 進入錄製態：監聽使用者按鍵，只在按下「主鍵」時結束錄製 */
  private startRecord(item: HTMLDivElement, command: string): void {
    // 已經在錄製其他快捷鍵時，忽略本次點擊
    if (this.recording) {
      return
    }
    this.recording = true
    // 通知派發端暫停派發已有快捷鍵，避免錄入按鍵誤觸發既有動作
    setHotkeyRecording(true)

    const valueEl = item.querySelector('.value') as HTMLElement
    valueEl.textContent = lang.transl('_hk_pressKey')
    valueEl.classList.add('recording')
    item.classList.add('recording')

    // 錄製期間累計的修飾鍵狀態（解決「先按修飾鍵、後按主鍵」時，
    // 按下修飾鍵就直接結束錄製的問題）
    const collected = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    }

    const finish = () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointerdown', cancel)
      valueEl.classList.remove('recording')
      item.classList.remove('recording')
      this.recording = false
      // 恢復派發已有快捷鍵
      setHotkeyRecording(false)
    }

    // 取消錄製：還原顯示，不保存（Esc、視窗失焦、點擊任意區域均可觸發）
    const cancel = () => {
      finish()
      this.refreshItem(command)
    }

    const handler = (ev: KeyboardEvent) => {
      // 阻止瀏覽器／系統對保留組合的預設行為，避免錄製時頁面被帶走
      ev.preventDefault()
      ev.stopPropagation()

      // 按下 Esc 取消錄製
      if (ev.code === 'Escape') {
        cancel()
        return
      }

      // 只按下修飾鍵時：記錄修飾鍵狀態，繼續等待主鍵（不結束錄製）
      const modifierCodes = [
        'ShiftLeft',
        'ShiftRight',
        'ControlLeft',
        'ControlRight',
        'AltLeft',
        'AltRight',
        'MetaLeft',
        'MetaRight',
      ]
      if (modifierCodes.includes(ev.code) || ev.code.startsWith('OS')) {
        collected.ctrl = ev.ctrlKey
        collected.alt = ev.altKey
        collected.shift = ev.shiftKey
        collected.meta = ev.metaKey
        return
      }

      // 主鍵必須是數字或字母，其餘按鍵（如 Tab、CapsLock、功能鍵）不接受
      if (!isHotkeyMainKey(ev.code)) {
        finish()
        toast.error(lang.transl('_hk_needMainKey'))
        this.refreshItem(command)
        return
      }

      // 主鍵：組裝組合並結束錄製
      const combo: HotkeyCombo = {
        key: ev.code,
        ctrl: ev.ctrlKey || collected.ctrl,
        alt: ev.altKey || collected.alt,
        shift: ev.shiftKey || collected.shift,
        meta: ev.metaKey || collected.meta,
      }

      // 校验：與另一個一級快捷鍵重複
      const conflict = this.findConflict(command, combo)
      if (conflict) {
        finish()
        toast.error(lang.transl('_hk_conflict', conflict))
        this.refreshItem(command)
        return
      }

      // 校验：瀏覽器／系統保留組合
      if (this.isReserved(combo)) {
        finish()
        toast.error(lang.transl('_hk_reserved'))
        this.refreshItem(command)
        return
      }

      // 通過校驗，保存
      const map = { ...this.map() }
      map[command] = combo
      finish()
      toast.success(lang.transl('_hk_changed'))
      this.save(map)
      this.refreshItem(command)
    }

    // 視窗失焦、或點擊任意區域都取消錄製，避免錄製態卡死
    window.addEventListener('keydown', handler, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('pointerdown', cancel)
  }

  /** 找出與 combo 衝突的其他命令（回傳其顯示名，無衝突回 null）。
   * Both tables are checked: a global hotkey swallows the key before the
   * preview sees it, so the two may not share a combo either. */
  private findConflict(self: string, combo: HotkeyCombo): string | null {
    for (const table of Object.values(TABLES)) {
      const map = settings.get(table.settingKey) as ComboMap
      for (const info of table.rows) {
        if (table === this.table && info.command === self) {
          continue
        }
        const other = map[info.command]
        if (other && other.key && sameHotkeyCombo(other, combo)) {
          return lang.transl(info.nameKey)
        }
      }
    }
    return null
  }

  /** 是否為瀏覽器／系統保留組合（設了也不會到達頁面 keydown） */
  private isReserved(combo: HotkeyCombo): boolean {
    return isReservedHotkey(combo)
  }

  /** 清除某個命令的快捷鍵 */
  private deleteHotkey(command: string): void {
    const map = { ...this.map() }
    delete map[command]
    this.save(map)
    this.refreshItem(command)
    toast.success(lang.transl('_hk_cleared'))
  }

  /** 依目前設定，刷新某一行的顯示 */
  private refreshItem(command: string): void {
    const item = this.listWrap.querySelector(
      `.pwp-hotkeys-row[data-command='${command}']`
    )
    if (!item) {
      return
    }
    const combo = this.map()[command]
    const valueEl = item.querySelector('.value') as HTMLElement
    valueEl.textContent =
      combo && combo.key ? formatCombo(combo) : lang.transl('_hk_unset')
  }

  private bindEvents(): void {
    // 快捷鍵設定被外部修改（例如重置）時，重建整個列表
    EVT.on(EVT.list.settingChange, (ev: CustomEventInit) => {
      const data = ev.detail.data as { key?: string }
      if (data.key === this.table.settingKey) {
        this.createAllList()
      }
    })
    // restore() 直接寫 store：面板建得早，這裡補一次重建
    EVT.on(
      EVT.list.settingInitialized,
      () => {
        this.createAllList()
      },
      { once: true }
    )

    // 重置為預設
    const resetBtn = this.wrap.querySelector('.reset') as HTMLButtonElement
    resetBtn.addEventListener('click', () => {
      if (window.confirm(lang.transl('_hk_resetConfirm'))) {
        this.save({ ...this.table.defaults })
        toast.success(lang.transl('_hk_resetDone'))
      }
    })
  }
}

export { HotkeyEditor }
