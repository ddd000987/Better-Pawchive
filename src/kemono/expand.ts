/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: Kemono-Downloader src/sites/kemono-family/post-resource.ts
 *          expandPostResource (buildPostMeta file-list section)
 * changes: KD Resource/queue/storage replaced with direct input + Pawchive
 *          settings/previewAssets. File URLs computed once here via
 *          downloadUrl() (url in expand). Text sidecar
 *          (content.txt/html) included as kind=text with inline data.
 */

import { fileKind, extensionOf } from './fileType'
import { settings } from '../setting/Settings'
import { KemonoFileKind } from '../store/StoreType'
import { FileItem, PostApiResponse, isPendingPost } from './apiTypes'
import { downloadUrl } from '../preview/previewAssets'

/** 展開後的一條檔案記錄（對應一條 Result 的檔案部分） */
export interface ExpandedFile {
  kind: KemonoFileKind
  fileName: string
  ext: string
  fileUrl: string
  previewOnly: boolean
  /** kind=text 時為檔案內容（不走 fetch） */
  textData: string
}

export interface ExpandedPost {
  pending: boolean
  files: ExpandedFile[]
}

function kindOf(file: FileItem, isCover: boolean): KemonoFileKind {
  // 先依實際副檔名判定，封面只在真的是圖片時才覆寫成 cover，
  // 避免非圖片封面把 video/other 的種類吃掉
  const kind = fileKind(file)
  return isCover && kind === 'image' ? 'cover' : kind
}

/** One downloadable (non-text) file of a post, in expansion order */
export interface MediaFile {
  file: FileItem
  isCover: boolean
}

/**
 * The single source of truth for which files a post expands to: attachments
 * (deduped by path, malformed entries without a path dropped) followed by the
 * cover, which is dropped when noCoverFile is on or its path already is an
 * attachment. Both the list quick screen and the full expansion use this, so
 * the two stages cannot disagree on the file count or the kinds.
 */
function collectMediaFiles(
  attachmentLists: ReadonlyArray<ReadonlyArray<FileItem> | undefined>,
  cover: Partial<FileItem> | null | undefined,
  noCoverFile: boolean
): MediaFile[] {
  const out: MediaFile[] = []
  const seen = new Set<string>()
  for (const list of attachmentLists) {
    if (!Array.isArray(list)) {
      continue
    }
    for (const file of list) {
      if (!file || !file.path || seen.has(file.path)) {
        continue
      }
      seen.add(file.path)
      out.push({ file, isCover: false })
    }
  }
  if (!noCoverFile && cover?.path && !seen.has(cover.path)) {
    out.push({ file: cover as FileItem, isCover: true })
  }
  return out
}

/**
 * Quick-screen summary of a list item (no detail request): the number of
 * downloadable files and the set of kinds. Text is added to the kinds
 * whenever the text sidecar is enabled, because the list carries no content
 * and the full filter would see it for any post that has content.
 */
function summarizeListItem(item: {
  attachments?: FileItem[]
  file?: Partial<FileItem> | null
}): { fileCount: number; kinds: Set<KemonoFileKind> } {
  const media = collectMediaFiles(
    [item.attachments],
    item.file,
    settings.get('noCoverFile')
  )
  const kinds = new Set<KemonoFileKind>()
  for (const { file, isCover } of media) {
    kinds.add(kindOf(file, isCover))
  }
  if (settings.get('textContent') !== 'none') {
    kinds.add('text')
  }
  return { fileCount: media.length, kinds }
}

function baseName(file: FileItem): string {
  if (file.name) {
    return file.name
  }
  if (!file.path) {
    return 'file'
  }
  return file.path.split('/').pop() || 'file'
}

/** HTML 轉純文字（簡版：<br> 換行，去標籤，解常見實體） */
function toText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

/** 包一層最小 HTML（離線可讀） */
function toHTML(title: string, html: string): string {
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc}</title></head><body><h1>${esc}</h1>${html}</body></html>`
}

/** 展開一帖：附件 + 封面 + 文字檔。URL 在此一次算好 */
function expandPost(
  data: PostApiResponse,
  creatorName: string,
  host = location.host
): ExpandedPost {
  void creatorName
  if (!data || !data.post) {
    return { pending: false, files: [] }
  }
  const pending = isPendingPost(data.post)
  // 下載有自己的原圖開關，不能沿用預覽鍵（預設 false 會讓批量下載抓到縮圖）
  const original = settings.get('downloadOriginalImage')
  const files: ExpandedFile[] = []

  // 文字內容插最前面（pending 帖同樣提供完整文字，可保存）
  const textMode = settings.get('textContent')
  const title = typeof data.post.title === 'string' ? data.post.title : ''
  const content = typeof data.post.content === 'string' ? data.post.content : ''
  if (textMode !== 'none' && content) {
    const isTxt = textMode === 'txt'
    // 文字項與檔案項共用同一列表（不改資料結構）：kind==='text' 時
    // fileUrl 固定為空字串，內容只在 textData，下游必須先判 kind。
    const textFile: ExpandedFile = {
      kind: 'text',
      fileName: isTxt ? 'content.txt' : 'content.html',
      ext: isTxt ? 'txt' : 'html',
      fileUrl: '',
      previewOnly: false,
      textData: isTxt ? toText(content) : toHTML(title, content),
    }
    files.push(textFile)
  }

  const pushFile = (file: FileItem | null | undefined, isCover: boolean) => {
    // 畸形附件（缺 path）直接跳過，避免後續 split/URL 組裝崩潰
    if (!file || !file.path) {
      return
    }
    const name = baseName(file)
    const url = downloadUrl(file, original, host)
    if (!url) {
      return
    }
    files.push({
      kind: kindOf(file, isCover),
      fileName: name,
      // The display name may carry no extension while the stored path does
      ext: extensionOf(name) || extensionOf(file.path) || 'bin',
      fileUrl: url,
      previewOnly: file.preview_only === true,
      textData: '',
    })
  }

  // canonical 的附件在頂層、扁平回包在 post.attachments；兩邊都收，
  // 以 path 去重（同一檔案只算一次）；封面見 collectMediaFiles
  for (const { file, isCover } of collectMediaFiles(
    [data.post.attachments, data.attachments],
    data.post.file,
    settings.get('noCoverFile')
  )) {
    pushFile(file, isCover)
  }

  return { pending, files }
}

export { expandPost, collectMediaFiles, summarizeListItem }
