/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixivBatchDownloader src/ts/FileName.ts engine mechanics
 *          (xuejianxianzun): generateFileName shape,
 *          handleOptionalSegments (verbatim), removeEmptyTag,
 *          handleEdgeCases, lengthLimit (folder-aware truncation kept).
 * changes: token set rewritten for Kemono
 *          ({service}/{creator}/{creator_id}/{post_id}/{title}/{date}/
 *          {year}/{month}/{day}/{index}/{file_name}/{ext}/{kind});
 *          Pixiv special tags (multi_image_folder/r18/tags/...) deleted;
 *          removeEmoji switch deleted; rule source = settings namingRule.
 *          Default: pawchive/{service}/{creator}-{creator_id}/
 *                   {post_id}-{title}/{index}-{file_name}.{ext}
 */

import { Config } from '../Config'
import { log } from '../Log'
import { lang } from '../Language'
import { isKemonoService } from '../kemono/pages'
import { settings } from '../setting/Settings'
import { Result } from '../store/StoreType'
import { handleWindowsReservedName, replaceUnsafeStr } from '../Tools'
import { makeCreatorKey, siteOfHost } from '../watch/watchKey'
import { watchStore } from '../watch/watchStore'

/** 逸出正則表示式特殊字元（標記與副檔名都可能含正則語法） */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** UTF-8 位元組長度（檔名長度上限以位元組計） */
const textEncoder =
  typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** Bytes set aside for the extension when deciding how far to truncate the
 * folders (".torrent" is 8). A constant, so the decision is the same for
 * every file of a post. */
const EXT_RESERVE_BYTES = 8

function utf8Length(str: string): number {
  if (textEncoder) {
    return textEncoder.encode(str).length
  }
  // 無 TextEncoder 時依碼點估算位元組數
  let bytes = 0
  for (const char of str) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code <= 0xffff) {
      bytes += 3
    } else {
      bytes += 4
    }
  }
  return bytes
}

/** 依 UTF-8 位元組上限截斷，不切斷多位元組字元或代理對 */
function truncateByBytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  let bytes = 0
  let result = ''
  // for...of 以碼點迭代，代理對不會被拆開
  for (const char of str) {
    const size = utf8Length(char)
    if (bytes + size > maxBytes) {
      break
    }
    result += char
    bytes += size
  }
  return result
}

/** 命名標記表：token → 取值（先 sanitize 再用於檔名） */
interface NamingSchema {
  [tag: string]: {
    value: string
  }
}

/** '~' is valid in file names: keep it in the rule's own text so existing
 * names (and the local-file check) do not change */
const RULE_LITERAL_KEEP = ['~'] as const

class FileName {
  /** 內建預設規則（規則被清空時回退用，避免產出 `.png` 這種垃圾檔名） */
  public readonly defaultRule =
    'pawchive/{service}/{creator}-{creator_id}/{post_id}-{title}/{index}-{file_name}.{ext}'

  /** 為一條抓取結果生成檔名（含資料夾路徑） */
  public createFileName(result: Result, host = location.host): string {
    const rule = this.getRule()
    const schema = this.buildSchema(result, host)
    let name = this.generateFileName(rule, schema)
    // 規則沒寫 {ext} 時自動補副檔名（沿用 buildSchema 推回並清潔過的副檔名）
    if (!rule.includes('{ext}')) {
      name += '.' + replaceUnsafeStr(schema['{ext}'].value)
    }
    return this.lengthLimit(name, result.postId)
  }

  /** 取當前生效的規則（空白回退預設） */
  public getRule(): string {
    return settings.get('namingRule').trim() || this.defaultRule
  }

  /** 由抓取結果建標記表 */
  public buildSchema(result: Result, host = location.host): NamingSchema {
    const date = (result.published || '').slice(0, 10)
    const [year = '', month = '', day = ''] = date.split('-')
    const rawName = result.fileName || result.postId
    // result.ext 缺失時由原名推回，避免 `{file_name}.{ext}` 產生雙副檔名
    const dot = rawName.lastIndexOf('.')
    const fallbackExt = dot > 0 ? rawName.slice(dot + 1) : ''
    const ext = (result.ext || fallbackExt || 'bin').toLowerCase()
    // 附件原名多半自帶副檔名，{file_name} 取主幹，避免 `a.png.png`
    const stem = rawName.replace(
      new RegExp(`\\.${escapeRegExp(ext)}$`, 'i'),
      ''
    )
    const creator = result.creator || result.creatorId
    let creatorAlias = creator
    const site = siteOfHost(host)
    if (site && isKemonoService(result.service) && result.creatorId) {
      try {
        const key = makeCreatorKey(site, result.service, result.creatorId)
        const alias = watchStore.data.creators[key]?.alias?.trim()
        if (alias) creatorAlias = alias
      } catch {
        // Invalid creatorId: fall back to creator name
      }
    }
    return {
      '{service}': { value: result.service || 'unknown' },
      '{creator}': { value: creator },
      '{creator_alias}': { value: creatorAlias },
      '{creator_id}': { value: result.creatorId },
      '{post_id}': { value: result.postId },
      '{title}': { value: result.title || result.postId },
      '{date}': { value: date },
      '{year}': { value: year },
      '{month}': { value: month },
      '{day}': { value: day },
      '{index}': { value: String(result.fileIndex) },
      '{file_name}': { value: stem || result.postId },
      '{ext}': { value: ext },
      '{kind}': { value: result.kind },
    }
  }

  /** 傳入命名規則和標記表，生成檔名（供面板預覽複用） */
  public generateFileName(rule: string, schema: NamingSchema): string {
    const normalizedSchema = this.normalizeSchema(schema)

    // 處理可選片段 [...]（無特殊標記，單遍即可）
    let result = this.handleOptionalSegments(rule, normalizedSchema)

    // 空標記先移除其前面的分隔符
    for (const [tag, obj] of Object.entries(normalizedSchema)) {
      if ((obj.value ?? '') === '') {
        result = this.removeEmptyTag(result, tag)
      }
    }

    // 一次替換所有標記，避免插入值中的文字被當成標記再解析（token 殘留）
    // The literal text between tags comes from the user's rule and gets the same
    // sanitizing as tag values (only "/" stays: it separates the folders)
    const tags = Object.keys(normalizedSchema)
    if (tags.length > 0) {
      const tagRegExp = new RegExp(`(${tags.map(escapeRegExp).join('|')})`)
      // split() with a capture group puts the matched tags at the odd indexes
      result = result
        .split(tagRegExp)
        .map((part, i) =>
          i % 2 === 1
            ? (normalizedSchema[part].value ?? '')
            : replaceUnsafeStr(part, true, RULE_LITERAL_KEEP)
        )
        .join('')
    } else {
      result = replaceUnsafeStr(result, true, RULE_LITERAL_KEEP)
    }

    // 移除檔名開頭不可用的字元
    result = this.removeStartChar(result)

    // 去掉尾部 /
    if (result.endsWith('/')) {
      result = result.substring(0, result.length - 1)
    }

    // 處理連續的 /
    result = result.replace(/\/{2,100}/g, '/')

    // 邊界處理
    result = this.handleEdgeCases(result)

    return result
  }

  /**
   * Characters in the literal text of a naming rule that file names cannot
   * hold (tags such as {title} are ignored). generateFileName replaces them
   * with full-width ones; the settings page uses this to warn about them.
   */
  public findUnsafeRuleChars(rule: string): string[] {
    const literal = rule.replace(/\{[a-z_]+\}/g, '')
    const found = new Set<string>()
    // eslint-disable-next-line no-control-regex
    for (const ch of literal.matchAll(/[\\:*?"<>|\u0000-\u001f\u007f]/g)) {
      found.add(ch[0])
    }
    return [...found]
  }

  /** 預處理標記值：全形化非法字元（含 ext，避免外部資料夾帶入不安全字元） */
  private normalizeSchema(schema: NamingSchema): NamingSchema {
    const result: NamingSchema = {}

    for (const [tag, obj] of Object.entries(schema)) {
      result[tag] = { value: replaceUnsafeStr(obj.value ?? '') }
    }

    return result
  }

  /**
   * 處理命名規則中的可選片段，即用 [] 包起標記及其前後自訂字元的情況，
   * 如 `[{post_id}-]`。當片段內單個標記值為空時，整個片段移除。
   * （照搬 PBD handleOptionalSegments，拿掉特殊標記雙遍邏輯）
   */
  private handleOptionalSegments(rule: string, schema: NamingSchema): string {
    const matchedBrackets = new Map<number, number>()
    const openBrackets: number[] = []

    // 記錄每一對閉合的方括號。未閉合的不進映射，原樣保留
    for (let index = 0; index < rule.length; index++) {
      if (rule[index] === '[') {
        openBrackets.push(index)
      } else if (rule[index] === ']' && openBrackets.length > 0) {
        matchedBrackets.set(openBrackets.pop()!, index)
      }
    }

    const tagNames = Object.keys(schema)
    if (tagNames.length === 0) {
      return rule
    }

    const tagRegExp = new RegExp(tagNames.map(escapeRegExp).join('|'), 'g')

    /** 處理指定範圍內的字元，內層方括號優先 */
    const processRange = (start: number, end: number): string => {
      let result = ''
      let index = start

      while (index < end) {
        const closeIndex = matchedBrackets.get(index)

        if (closeIndex !== undefined && closeIndex < end) {
          const content = processRange(index + 1, closeIndex)
          let hasNestedSegment = false

          for (
            let childIndex = index + 1;
            childIndex < closeIndex;
            childIndex++
          ) {
            if (matchedBrackets.has(childIndex)) {
              hasNestedSegment = true
              break
            }
          }

          if (hasNestedSegment) {
            // 外層方括號視為普通字元，內層已處理的片段保留
            result += `[${content}]`
          } else {
            const tags =
              rule.slice(index + 1, closeIndex).match(tagRegExp) ?? []

            if (tags.length === 0) {
              // 無標記時方括號是普通字元
              result += `[${content}]`
            } else if (
              tags.length === 1 &&
              (schema[tags[0]].value ?? '') === ''
            ) {
              // 單個空標記使整個可選片段失效
            } else {
              // 有標記的片段去掉方括號
              result += content
            }
          }

          index = closeIndex + 1
          continue
        }

        result += rule[index]
        index++
      }

      return result
    }

    return processRange(0, rule.length)
  }

  // 空標記移除其前面的分隔符（- _ 空格 , & #）
  private removeEmptyTag(rule: string, tag: string): string {
    const symbols = ['-', '_', ' ', ',', '&', '#']
    for (const symbol of symbols) {
      rule = rule.replaceAll(symbol + tag, '')
    }

    return rule
  }

  private readonly checkStartCharList = ['/', ' ']

  private checkStartChar(str: string) {
    return this.checkStartCharList.includes(str[0])
  }

  private removeStartChar(str: string) {
    while (this.checkStartChar(str)) {
      str = str.substring(1, str.length)
    }
    return str
  }

  /** 如果某層路徑是 Windows 保留檔名，在其後添加此字串 */
  private readonly addStr = '[WindowsReservedName]'

  /** 邊界處理：逐層 trim、頭尾點全形化、保留名處理、去空層 */
  public handleEdgeCases(string: string) {
    string = string.replace(/\/{2,100}/g, '/')

    const parts = string.split('/')

    for (let i = 0; i < parts.length; i++) {
      // 去掉每層首尾空格；頭尾的 . 換全形（Chrome 不允許頭尾用 .）
      parts[i] = parts[i].trim().replace(/^\./g, '．').replace(/\.$/g, '．')

      // Windows 保留檔名處理（不含副檔名層由 lengthLimit 保證唯一性）
      parts[i] = handleWindowsReservedName(parts[i], this.addStr)
    }

    string = parts.filter((part) => part !== '').join('/')
    return string
  }

  /** Length limit: truncate inner folders only when even a minimal file part
   * would not fit, then cut the file part to the space that is left.
   * 長度以 UTF-8 位元組計算，且截斷不切斷多位元組字元或代理對
   * @param fullName 全路徑含副檔名
   * @param id 必須保留的唯一字串（postId）
   */
  public lengthLimit(fullName: string, id: string) {
    const limit = Config.fullNameLengthLimit

    // No early return for a path that already fits: whether the folders are
    // truncated must not depend on this one file's name, or a post's short
    // and long file names would land in different folders.

    // 只認最後一層的副檔名，避免資料夾名稱中的點被誤判
    const slashIndex = fullName.lastIndexOf('/')
    const dotIndex = fullName.lastIndexOf('.')
    // 點在最後一層開頭時是隱藏檔名，不是副檔名
    const hasExt = dotIndex > slashIndex + 1
    const ext = hasExt ? fullName.slice(dotIndex) : ''
    const parts = (hasExt ? fullName.slice(0, dotIndex) : fullName).split('/')

    const totalLength = () => utf8Length(parts.join('/')) + utf8Length(ext)

    // 單層上限：避免任一層超過檔案系統的單一名稱限制
    const partLimit = Math.min(255, limit)
    for (let i = 0; i < parts.length; i++) {
      if (utf8Length(parts[i]) > partLimit) {
        const whole = parts[i]
        let cut = truncateByBytes(whole, partLimit).trim()
        // A folder that carried the id at its end keeps it (see below)
        if (i < parts.length - 1 && id && whole.includes(id)) {
          const tail = '-' + id
          if (!cut.includes(id) && utf8Length(tail) < partLimit) {
            cut =
              truncateByBytes(whole, partLimit - utf8Length(tail)).trim() + tail
          }
        }
        parts[i] = cut
      }
    }

    const lastIndex = parts.length - 1
    const extBytes = utf8Length(ext)
    const idBytes = id ? utf8Length(id) : 0
    const folderBytes = () =>
      lastIndex > 0 ? utf8Length(parts.slice(0, lastIndex).join('/')) + 1 : 0
    const folderHasId = () =>
      !!id && parts.slice(0, lastIndex).some((part) => part.includes(id))

    // Bytes every file part is guaranteed. Folders are truncated against this
    // constant, never against the real file part, so all files of one post
    // get the same folder names. When no folder carries the id, the file part
    // may need a `-id…` suffix, so room for it is reserved as well.
    const suffix = id ? '-' + id + '…' : ''
    const reserve = !id ? 8 : folderHasId() ? idBytes : utf8Length(suffix) + 4

    // Folders, innermost first (outer levels stay whole so a creator's posts
    // do not scatter): keep at least 25 bytes, aligned to a multiple of 25.
    // The extension is reserved as a constant too, so ".png" and ".jpeg"
    // files of one post truncate the folders alike.
    const reservedTotal = () => folderBytes() + reserve + EXT_RESERVE_BYTES
    for (let i = lastIndex - 1; i >= 0 && reservedTotal() > limit; i--) {
      const part = parts[i]
      const partBytes = utf8Length(part)
      const excess = reservedTotal() - limit
      const minLength = 25
      const ellipsisBytes = utf8Length('…')
      if (partBytes > minLength + ellipsisBytes) {
        const target = Math.max(partBytes - excess - ellipsisBytes, minLength)
        const units = Math.max(Math.floor(target / minLength), 1)
        const keep = Math.min(units * minLength, partBytes)
        if (partBytes - keep > ellipsisBytes) {
          let cut = truncateByBytes(part, keep).trim() + '…'
          if (id && part.includes(id) && !cut.includes(id)) {
            // The id sat in the part that was cut off (a rule such as
            // "{title}-{post_id}"): put it back, or two posts with the same
            // long title would share one folder
            const tail = '-' + id
            const headBytes = Math.max(keep - utf8Length(tail), 1)
            cut = truncateByBytes(part, headBytes).trim() + '…' + tail
          }
          parts[i] = cut
        }
      }
    }

    // Fits (possibly after the folders were shortened): nothing more to cut
    if (totalLength() <= limit) {
      const fitted = parts.join('/') + ext
      if (fitted !== fullName) {
        log.warning(lang.transl('_filenameTruncated', fullName))
      }
      return fitted
    }

    // File part: use whatever the folders left and cut from the end, so a
    // leading `{index}-` survives and files of one post stay distinct.
    const space = limit - folderBytes() - extBytes
    const filePart = parts[lastIndex]
    if (space > 0 && utf8Length(filePart) > space) {
      let head = truncateByBytes(filePart, space).trim()
      if (id && !folderHasId() && !head.includes(id)) {
        // The id is nowhere else in the path: keep it for uniqueness
        const suffixBytes = utf8Length(suffix)
        head =
          suffixBytes < space
            ? truncateByBytes(filePart, space - suffixBytes).trim() + suffix
            : id
      }
      parts[lastIndex] = head || id || filePart
    }

    // 總長回檢：仍有極端超長時，先丟外層資料夾，最後才硬截檔名
    while (totalLength() > limit && parts.length > 1) {
      parts.shift()
    }
    if (totalLength() > limit && parts.length === 1) {
      const budget = Math.max(limit - utf8Length(ext), 0)
      parts[0] = truncateByBytes(parts[0], budget).trim()
    }

    log.warning(lang.transl('_filenameTruncated', fullName))
    return parts.join('/') + ext
  }
}

const fileName = new FileName()
export { fileName }
