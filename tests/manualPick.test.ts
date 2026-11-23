import { beforeEach, describe, expect, it, vi } from 'vitest'

const { crawlIds } = vi.hoisted(() => ({ crawlIds: vi.fn() }))
vi.mock('../src/crawl/engine', () => ({ engine: { crawlIds } }))
vi.mock('../src/Toast', () => ({
  toast: { show: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

import { EVT } from '../src/EVT'
import {
  isPlainLeftClick,
  manualPick,
  PickSelection,
} from '../src/crawl/ManualPick'
import { states } from '../src/store/States'
import { toast } from '../src/Toast'

describe('PickSelection', () => {
  it('toggles a post in and out, keeping pick order', () => {
    const s = new PickSelection()
    expect(s.toggle('patreon/1/10')).toBe(true)
    expect(s.toggle('patreon/1/20')).toBe(true)
    expect(s.toggle('fanbox/2/30')).toBe(true)
    expect(s.list()).toEqual(['patreon/1/10', 'patreon/1/20', 'fanbox/2/30'])
    expect(s.toggle('patreon/1/20')).toBe(false)
    expect(s.has('patreon/1/20')).toBe(false)
    expect(s.list()).toEqual(['patreon/1/10', 'fanbox/2/30'])
    expect(s.size).toBe(2)
  })

  it('remove drops only the given posts; clear drops all', () => {
    const s = new PickSelection()
    s.toggle('a/1/1')
    s.toggle('a/1/2')
    s.toggle('a/1/3')
    s.remove(['a/1/1', 'a/1/3', 'a/1/9'])
    expect(s.list()).toEqual(['a/1/2'])
    s.clear()
    expect(s.size).toBe(0)
  })

  it('list returns a copy', () => {
    const s = new PickSelection()
    s.toggle('a/1/1')
    s.list().push('x')
    expect(s.list()).toEqual(['a/1/1'])
  })
})

describe('isPlainLeftClick', () => {
  const click = (over: Partial<Parameters<typeof isPlainLeftClick>[0]>) => ({
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ...over,
  })

  it('takes a plain left click', () => {
    expect(isPlainLeftClick(click({}))).toBe(true)
  })

  it('leaves new-tab, new-window and download clicks alone', () => {
    expect(isPlainLeftClick(click({ button: 1 }))).toBe(false)
    expect(isPlainLeftClick(click({ button: 2 }))).toBe(false)
    expect(isPlainLeftClick(click({ ctrlKey: true }))).toBe(false)
    expect(isPlainLeftClick(click({ metaKey: true }))).toBe(false)
    expect(isPlainLeftClick(click({ shiftKey: true }))).toBe(false)
    expect(isPlainLeftClick(click({ altKey: true }))).toBe(false)
  })
})

describe('manualPick.save', () => {
  // The selection is private; pick through the same path a click uses
  const pick = (...keys: string[]) => {
    const sel = (manualPick as unknown as { selection: PickSelection })
      .selection
    sel.clear()
    for (const k of keys) sel.toggle(k)
  }
  const picked = () =>
    (manualPick as unknown as { selection: PickSelection }).selection.list()

  beforeEach(() => {
    crawlIds.mockReset()
    vi.mocked(toast.warning).mockClear()
    // mark() walks the page; the node test environment has no cards
    ;(globalThis as any).document.querySelectorAll = () => []
    states.busy = false
    states.downloading = false
    states.stopCrawl = false
  })

  it('crawls the picked posts with picked and unpicks them afterwards', async () => {
    pick('patreon/1/10', 'patreon/1/20')
    crawlIds.mockImplementation(async () => {
      EVT.fire('crawlStart')
      return ['patreon/1/10', 'patreon/1/20']
    })
    await manualPick.save()
    expect(crawlIds).toHaveBeenCalledWith(
      [
        { id: 'patreon/1/10', type: 'post' },
        { id: 'patreon/1/20', type: 'post' },
      ],
      { picked: true }
    )
    expect(picked()).toEqual([])
  })

  it('unpicks only the posts that were added; failed ones stay picked', async () => {
    pick('patreon/1/10', 'patreon/1/20', 'patreon/1/30')
    crawlIds.mockImplementation(async () => {
      EVT.fire('crawlStart')
      return ['patreon/1/10', 'patreon/1/30']
    })
    await manualPick.save()
    expect(picked()).toEqual(['patreon/1/20'])
  })

  it('keeps the picks when the crawl was stopped', async () => {
    pick('patreon/1/10')
    crawlIds.mockImplementation(async () => {
      EVT.fire('crawlStart')
      states.stopCrawl = true
    })
    await manualPick.save()
    expect(picked()).toEqual(['patreon/1/10'])
  })

  it('keeps the picks when the crawl never started', async () => {
    pick('patreon/1/10')
    crawlIds.mockResolvedValue([])
    await manualPick.save()
    expect(picked()).toEqual(['patreon/1/10'])
  })

  it('does not start while busy and keeps the picks', async () => {
    pick('patreon/1/10')
    states.busy = true
    await manualPick.save()
    expect(crawlIds).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalled()
    expect(picked()).toEqual(['patreon/1/10'])
    expect(manualPick.canSave).toBe(false)
  })

  it('nothing picked: does nothing', async () => {
    pick()
    await manualPick.save()
    expect(crawlIds).not.toHaveBeenCalled()
    expect(manualPick.canSave).toBe(false)
  })
})
