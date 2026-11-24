/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/setting/Settings.ts (xuejianxianzun)
 * changes: preview, download, filter and meta
 *          settings in one store. No Language dependency — option labels
 *          are resolved by the UI layer (SettingsCenter).
 *          本輪：＋previewInfoPlacement（預覽資訊列每欄位的位置表，見
 *          preview/previewInfo.ts；物件型鍵比照 hotkeys 走 set/restore 清洗）。
 */

import { Config } from '../Config'
import { EVT } from '../EVT'
import { langCodes, LangCode } from '../locales'
import {
  defaultPreviewInfoPlacement,
  sanitizePreviewInfoPlacement,
} from '../preview/previewInfo'
import type { PreviewInfoPlacement } from '../preview/previewInfo'
import { isAllowedHotkeyCombo, sameHotkeyCombo } from './hotkeyRules'

/** 預覽設定（注意拼字已修正，非 PBD 的 swicthImageByKeyboard） */
interface PreviewSettings {
  /** 啟用懸停預覽 */
  PreviewWork: boolean
  /** hover 延遲（ms） */
  previewWorkWait: number
  /** 預覽走原圖（false = 縮圖，省流量；下載另由 downloadOriginalImage 決定） */
  previewOriginalImage: boolean
  /** 顯示預覽摘要條 */
  showPreviewWorkTip: boolean
  /** 滑鼠離開卡片後、停在預覽浮層上是否保持顯示（false = 離開卡片即關） */
  keepPreviewOnFloatHover: boolean
  /** 預覽資訊列：每個欄位顯示在圖片上方／下方／不顯示 */
  previewInfoPlacement: PreviewInfoPlacement
  /** hover 封面縮圖也觸發預覽 */
  allowPreviewCoverThumbnail: boolean
  /** 預覽中滾輪切圖 */
  wheelScrollSwitchImageOnPreviewWork: boolean
  /** 預覽中滑鼠移動超過這麼多像素時，滾輪改為捲動網頁 */
  wheelScrollPageMoveDistance: number
  /** How many images after the current one the preview loads ahead of time */
  previewPreloadNext: number
  /** How many images before the current one the preview loads ahead of time */
  previewPreloadPrev: number
  /** 在帖子縮圖上顯示下載按鈕*/
  showDownloadBtnOnThumb: boolean
  /** Hovering a creator avatar previews the covers of their latest posts */
  PreviewCreator: boolean
  /** How many covers the creator preview shows (it does not scroll) */
  previewCreatorCount: number
  /** Keep the creator preview open while the cursor is on it (false = close
   * as soon as the cursor leaves the avatar) */
  keepCreatorPreviewOnFloatHover: boolean
}

/** 下載設定 */
interface DownloadSettings {
  /** 同時下載的檔案數（1–6，非法值回退預設） */
  downloadThread: number
  /** 檔案間下載間隔（秒，0 = 不啟用） */
  downloadInterval: number
  /** 抓取 API 請求間隔（秒，0 = 不等待；寫入時夾取 0–10） */
  crawlInterval: number
  /** 抓取完成並存入快取後自動掛載 */
  autoMountCache: boolean
  /** 抓取完成後自動開始下載 */
  autoStartDownload: boolean
  /** 嚴格按抓取順序下載（等上一個存檔完成才下一個） */
  setFileDownloadOrder: boolean
  /** 帖子文字內容保存方式：none 不保存 / txt / html */
  textContent: 'none' | 'txt' | 'html'
  /** 不下載封面圖 */
  noCoverFile: boolean
  /** 下載圖片走原圖（false = 縮圖；與預覽的 previewOriginalImage 各自獨立，預設原圖） */
  downloadOriginalImage: boolean
}

/** 過濾設定 */
interface FilterSettings {
  /** 標題關鍵字（包含才保留，空 = 不限） */
  filterTitle: string
  /** 發布日期下限 YYYY-MM-DD（空 = 不限） */
  filterDateFrom: string
  /** 發布日期上限 YYYY-MM-DD（空 = 不限） */
  filterDateTo: string
  /** 附件數下限（0 = 不限） */
  filterMinFiles: number
  /** 附件數上限（0 = 不限） */
  filterMaxFiles: number
  /** 下載圖片附件 */
  downImageFiles: boolean
  /** 下載影片附件 */
  downVideoFiles: boolean
  /** 下載其他附件（壓縮包/音訊等） */
  downOtherFiles: boolean
  /** 下載封面圖 */
  downloadCover: boolean
  /** 跳過未完整匯入的帖子（has_full=false） */
  skipPendingPosts: boolean
  /** 限定服務（逗號分隔，空 = 全部） */
  filterServices: string
  /** 帖子 ID 下限（空 = 不限，字串比較） */
  filterPostIdFrom: string
  /** 帖子 ID 上限（空 = 不限） */
  filterPostIdTo: string
  /** 單檔體積上限 MiB（0 = 不限，下載時檢查） */
  filterMaxSizeMiB: number
}

/** 通用設定：語言＋去重＋命名規則 */
interface MetaSettings {
  /** UI language (auto follows the browser language, then the page html lang) */
  userSetLang: 'auto' | LangCode
  /** 跳過已下載的檔案：none 不跳過 / record 按下載記錄 / folder 按已授權資料夾
   * 中同路徑已有的檔案 / both 兩者都用 */
  skipDownloaded: 'none' | 'record' | 'folder' | 'both'
  /** 是否在頁面右下角顯示浮動的設定按鈕（關閉後仍可用快捷鍵或工具列圖示開啟） */
  showFloatingButton: boolean
  /** 全域命名規則（含 {token} 與 [...] 可選片段） */
  namingRule: string
  /** Pawchive 站專用規則（空 = 跟全域） */
  namingRulePawchive: string
  /** 使用者自訂的一級快捷鍵。鍵為命令名，未設定的命令不出現 */
  hotkeys: HotkeyMap
  /** Keys used inside the hover preview; a cleared command is absent */
  previewHotkeys: PreviewHotkeyMap
}

/** 快捷鍵組合（key 為 KeyboardEvent.code） */
interface HotkeyCombo {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** 一級快捷鍵命令（只留 3 個） */
type HotkeyCommand =
  | 'commandToggleCrawlPanel'
  | 'commandStartDefaultCrawl'
  | 'commandTogglePreviewWork'

/** 命令名到快捷鍵組合的映射，使用者未設定的命令不會出現在物件裡 */
type HotkeyMap = Partial<Record<HotkeyCommand, HotkeyCombo>>

/** 一級快捷鍵的預設鍵位（供初始值與「重置為預設」使用） */
const defaultHotkeys: HotkeyMap = {
  commandToggleCrawlPanel: {
    key: 'KeyX',
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
  },
  commandStartDefaultCrawl: {
    key: 'KeyZ',
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
  },
  commandTogglePreviewWork: {
    key: 'KeyP',
    ctrl: false,
    alt: true,
    shift: false,
    meta: false,
  },
}

/** 校驗單個快捷鍵組合的形狀（擋掉損壞／跨版本存檔） */
function isHotkeyCombo(v: unknown): v is HotkeyCombo {
  if (!v || typeof v !== 'object') {
    return false
  }
  const c = v as Record<string, unknown>
  return (
    typeof c.key === 'string' &&
    c.key.length > 0 &&
    typeof c.ctrl === 'boolean' &&
    typeof c.alt === 'boolean' &&
    typeof c.shift === 'boolean' &&
    typeof c.meta === 'boolean'
  )
}

/** Keys that act only while the hover preview is open */
type PreviewHotkeyCommand =
  | 'previewDownloadPost'
  | 'previewDownloadImage'
  | 'previewOpenOriginal'
  | 'previewOpenWindow'

/** Preview command → combo; a cleared command is absent (key turned off) */
type PreviewHotkeyMap = Partial<Record<PreviewHotkeyCommand, HotkeyCombo>>

/** A plain letter key with no modifier */
const plainKey = (key: string): HotkeyCombo => ({
  key,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
})

/** Default preview keys (D / C / V as before they could be changed, plus F) */
const defaultPreviewHotkeys: PreviewHotkeyMap = {
  previewDownloadPost: plainKey('KeyD'),
  previewDownloadImage: plainKey('KeyC'),
  previewOpenOriginal: plainKey('KeyV'),
  previewOpenWindow: plainKey('KeyF'),
}

/** 清洗快捷鍵表：只收已知命令的有效組合。
 * 缺鍵保持缺（對齊 PBD 語義：「清除」後重載不復活；舊存檔本來就沒
 * hotkeys 鍵，走 defaultSettings 的完整預設，不受影響）。 */
function sanitizeHotkeys(input: unknown): HotkeyMap {
  return sanitizeComboMap(
    input,
    Object.keys(defaultHotkeys) as HotkeyCommand[],
    defaultHotkeys
  )
}

/** Same as sanitizeHotkeys, for the preview key table */
function sanitizePreviewHotkeys(input: unknown): PreviewHotkeyMap {
  return sanitizeComboMap(
    input,
    Object.keys(defaultPreviewHotkeys) as PreviewHotkeyCommand[],
    defaultPreviewHotkeys
  )
}

/** Keep only the listed commands that hold a valid, allowed combo. The editor
 * refuses two commands on one combo, so an imported table gets the same rule:
 * the first command (in table order) keeps the combo, a later one falls back
 * to its default combo if that is free, otherwise it is left unbound. */
function sanitizeComboMap<C extends string>(
  input: unknown,
  commands: C[],
  defaults: Partial<Record<C, HotkeyCombo>>
): Partial<Record<C, HotkeyCombo>> {
  const out: Partial<Record<C, HotkeyCombo>> = {}
  if (!input || typeof input !== 'object') {
    return out
  }
  const src = input as Record<string, unknown>
  const duplicates: C[] = []
  for (const cmd of commands) {
    // Same rules as the recorder: stored/imported hotkeys get no free pass
    const c = src[cmd]
    if (isHotkeyCombo(c) && isAllowedHotkeyCombo(c)) {
      const combo: HotkeyCombo = {
        key: c.key,
        ctrl: c.ctrl,
        alt: c.alt,
        shift: c.shift,
        meta: c.meta,
      }
      if (
        Object.values<HotkeyCombo | undefined>(out).some(
          (o) => o && sameHotkeyCombo(o, combo)
        )
      ) {
        duplicates.push(cmd)
        continue
      }
      out[cmd] = combo
    }
  }
  // Second pass, so a fallback default never takes a combo that a later
  // command holds explicitly
  for (const cmd of duplicates) {
    const fallback = defaults[cmd]
    const free =
      fallback &&
      !Object.values<HotkeyCombo | undefined>(out).some(
        (o) => o && sameHotkeyCombo(o, fallback)
      )
    console.warn(
      `[PawchivePro] hotkey for "${cmd}" duplicates another command; ` +
        (free ? 'using its default' : 'left unbound')
    )
    if (free) {
      out[cmd] = { ...fallback }
    }
  }
  return out
}

/** Remove the commands of `map` whose combo is also bound in `others`; each
 * falls back to its default combo when that is free, else stays unbound. */
function dropComboConflicts<C extends string>(
  map: Partial<Record<C, HotkeyCombo>>,
  defaults: Partial<Record<C, HotkeyCombo>>,
  others: HotkeyCombo[]
): Partial<Record<C, HotkeyCombo>> {
  const taken = (combo: HotkeyCombo, own: HotkeyCombo[]) =>
    [...others, ...own].some((o) => sameHotkeyCombo(o, combo))
  const out: Partial<Record<C, HotkeyCombo>> = {}
  const dropped: C[] = []
  for (const cmd of Object.keys(map) as C[]) {
    const combo = map[cmd]
    if (!combo) {
      continue
    }
    if (others.some((o) => sameHotkeyCombo(o, combo))) {
      dropped.push(cmd)
    } else {
      out[cmd] = combo
    }
  }
  for (const cmd of dropped) {
    const fallback = defaults[cmd]
    const free =
      fallback &&
      !taken(
        fallback,
        Object.values<HotkeyCombo | undefined>(out).filter(
          (o): o is HotkeyCombo => !!o
        )
      )
    console.warn(
      `[PawchivePro] hotkey for "${cmd}" is already used by another table; ` +
        (free ? 'using its default' : 'left unbound')
    )
    if (free) {
      out[cmd] = { ...fallback }
    }
  }
  return out
}

/** A global hotkey swallows its key before the hover preview sees it, so the
 * two tables may not share a combo either (the editor enforces this). Which
 * table gives way is decided by `loser`. */
function resolveHotkeyTables(
  hotkeys: HotkeyMap,
  previewHotkeys: PreviewHotkeyMap,
  loser: 'hotkeys' | 'previewHotkeys'
): { hotkeys: HotkeyMap; previewHotkeys: PreviewHotkeyMap } {
  const combos = (m: Partial<Record<string, HotkeyCombo>>) =>
    Object.values(m).filter((c): c is HotkeyCombo => !!c)
  if (loser === 'previewHotkeys') {
    return {
      hotkeys,
      previewHotkeys: dropComboConflicts(
        previewHotkeys,
        defaultPreviewHotkeys,
        combos(hotkeys)
      ),
    }
  }
  return {
    hotkeys: dropComboConflicts(
      hotkeys,
      defaultHotkeys,
      combos(previewHotkeys)
    ),
    previewHotkeys,
  }
}

type PawchiveSettings = PreviewSettings &
  DownloadSettings &
  FilterSettings &
  MetaSettings

type SettingKey = keyof PawchiveSettings

const defaultSettings: PawchiveSettings = {
  PreviewWork: true,
  previewWorkWait: 400,
  previewOriginalImage: false,
  showPreviewWorkTip: true,
  keepPreviewOnFloatHover: true,
  previewInfoPlacement: defaultPreviewInfoPlacement,
  allowPreviewCoverThumbnail: false,
  wheelScrollSwitchImageOnPreviewWork: true,
  wheelScrollPageMoveDistance: 30,
  previewPreloadNext: 1,
  previewPreloadPrev: 0,
  showDownloadBtnOnThumb: true,
  PreviewCreator: true,
  previewCreatorCount: 12,
  keepCreatorPreviewOnFloatHover: true,
  downloadThread: Config.downloadThreadDefault,
  downloadInterval: 0,
  crawlInterval: 0.5,
  autoMountCache: true,
  autoStartDownload: true,
  setFileDownloadOrder: false,
  textContent: 'txt',
  noCoverFile: false,
  downloadOriginalImage: true,
  filterTitle: '',
  filterDateFrom: '',
  filterDateTo: '',
  filterMinFiles: 0,
  filterMaxFiles: 0,
  downImageFiles: true,
  downVideoFiles: true,
  downOtherFiles: true,
  downloadCover: true,
  skipPendingPosts: true,
  filterServices: '',
  filterPostIdFrom: '',
  filterPostIdTo: '',
  filterMaxSizeMiB: 0,
  userSetLang: 'auto',
  skipDownloaded: 'record',
  showFloatingButton: true,
  namingRule:
    'kemono/{service}/{creator}-{creator_id}/{post_id}-{title}/{index}-{file_name}.{ext}',
  namingRulePawchive: '',
  hotkeys: defaultHotkeys,
  previewHotkeys: defaultPreviewHotkeys,
}

/** 數值鍵的夾取規則（整數鍵先四捨五入） */
const numberRules: Partial<
  Record<SettingKey, { min: number; max: number; integer?: boolean }>
> = {
  previewWorkWait: { min: 0, max: 2000, integer: true },
  wheelScrollPageMoveDistance: { min: 1, max: 2000, integer: true },
  previewPreloadNext: { min: 0, max: 10, integer: true },
  previewPreloadPrev: { min: 0, max: 10, integer: true },
  previewCreatorCount: { min: 1, max: 50, integer: true },
  downloadThread: { min: 1, max: Config.downloadThreadMax, integer: true },
  downloadInterval: { min: 0, max: 3600 },
  crawlInterval: { min: 0, max: 10 },
  filterMinFiles: { min: 0, max: 100000, integer: true },
  filterMaxFiles: { min: 0, max: 100000, integer: true },
  filterMaxSizeMiB: { min: 0, max: 1048576 },
}

/** 枚舉鍵的白名單（不在名單內回預設） */
const enumWhitelists: Partial<Record<SettingKey, readonly string[]>> = {
  textContent: ['none', 'txt', 'html'],
  userSetLang: ['auto', ...langCodes],
  skipDownloaded: ['none', 'record', 'folder', 'both'],
}

/** Whether a string is a real calendar date written as YYYY-MM-DD */
function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!m) {
    return false
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  )
}

/** A date filter is empty or YYYY-MM-DD; anything else counts as unset */
const sanitizeDateFilter = (v: string): string => {
  const t = v.trim()
  return t === '' || isIsoDate(t) ? t : ''
}

/** A post id bound is empty or digits only (the filter ignores anything else,
 * so keeping it would only mislead). Length is capped as a sanity limit. */
const sanitizePostIdBound = (v: string): string => {
  const t = v.trim()
  return /^\d{1,32}$/.test(t) ? t : ''
}

/** The service list is comma-separated service names; entries that are not
 * plain names are dropped, and the list is capped. */
const sanitizeServiceList = (v: string): string =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]{1,32}$/.test(s))
    .slice(0, 32)
    .join(',')

/** String keys with a format rule (the value is already known to be a string) */
const stringRules: Partial<Record<SettingKey, (v: string) => string>> = {
  filterDateFrom: sanitizeDateFilter,
  filterDateTo: sanitizeDateFilter,
  filterPostIdFrom: sanitizePostIdBound,
  filterPostIdTo: sanitizePostIdBound,
  filterServices: sanitizeServiceList,
}

/** Version of the stored settings object. Bump it when a stored key changes
 * meaning and add the matching step to migrateSettingsObject. */
const SETTINGS_SCHEMA_VERSION = 1

/** 舊版存檔／匯入檔的相容轉換：舊的 deduplication／skipExistingFiles 合併成
 * skipDownloaded（新鍵已存在則以新鍵為準），並丟掉已移除的舊鍵
 * （dupliStrategy／switchImageByKeyboard 一併忽略）。回傳新物件，不改原物件。 */
function migrateLegacySettings(
  input: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...input }
  const hasLegacy = 'deduplication' in out || 'skipExistingFiles' in out
  if (hasLegacy && out.skipDownloaded === undefined) {
    // 缺的舊鍵按當時的預設值：去重開、略過已存在檔案關
    const dedup =
      typeof out.deduplication === 'boolean' ? out.deduplication : true
    const folder =
      typeof out.skipExistingFiles === 'boolean' ? out.skipExistingFiles : false
    out.skipDownloaded =
      dedup && folder ? 'both' : dedup ? 'record' : folder ? 'folder' : 'none'
  }
  delete out.deduplication
  delete out.dupliStrategy
  delete out.skipExistingFiles
  delete out.switchImageByKeyboard
  return out
}

/** 依鍵清洗單一設定值（set／restore／設定匯入共用）。
 * 型別不符（物件鍵除外）→ 預設值；數值鍵非有限數 → 預設值，其餘夾取；
 * 枚舉鍵不在白名單 → 預設值；物件鍵走各自的逐項清洗。 */
function sanitizeSetting<K extends SettingKey>(
  key: K,
  value: unknown
): PawchiveSettings[K] {
  const def = defaultSettings[key] as PawchiveSettings[K]
  // 物件型鍵先交給各自的清洗函數（每次回新物件，不共用預設引用）
  if (key === 'hotkeys') {
    return sanitizeHotkeys(value) as PawchiveSettings[K]
  }
  if (key === 'previewHotkeys') {
    return sanitizePreviewHotkeys(value) as PawchiveSettings[K]
  }
  if (key === 'previewInfoPlacement') {
    return sanitizePreviewInfoPlacement(value) as PawchiveSettings[K]
  }
  // 型別不符（損壞／跨版本）直接回預設
  if (typeof value !== typeof def) {
    return def
  }
  const rule = numberRules[key]
  if (rule) {
    const v = value as number
    if (!Number.isFinite(v)) {
      return def
    }
    const n = rule.integer ? Math.round(v) : v
    return Math.min(Math.max(n, rule.min), rule.max) as PawchiveSettings[K]
  }
  const whitelist = enumWhitelists[key]
  if (whitelist) {
    return (
      whitelist.includes(value as string) ? value : def
    ) as PawchiveSettings[K]
  }
  const stringRule = stringRules[key]
  if (stringRule) {
    return stringRule(value as string) as PawchiveSettings[K]
  }
  // 其餘布林／字串鍵：型別正確即原樣回傳
  return value as PawchiveSettings[K]
}

/** Schema version of a stored/imported object; 0 when missing or invalid */
function readSchemaVersion(input: Record<string, unknown>): number {
  const v = input.schemaVersion
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 0
}

/** Bring a stored or imported object up to the current schema. An object with
 * no schemaVersion is legacy: the legacy migration runs on it. The result is
 * a new object that carries the current schemaVersion (a newer one is kept). */
function migrateSettingsObject(
  input: Record<string, unknown>
): Record<string, unknown> {
  const version = readSchemaVersion(input)
  const out = version === 0 ? migrateLegacySettings(input) : { ...input }
  out.schemaVersion = Math.max(version, SETTINGS_SCHEMA_VERSION)
  return out
}

/** Run a raw stored/imported settings object through the migration and
 * per-key sanitizing (shared by restore(), settings import and the cross-tab
 * storage listener). Keys absent from the input are absent from the result.
 * `current` supplies the other side of the cross-key checks (hotkey tables,
 * file-count range) for keys that the input does not carry. */
function parseStoredSettings(
  raw: object,
  current?: Partial<PawchiveSettings>
): Partial<PawchiveSettings> {
  const saved = migrateSettingsObject(
    raw as Record<string, unknown>
  ) as Partial<PawchiveSettings>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(defaultSettings) as SettingKey[]) {
    // 存檔有此鍵就清洗後保留（型別不符／非法值回預設）
    if (saved[key] !== undefined) {
      out[key] = sanitizeSetting(key, saved[key])
    }
  }
  const result = out as Partial<PawchiveSettings>

  // Min above max (both set; 0 = unset) can match nothing: swap them
  const min = result.filterMinFiles ?? current?.filterMinFiles ?? 0
  const max = result.filterMaxFiles ?? current?.filterMaxFiles ?? 0
  if (min > 0 && max > 0 && min > max) {
    if (
      result.filterMinFiles !== undefined &&
      result.filterMaxFiles !== undefined
    ) {
      result.filterMinFiles = max
      result.filterMaxFiles = min
    } else if (result.filterMinFiles !== undefined) {
      // Only min came in: it gives way to the stored max
      result.filterMinFiles = max
    } else {
      result.filterMaxFiles = min
    }
  }

  // A preview key may not share a combo with a global hotkey
  if (result.hotkeys || result.previewHotkeys) {
    const resolved = resolveHotkeyTables(
      result.hotkeys ?? current?.hotkeys ?? {},
      result.previewHotkeys ?? current?.previewHotkeys ?? {},
      result.hotkeys && !result.previewHotkeys ? 'hotkeys' : 'previewHotkeys'
    )
    if (result.hotkeys) result.hotkeys = resolved.hotkeys
    if (result.previewHotkeys) result.previewHotkeys = resolved.previewHotkeys
  }
  return result
}

class Settings {
  private store: PawchiveSettings = { ...defaultSettings }
  private saveTimer = 0
  /** Set when restore() has finished; storage events before that are held. */
  private restored = false
  /** Latest storage value seen while restore() was still running. */
  private pendingRemote: object | null = null
  /** Set when restore() could not read storage; saving is held back until a
   * later read succeeds, so defaults never overwrite the saved settings. */
  private loadFailed = false
  private saveBlockedNotified = false
  /** Set once a write has failed, cleared by the next success, so the user is
   * told once per outage and not on every change. */
  private saveFailedNotified = false
  /** Keys changed locally and not yet written, each with the revision of its
   * latest change. A remote change must not overwrite them (they are about to
   * be saved over it); a key is cleaned after a write only if it was not
   * changed again while that write was in flight. */
  private dirtyRev = new Map<SettingKey, number>()
  private revCounter = 0
  /** Serializes saves: each one reads storage, so two must not interleave. */
  private saveChain: Promise<void> = Promise.resolve()

  constructor() {
    // Other tabs share chrome.storage.local: pick up their changes so this
    // tab neither shows stale values nor writes them back over newer ones.
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') {
        return
      }
      const change = changes[Config.settingStoreName]
      const value: unknown = change?.newValue
      if (!value || typeof value !== 'object') {
        return
      }
      if (!this.restored) {
        // Applying now would race restore(); apply once it has finished.
        this.pendingRemote = value
        return
      }
      this.applyRemote(value)
    })
  }

  /** Apply a settings object written by another tab. Only differing keys are
   * assigned; each fires settingChange like set() but nothing is saved, so
   * there is no write-back loop. Keys absent from the value are untouched. */
  private applyRemote(raw: object): void {
    const incoming = parseStoredSettings(raw, this.store)
    for (const key of Object.keys(incoming) as SettingKey[]) {
      if (this.dirtyRev.has(key)) {
        continue
      }
      const value = incoming[key]
      if (JSON.stringify(value) === JSON.stringify(this.store[key])) {
        continue
      }
      ;(this.store as Record<SettingKey, unknown>)[key] = value
      EVT.fire('settingChange', { key, value })
    }
  }

  public get<K extends SettingKey>(key: K): PawchiveSettings[K] {
    return this.store[key]
  }

  /** Shallow copy of every current value (context for cross-key checks) */
  public snapshot(): PawchiveSettings {
    return { ...this.store }
  }

  public set<K extends SettingKey>(key: K, value: PawchiveSettings[K]): void {
    // 所有鍵統一清洗（擋掉面板輸入與設定匯入的髒資料）
    value = sanitizeSetting(key, value)
    this.store[key] = value
    this.dirtyRev.set(key, ++this.revCounter)
    EVT.fire('settingChange', { key, value })
    this.scheduleSave()
  }

  /** 所有設定恢復預設值：逐鍵走 set，各模組照常收到 settingChange 即時更新 */
  public resetAll(): void {
    for (const key of Object.keys(defaultSettings) as SettingKey[]) {
      this.set(key, defaultSettings[key] as never)
    }
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveChain = this.saveChain.then(() => this.save())
    }, 50)
  }

  private async save(): Promise<void> {
    // The saved settings were never read, so the store holds defaults plus
    // whatever was just changed. Writing it would replace the user's saved
    // settings: read them first, and refuse to write while that still fails.
    if (this.loadFailed && !(await this.retryLoad())) {
      if (!this.saveBlockedNotified) {
        this.saveBlockedNotified = true
        EVT.fire('settingSaveBlocked')
      }
      return
    }
    const sent = new Map(this.dirtyRev)
    if (sent.size === 0) {
      return
    }
    try {
      // Read-modify-write: another tab may have changed other keys since this
      // tab last looked, so only this tab's dirty keys are laid over what is
      // stored now. Writing the whole store would undo their changes.
      const data = await chrome.storage.local.get(Config.settingStoreName)
      const raw = data?.[Config.settingStoreName] as unknown
      const stored: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? migrateSettingsObject(raw as Record<string, unknown>)
          : { schemaVersion: SETTINGS_SCHEMA_VERSION }
      for (const key of sent.keys()) {
        stored[key] = this.store[key]
      }
      await chrome.storage.local.set({ [Config.settingStoreName]: stored })
    } catch (e) {
      // Keep the keys dirty: the next change retries them, and a remote value
      // must not overwrite them in the meantime.
      console.error('[PawchivePro] save settings failed', e)
      if (!this.saveFailedNotified) {
        this.saveFailedNotified = true
        EVT.fire('settingSaveBlocked', { reason: 'writeFailed' })
      }
      return
    }
    this.saveFailedNotified = false
    for (const [key, rev] of sent) {
      if (this.dirtyRev.get(key) === rev) {
        this.dirtyRev.delete(key)
      }
    }
  }

  /** Second attempt at the read that failed in restore(). Keys changed in the
   * meantime keep their new value; every other key takes the saved one. */
  private async retryLoad(): Promise<boolean> {
    try {
      const data = await chrome.storage.local.get(Config.settingStoreName)
      const raw = data[Config.settingStoreName] as unknown
      this.loadFailed = false
      if (raw && typeof raw === 'object') {
        this.applyRemote(raw)
      }
      return true
    } catch (e) {
      console.error('[PawchivePro] restore settings failed again', e)
      return false
    }
  }

  /** 啟動時呼叫：讀回存檔（缺鍵補預設），完成後發 settingInitialized */
  public async restore(): Promise<void> {
    try {
      const data = await chrome.storage.local.get(Config.settingStoreName)
      const raw = data[Config.settingStoreName] as unknown
      if (raw && typeof raw === 'object') {
        // 舊版存檔先做相容轉換、逐鍵清洗（與跨分頁同步共用）
        Object.assign(this.store, parseStoredSettings(raw, this.store))
      }
    } catch (e) {
      console.error('[PawchivePro] restore settings failed, use defaults', e)
      this.loadFailed = true
    }
    // 快捷鍵表逐項校驗（舊存檔缺 hotkeys 鍵時沿用預設；同時斷開與
    // defaultSettings 的共享引用，避免後續誤改預設）
    this.store.hotkeys = sanitizeHotkeys(this.store.hotkeys)
    this.store.previewHotkeys = sanitizePreviewHotkeys(
      this.store.previewHotkeys
    )
    // 資訊列位置表同樣逐欄校驗（舊存檔無此鍵；null 存檔會被清洗回預設）
    this.store.previewInfoPlacement = sanitizePreviewInfoPlacement(
      this.store.previewInfoPlacement
    )
    this.restored = true
    EVT.fire('settingInitialized')
    // A change from another tab that arrived mid-restore: apply it now
    const pending = this.pendingRemote
    this.pendingRemote = null
    if (pending) {
      this.applyRemote(pending)
    }
  }
}

const settings = new Settings()

/** 便捷寫法（對齊 PBD 的 setSetting 語義） */
function setSetting<K extends SettingKey>(
  key: K,
  value: PawchiveSettings[K]
): void {
  settings.set(key, value)
}

export {
  settings,
  setSetting,
  defaultSettings,
  defaultHotkeys,
  defaultPreviewHotkeys,
  sanitizeHotkeys,
  sanitizePreviewHotkeys,
  sanitizeSetting,
  migrateLegacySettings,
  migrateSettingsObject,
  parseStoredSettings,
  SETTINGS_SCHEMA_VERSION,
}
export type {
  PreviewSettings,
  DownloadSettings,
  FilterSettings,
  MetaSettings,
  PawchiveSettings,
  SettingKey,
  HotkeyCombo,
  HotkeyCommand,
  HotkeyMap,
  PreviewHotkeyCommand,
  PreviewHotkeyMap,
}
