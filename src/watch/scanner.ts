/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Creator tracking scanner with batching, abort/rate-limit handling, and cross-tab auto-scan lock. */

import { api, ApiHttpError } from '../kemono/api'
import type { PostsApiResponse } from '../kemono/apiTypes'
import { states } from '../store/States'
import { snapshotFromPosts, snapshots } from './snapshot'
import { watchStore } from './watchStore'
import type { AddedPost, WatchSite, WatchedCreator } from './watchTypes'

export const SCAN_STATE_PREFIX = 'pawchiveProWatchScan:'
const BUSY_POLL_MS = 2000
const LOCK_RENEW_MS = 30000

export interface ScanDeps {
  fetchPosts(c: WatchedCreator, signal: AbortSignal): Promise<PostsApiResponse>
  saveSnapshot(key: string, items: PostsApiResponse): Promise<void>
  apply(
    results: Array<{ key: string; items?: PostsApiResponse; error?: string }>
  ): Promise<AddedPost[]>
  isBusy?(): boolean
}

export interface ScanResult {
  checked: number
  failed: number
  added: AddedPost[]
  /** Distinct creators among `added` */
  creatorsWithNew: number
  stoppedBy?: 'abort' | 'rateLimit'
}

interface ScanState {
  lastScanAt: number
  owner?: string
  lockUntil?: number
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { name?: unknown }).name === 'AbortError'
}

function waitMs(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function pickScanOrder(creators: WatchedCreator[]): WatchedCreator[] {
  return creators
    .filter((c) => c.tracking?.enabled === true)
    .sort((a, b) => {
      const ta = a.tracking?.lastCheckedAt
      const tb = b.tracking?.lastCheckedAt
      if (ta === undefined && tb === undefined) return 0
      if (ta === undefined) return -1
      if (tb === undefined) return 1
      return ta - tb
    })
}

export async function runScan(
  creators: WatchedCreator[],
  deps: ScanDeps,
  opts: {
    signal: AbortSignal
    onProgress?(done: number, total: number): void
    batchSize?: number
  }
): Promise<ScanResult> {
  const queue = pickScanOrder(creators)
  const total = queue.length
  const batchSize = Math.max(1, opts.batchSize ?? 10)

  let checked = 0
  let failed = 0
  const added: AddedPost[] = []
  let stoppedBy: 'abort' | 'rateLimit' | undefined

  let batch: Array<{ key: string; items?: PostsApiResponse; error?: string }> =
    []

  const flushBatch = async () => {
    if (batch.length === 0) return
    const toApply = batch
    batch = []
    added.push(...(await deps.apply(toApply)))
  }

  for (const creator of queue) {
    if (opts.signal.aborted) {
      stoppedBy = 'abort'
      break
    }

    while (deps.isBusy?.()) {
      const waited = await waitMs(BUSY_POLL_MS, opts.signal)
      if (!waited || opts.signal.aborted) {
        stoppedBy = 'abort'
        break
      }
    }
    if (stoppedBy) break

    try {
      const items = await deps.fetchPosts(creator, opts.signal)
      try {
        await deps.saveSnapshot(creator.key, items)
      } catch (e) {
        console.warn('[Better Pawchive] saveSnapshot failed', creator.key, e)
      }
      batch.push({ key: creator.key, items })
      checked++
    } catch (err) {
      if (opts.signal.aborted || isAbortError(err)) {
        stoppedBy = 'abort'
        break
      }
      if (err instanceof ApiHttpError && err.status === 429) {
        stoppedBy = 'rateLimit'
        break
      }
      const message =
        err instanceof ApiHttpError && err.status === 404
          ? 'not found'
          : err instanceof Error
            ? err.message
            : String(err)
      batch.push({ key: creator.key, error: message })
      failed++
      checked++
    }

    opts.onProgress?.(checked, total)
    if (batch.length >= batchSize) {
      await flushBatch()
    }
  }

  await flushBatch()

  const result: ScanResult = {
    checked,
    failed,
    added,
    creatorsWithNew: new Set(added.map((p) => p.key)).size,
  }
  if (stoppedBy) result.stoppedBy = stoppedBy
  return result
}

async function readScanState(site: WatchSite): Promise<ScanState> {
  const key = SCAN_STATE_PREFIX + site
  const raw = await chrome.storage.local.get(key)
  const val = raw?.[key]
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return { lastScanAt: 0 }
  }
  const rec = val as Record<string, unknown>
  const state: ScanState = {
    lastScanAt:
      typeof rec.lastScanAt === 'number' && Number.isFinite(rec.lastScanAt)
        ? rec.lastScanAt
        : 0,
  }
  if (typeof rec.owner === 'string' && rec.owner) {
    state.owner = rec.owner
  }
  if (typeof rec.lockUntil === 'number' && Number.isFinite(rec.lockUntil)) {
    state.lockUntil = rec.lockUntil
  }
  return state
}

async function writeScanState(
  site: WatchSite,
  state: ScanState
): Promise<void> {
  await chrome.storage.local.set({ [SCAN_STATE_PREFIX + site]: state })
}

export async function shouldAutoScan(
  site: WatchSite,
  intervalMs: number,
  now = Date.now()
): Promise<boolean> {
  const state = await readScanState(site)
  if (state.owner && state.lockUntil !== undefined && state.lockUntil > now) {
    return false
  }
  if (state.lastScanAt === 0) return true
  return now - state.lastScanAt >= intervalMs
}

export async function acquireScanLock(
  site: WatchSite,
  owner: string,
  ttlMs = 120000
): Promise<boolean> {
  const now = Date.now()
  const state = await readScanState(site)
  if (
    state.owner &&
    state.owner !== owner &&
    state.lockUntil !== undefined &&
    state.lockUntil > now
  ) {
    return false
  }
  await writeScanState(site, {
    lastScanAt: state.lastScanAt,
    owner,
    lockUntil: now + ttlMs,
  })
  const verified = await readScanState(site)
  return verified.owner === owner
}

export async function renewScanLock(
  site: WatchSite,
  owner: string,
  ttlMs = 120000
): Promise<void> {
  const state = await readScanState(site)
  if (state.owner !== owner) return
  await writeScanState(site, {
    lastScanAt: state.lastScanAt,
    owner,
    lockUntil: Date.now() + ttlMs,
  })
}

export async function releaseScanLock(
  site: WatchSite,
  owner: string,
  finished: boolean
): Promise<void> {
  const state = await readScanState(site)
  if (state.owner && state.owner !== owner) return
  await writeScanState(site, {
    lastScanAt: finished ? Date.now() : state.lastScanAt,
  })
}

export async function autoScan(opts: {
  site: WatchSite
  host: string
  intervalMs: number
  signal: AbortSignal
  onDone(result: ScanResult): void
}): Promise<void> {
  if (opts.signal.aborted) return
  if (!(await shouldAutoScan(opts.site, opts.intervalMs))) return

  const owner =
    Math.random().toString(36).slice(2) + '-' + Date.now().toString(36)
  if (!(await acquireScanLock(opts.site, owner))) return

  const renewTimer = setInterval(() => {
    renewScanLock(opts.site, owner).catch(() => {})
  }, LOCK_RENEW_MS)

  let finished = false
  let result: ScanResult | undefined
  try {
    await watchStore.ready()
    const creators = Object.values(watchStore.data.creators).filter(
      (c) => c.site === opts.site
    )
    result = await runScan(
      creators,
      {
        fetchPosts: async (c, signal) => {
          const res = await api.posts(
            {
              service: c.service,
              creatorId: c.creatorId,
              host: opts.host,
            },
            signal
          )
          if (api.isErrorResponse(res)) {
            throw new Error(res.error)
          }
          return res
        },
        saveSnapshot: (key, items) =>
          snapshots.set(snapshotFromPosts(key, items)),
        apply: (results) => watchStore.applyCheckResults(results),
        isBusy: () => states.busy || states.downloading,
      },
      { signal: opts.signal }
    )
    finished = !result.stoppedBy
  } finally {
    clearInterval(renewTimer)
    await releaseScanLock(opts.site, owner, finished).catch(() => {})
  }

  if (result && result.checked > 0) {
    opts.onDone(result)
  }
}
