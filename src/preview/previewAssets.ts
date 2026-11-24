/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: Kemono-Downloader src/sites/kemono.ts (fullFile) +
 *               src/sites/pawchive.ts (fullFile) (Kemono-Downloader authors)
 * changes: merged the two families' URL rules into one helper behind
 *          isKemonoHost(). Kemono rule: images → img.{host} thumbnail
 *          (the original-file servers n1–n4.kemono.cr have been gone since
 *          October 2026), other files → none. Pawchive rule: preview_only
 *          → always thumbnail; non-image → file.; image → file./img. by
 *          the original-image switch. Callers pass their own flag:
 *          preview uses `previewOriginalImage`, downloads use
 *          `downloadOriginalImage` (see kemono/expand.ts). Also
 *          resolveDownloadUrl() upgrades stored thumbnail URLs at
 *          download time, and hasOriginalFiles() keeps crawling and
 *          downloading to Pawchive.
 */

import {
  fullFile as pawchiveFullFile,
  thumbnail,
} from '../kemono/assetsPawchive'
import { isImageFile } from '../kemono/fileType'
import { isKemonoService, postRegPath } from '../kemono/pages'
import type {
  FileItem,
  KemonoService,
  PostApiResponse,
} from '../kemono/apiTypes'

/** `patreon/12345/67890` → {service, creatorId, postId}；非法回 null */
function parsePostKey(postKey: string): {
  service: KemonoService
  creatorId: string
  postId: string
} | null {
  const parts = postKey.split('/')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null
  // 服務名走白名單，避免任意字串被當成站點服務
  if (!isKemonoService(parts[0])) return null
  return {
    service: parts[0],
    creatorId: parts[1],
    postId: parts[2],
  }
}

/** The Kemono domain still online */
const KEMONO_HOST = 'kemono.cr'
/** Former Kemono domains. They no longer resolve, but old caches, download
 * records and saved hosts still name them */
const RETIRED_KEMONO_HOSTS = ['kemono.su', 'kemono.party']

/** Exact match on the domain or a subdomain (so kemono.su.evil.com fails) */
function matchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().split(':')[0]
  return h === domain || h.endsWith(`.${domain}`)
}

/** 該 host 是否 Kemono 站（含已停用的舊網域；否則按 Pawchive 規則） */
function isKemonoHost(host = location.host): boolean {
  return [KEMONO_HOST, ...RETIRED_KEMONO_HOSTS].some((d) =>
    matchesDomain(host, d)
  )
}

/** A former Kemono domain that no longer resolves */
function isRetiredKemonoHost(host: string): boolean {
  return RETIRED_KEMONO_HOSTS.some((d) => matchesDomain(host, d))
}

/** Whether the site still serves original files. Kemono's original-file
 * servers (n1–n4.kemono.cr) have been unreachable since October 2026; only
 * its thumbnails, API and creator images still load. Crawling and
 * downloading need the originals, so they are Pawchive only */
function hasOriginalFiles(host = location.host): boolean {
  return !isKemonoHost(host)
}

/** 從卡片連結 href 解析 postKey（`patreon/12345/67890`）；非帖子連結回 null */
function parsePostKeyFromHref(href: string): string | null {
  let pathname: string
  try {
    // 只取 pathname，base 用 dummy（相對 href 照樣解析；node 測試環境無 location）
    pathname = new URL(href, 'https://preview.invalid').pathname
  } catch {
    return null
  }
  const m = pathname.match(postRegPath)
  if (!m) return null
  return `${m[1]}/${m[2]}/${m[3]}`
}

/** 封面縮圖（兩站同規則；post.file 可能沒有 path） */
function coverUrl(
  file: Partial<FileItem> | undefined,
  host = location.host
): string {
  if (!file?.path) return ''
  return `https://img.${host}/thumbnail/data${file.path}`
}

/** 去重合併 post.file＋attachments（保持原順序） */
function allFiles(data: PostApiResponse): FileItem[] {
  const list: FileItem[] = []
  const push = (f: FileItem | Partial<FileItem> | undefined) => {
    if (f?.path && !list.some((x) => x.path === f.path)) {
      list.push(f as FileItem)
    }
  }
  push(data.post.file)
  for (const a of data.post.attachments ?? []) push(a)
  for (const a of data.attachments ?? []) push(a)
  return list
}

/** 可在 <img> 顯示的圖片附件 */
function imageFiles(data: PostApiResponse): FileItem[] {
  return allFiles(data).filter((f) => isImageFile(f))
}

/** 單張圖片的顯示 URL（'' 表示無法顯示，如 Kemono 非圖片附件）。
 * Kemono only has thumbnails left, so `original` is ignored there */
function imageUrl(
  file: FileItem,
  original: boolean,
  host = location.host
): string {
  if (isKemonoHost(host)) {
    return isImageFile(file) ? thumbnail(file.path, host) : ''
  }
  return pawchiveFullFile(file, original, host)
}

/** 可下載附件（含非圖片；順序同 allFiles） */
function downloadableFiles(data: PostApiResponse): FileItem[] {
  return allFiles(data)
}

/** 單個附件的下載 URL（Kemono 同 imageUrl：只剩縮圖，非圖片為 ''） */
function downloadUrl(
  file: FileItem,
  original: boolean,
  host = location.host
): string {
  return imageUrl(file, original, host)
}

/** 縮圖網址：`https://img.{host}/thumbnail/data{path}` */
const THUMB_RE = /^https:\/\/img\.([^/]+)\/thumbnail\/data(\/.*)$/

/** 把已存的縮圖網址換回原圖網址。
 * 舊抓取結果／快取是在「預設縮圖」時算好的，下載時才依設定補救；
 * previewOnly 的檔案站方只給縮圖，不能換；非縮圖網址原樣返回；
 * Kemono 的原檔伺服器已停用，縮圖照舊。
 * 站點從網址本身取，不看目前分頁：在 Kemono 分頁下載 Pawchive 的快取
 * （下載佇列常見）也要換成 Pawchive 的原圖網址。 */
function resolveDownloadUrl(
  result: { fileUrl: string; previewOnly: boolean },
  original: boolean
): string {
  const url = result.fileUrl
  if (!original || result.previewOnly) return url
  const m = url.match(THUMB_RE)
  if (!m) return url
  const [, host, path] = m
  if (isKemonoHost(host)) return url
  return `https://file.${host}/data${path}`
}

export {
  isKemonoHost,
  isRetiredKemonoHost,
  hasOriginalFiles,
  parsePostKey,
  parsePostKeyFromHref,
  coverUrl,
  allFiles,
  imageFiles,
  imageUrl,
  downloadableFiles,
  downloadUrl,
  resolveDownloadUrl,
}
