/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Pure helpers for watchlist creator keys, site detection, and URLs. */

import type { KemonoService } from '../kemono/apiTypes'
import { isKemonoService } from '../kemono/pages'
import { isKemonoHost } from '../preview/previewAssets'
import { WATCH_SITES, type WatchSite } from './watchTypes'

export const DEFAULT_HOSTS: Record<WatchSite, string> = {
  pawchive: 'pawchive.pw',
  kemono: 'kemono.cr',
}

export function siteOfHost(host: string): WatchSite | null {
  if (!host) return null
  if (isKemonoHost(host)) return 'kemono'
  const h = host.toLowerCase().split(':')[0]
  if (h === 'pawchive.pw' || h.endsWith('.pawchive.pw')) return 'pawchive'
  return null
}

export function makeCreatorKey(
  site: WatchSite,
  service: KemonoService,
  creatorId: string
): string {
  if (
    !WATCH_SITES.includes(site) ||
    !isKemonoService(service) ||
    !creatorId ||
    creatorId.includes('/')
  ) {
    throw new Error('invalid creator key parts')
  }
  return `${site}/${service}/${creatorId}`
}

export function parseCreatorKey(key: string): {
  site: WatchSite
  service: KemonoService
  creatorId: string
} | null {
  const parts = key.split('/')
  if (parts.length !== 3) return null
  const [site, service, creatorId] = parts
  if (
    !WATCH_SITES.includes(site as WatchSite) ||
    !isKemonoService(service) ||
    !creatorId
  ) {
    return null
  }
  return {
    site: site as WatchSite,
    service,
    creatorId,
  }
}

export function creatorPageUrl(
  host: string,
  service: KemonoService,
  creatorId: string
): string {
  return `https://${host}/${service}/user/${creatorId}`
}

export function postPageUrl(
  host: string,
  service: KemonoService,
  creatorId: string,
  postId: string
): string {
  return `https://${host}/${service}/user/${creatorId}/post/${postId}`
}

/** Pawchive serves icons and banners from the main host; Kemono from img.<host>. */
function mediaOrigin(host: string): string {
  return siteOfHost(host) === 'pawchive'
    ? `https://${host}`
    : `https://img.${host}`
}

export function avatarUrl(
  host: string,
  service: KemonoService,
  creatorId: string
): string {
  return `${mediaOrigin(host)}/icons/${service}/${creatorId}`
}

export function bannerUrl(
  host: string,
  service: KemonoService,
  creatorId: string
): string {
  return `${mediaOrigin(host)}/banners/${service}/${creatorId}`
}

export function thumbUrl(host: string, path: string): string {
  if (!path) return ''
  return `https://img.${host}/thumbnail/data${path}`
}
