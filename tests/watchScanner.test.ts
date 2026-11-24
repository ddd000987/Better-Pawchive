/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/* Unit tests for watchlist scanner, batching, error handling, and cross-tab locks. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiHttpError } from '../src/kemono/api'
import type { PostsApiResponse } from '../src/kemono/apiTypes'
import {
  acquireScanLock,
  pickScanOrder,
  releaseScanLock,
  renewScanLock,
  runScan,
  SCAN_STATE_PREFIX,
  shouldAutoScan,
  type ScanDeps,
} from '../src/watch/scanner'
import type { WatchedCreator } from '../src/watch/watchTypes'

function makeCreator(
  id: string,
  opts: {
    enabled?: boolean
    lastCheckedAt?: number
    baselinePublished?: string
    seenIds?: string[]
  } = {}
): WatchedCreator {
  const c: WatchedCreator = {
    key: `pawchive/patreon/${id}`,
    site: 'pawchive',
    service: 'patreon',
    creatorId: id,
    name: `Creator ${id}`,
    folderId: 'unsorted',
    addedAt: 1000,
  }
  if (opts.enabled !== undefined) {
    c.tracking = {
      enabled: opts.enabled,
      since: 1000,
      baselinePublished: opts.baselinePublished ?? '2025-01-01T00:00:00',
      seenIds: opts.seenIds ?? ['old'],
      unread: [],
      ...(opts.lastCheckedAt !== undefined
        ? { lastCheckedAt: opts.lastCheckedAt }
        : {}),
    }
  }
  return c
}

function setupStorage() {
  const mem: Record<string, unknown> = {}
  const get = vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {}))
  const set = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(mem, obj)
  })
  const g = globalThis as unknown as {
    chrome: { storage: { local: { get: typeof get; set: typeof set } } }
  }
  g.chrome = {
    ...(g.chrome ?? {}),
    storage: {
      ...(g.chrome?.storage ?? {}),
      local: { get, set },
    },
  }
  return { mem, get, set }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pickScanOrder', () => {
  it('keeps only tracking.enabled creators with never-checked first, then lastCheckedAt ascending', () => {
    const creators = [
      makeCreator('disabled', { enabled: false }),
      makeCreator('untracked'),
      makeCreator('c3', { enabled: true, lastCheckedAt: 300 }),
      makeCreator('never1', { enabled: true }),
      makeCreator('c1', { enabled: true, lastCheckedAt: 100 }),
      makeCreator('never2', { enabled: true }),
      makeCreator('c2', { enabled: true, lastCheckedAt: 200 }),
    ]
    const ordered = pickScanOrder(creators)
    expect(ordered.map((c) => c.creatorId)).toEqual([
      'never1',
      'never2',
      'c1',
      'c2',
      'c3',
    ])
  })
})

describe('runScan', () => {
  it('batches apply calls (25 creators, batchSize 10 -> 3 calls) and reports progress', async () => {
    const creators = Array.from({ length: 25 }, (_, i) =>
      makeCreator(`c${i}`, { enabled: true, lastCheckedAt: i })
    )
    const batchSizes: number[] = []
    const progress: Array<[number, number]> = []
    const deps: ScanDeps = {
      fetchPosts: vi.fn(async () => [] as PostsApiResponse),
      saveSnapshot: vi.fn(async () => {}),
      apply: vi.fn(async (results) => {
        batchSizes.push(results.length)
        return []
      }),
    }

    const res = await runScan(creators, deps, {
      signal: new AbortController().signal,
      batchSize: 10,
      onProgress: (done, total) => progress.push([done, total]),
    })

    expect(batchSizes).toEqual([10, 10, 5])
    expect(deps.apply).toHaveBeenCalledTimes(3)
    expect(res).toEqual({
      checked: 25,
      failed: 0,
      added: [],
      creatorsWithNew: 0,
    })
    expect(progress[0]).toEqual([1, 25])
    expect(progress[progress.length - 1]).toEqual([25, 25])
  })

  it('stops on 429 rateLimit and still applies finished results', async () => {
    const creators = [
      makeCreator('c1', { enabled: true, lastCheckedAt: 1 }),
      makeCreator('c2', { enabled: true, lastCheckedAt: 2 }),
      makeCreator('c3', { enabled: true, lastCheckedAt: 3 }),
    ]
    const appliedKeys: string[] = []
    const deps: ScanDeps = {
      fetchPosts: vi.fn(
        async (c: WatchedCreator): Promise<PostsApiResponse> => {
          if (c.creatorId === 'c2') {
            throw new ApiHttpError(429, 'https://example/posts', 'HTTP 429')
          }
          return [
            {
              id: 'new1',
              user: c.creatorId,
              service: 'patreon',
              title: 'New',
              published: '2025-02-01T00:00:00',
              file: {},
              attachments: [],
            },
          ]
        }
      ),
      saveSnapshot: vi.fn(async () => {}),
      apply: vi.fn(async (results) => {
        appliedKeys.push(...results.map((r: { key: string }) => r.key))
        return [
          {
            id: 'new1',
            title: 'New',
            published: '2025-02-01T00:00:00',
            key: 'pawchive/patreon/c1',
          },
        ]
      }),
    }

    const res = await runScan(creators, deps, {
      signal: new AbortController().signal,
      batchSize: 10,
    })

    expect(res.stoppedBy).toBe('rateLimit')
    expect(res.checked).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.creatorsWithNew).toBe(1)
    expect(res.added).toHaveLength(1)
    expect(appliedKeys).toEqual(['pawchive/patreon/c1'])
  })

  it('maps 404 to "not found", ignores saveSnapshot failures, and continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const creators = [
      makeCreator('c1', { enabled: true, lastCheckedAt: 1 }),
      makeCreator('c2', { enabled: true, lastCheckedAt: 2 }),
    ]
    const applied: Array<{ key: string; error?: string }> = []
    const deps: ScanDeps = {
      fetchPosts: vi.fn(async (c) => {
        if (c.creatorId === 'c1') {
          throw new ApiHttpError(404, 'https://example/posts', 'HTTP 404')
        }
        return []
      }),
      saveSnapshot: vi.fn(async () => {
        throw new Error('quota')
      }),
      apply: vi.fn(async (results) => {
        applied.push(...results)
        return []
      }),
    }

    const res = await runScan(creators, deps, {
      signal: new AbortController().signal,
    })

    expect(res.checked).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.stoppedBy).toBeUndefined()
    expect(applied[0]).toEqual({
      key: 'pawchive/patreon/c1',
      error: 'not found',
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stops on abort and applies already-fetched creators', async () => {
    const controller = new AbortController()
    const creators = [
      makeCreator('c1', { enabled: true, lastCheckedAt: 1 }),
      makeCreator('c2', { enabled: true, lastCheckedAt: 2 }),
    ]
    const applied: string[] = []
    const deps: ScanDeps = {
      fetchPosts: vi.fn(async (c) => {
        if (c.creatorId === 'c2') {
          controller.abort()
          const err = new Error('aborted')
          err.name = 'AbortError'
          throw err
        }
        return []
      }),
      saveSnapshot: vi.fn(async () => {}),
      apply: vi.fn(async (results) => {
        applied.push(...results.map((r: { key: string }) => r.key))
        return []
      }),
    }

    const res = await runScan(creators, deps, {
      signal: controller.signal,
    })

    expect(res.stoppedBy).toBe('abort')
    expect(res.checked).toBe(1)
    expect(applied).toEqual(['pawchive/patreon/c1'])
  })

  it('waits while isBusy() returns true, polling every 2 s', async () => {
    vi.useFakeTimers()
    const creators = [makeCreator('c1', { enabled: true })]
    let busy = true
    const deps: ScanDeps = {
      fetchPosts: vi.fn(async () => []),
      saveSnapshot: vi.fn(async () => {}),
      apply: vi.fn(async () => []),
      isBusy: () => busy,
    }

    const promise = runScan(creators, deps, {
      signal: new AbortController().signal,
    })

    await vi.advanceTimersByTimeAsync(1999)
    expect(deps.fetchPosts).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(deps.fetchPosts).not.toHaveBeenCalled()

    busy = false
    await vi.advanceTimersByTimeAsync(2000)
    const res = await promise
    expect(deps.fetchPosts).toHaveBeenCalledTimes(1)
    expect(res.checked).toBe(1)
  })
})

describe('scan lock and shouldAutoScan', () => {
  it('acquires, refuses second owner, takes over expired lock, and updates lastScanAt only when finished', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { mem } = setupStorage()

    expect(await shouldAutoScan('pawchive', 60_000)).toBe(true)

    // Owner A acquires lock
    expect(await acquireScanLock('pawchive', 'ownerA', 10_000)).toBe(true)
    expect(await shouldAutoScan('pawchive', 60_000)).toBe(false)

    // Owner B is refused while lock is live
    expect(await acquireScanLock('pawchive', 'ownerB', 10_000)).toBe(false)

    // Renew extends lock
    vi.advanceTimersByTime(8_000)
    await renewScanLock('pawchive', 'ownerA', 10_000)
    vi.advanceTimersByTime(5_000)
    expect(await acquireScanLock('pawchive', 'ownerB', 10_000)).toBe(false)

    // Expire lock -> Owner B takes over
    vi.advanceTimersByTime(6_000)
    expect(await acquireScanLock('pawchive', 'ownerB', 10_000)).toBe(true)

    // Release with finished=false clears lock but does NOT set lastScanAt
    await releaseScanLock('pawchive', 'ownerB', false)
    const afterAbort = mem[SCAN_STATE_PREFIX + 'pawchive'] as {
      lastScanAt: number
      owner?: string
    }
    expect(afterAbort.owner).toBeUndefined()
    expect(afterAbort.lastScanAt).toBe(0)
    expect(await shouldAutoScan('pawchive', 60_000)).toBe(true)

    // Acquire and release with finished=true sets lastScanAt
    expect(await acquireScanLock('pawchive', 'ownerC', 10_000)).toBe(true)
    const finishTime = Date.now()
    await releaseScanLock('pawchive', 'ownerC', true)
    const afterFinish = mem[SCAN_STATE_PREFIX + 'pawchive'] as {
      lastScanAt: number
      owner?: string
    }
    expect(afterFinish.owner).toBeUndefined()
    expect(afterFinish.lastScanAt).toBe(finishTime)

    // Too soon -> shouldAutoScan false; after interval -> true
    expect(await shouldAutoScan('pawchive', 60_000, finishTime + 30_000)).toBe(
      false
    )
    expect(await shouldAutoScan('pawchive', 60_000, finishTime + 60_000)).toBe(
      true
    )
  })
})
