import { describe, expect, it } from 'vitest'
import { MAX_PREVIEWS } from '../src/watch/labels'
import type { WatchCover } from '../src/watch/watchTypes'
import {
  appendPreviews,
  movePreview,
  placePreviewPanel,
  previewGridColumns,
  removePreview,
  removedUploadIds,
  togglePreviewItem,
} from '../src/watchpage/cardPreview'

describe('previewGridColumns', () => {
  it('returns 1 for <=1, 2 for 2..4, and 3 for 5..6+', () => {
    expect(previewGridColumns(0)).toBe(1)
    expect(previewGridColumns(1)).toBe(1)
    expect(previewGridColumns(2)).toBe(2)
    expect(previewGridColumns(3)).toBe(2)
    expect(previewGridColumns(4)).toBe(2)
    expect(previewGridColumns(5)).toBe(3)
    expect(previewGridColumns(6)).toBe(3)
    expect(previewGridColumns(9)).toBe(3)
  })
})

describe('placePreviewPanel', () => {
  const viewport = { width: 1200, height: 800 }
  const panel = { width: 320, height: 240 }

  it('places on the right when there is room', () => {
    const anchor = {
      left: 100,
      top: 120,
      right: 360,
      bottom: 320,
      width: 260,
      height: 200,
    }
    const res = placePreviewPanel(anchor, panel, viewport, 10, 8)
    expect(res).toEqual({ left: 370, top: 120, placement: 'right' })
  })

  it('clamps top within viewport margins when anchor is near bottom', () => {
    const anchor = {
      left: 100,
      top: 680,
      right: 360,
      bottom: 780,
      width: 260,
      height: 100,
    }
    const res = placePreviewPanel(anchor, panel, viewport, 10, 8)
    expect(res.placement).toBe('right')
    expect(res.left).toBe(370)
    expect(res.top).toBe(800 - 8 - 240)
  })

  it('flips to the left when there is no room on the right', () => {
    const anchor = {
      left: 900,
      top: 150,
      right: 1160,
      bottom: 350,
      width: 260,
      height: 200,
    }
    const res = placePreviewPanel(anchor, panel, viewport, 10, 8)
    expect(res).toEqual({
      left: 900 - 10 - 320,
      top: 150,
      placement: 'left',
    })
  })

  it('places below when neither right nor left has room', () => {
    const narrowViewport = { width: 500, height: 800 }
    const anchor = {
      left: 100,
      top: 100,
      right: 400,
      bottom: 260,
      width: 300,
      height: 160,
    }
    const res = placePreviewPanel(anchor, panel, narrowViewport, 10, 8)
    expect(res).toEqual({ left: 100, top: 270, placement: 'below' })
  })

  it('places above when right, left, and below do not fit', () => {
    const narrowViewport = { width: 500, height: 700 }
    const anchor = {
      left: 100,
      top: 480,
      right: 400,
      bottom: 640,
      width: 300,
      height: 160,
    }
    const res = placePreviewPanel(anchor, panel, narrowViewport, 10, 8)
    expect(res).toEqual({
      left: 100,
      top: 480 - 10 - 240,
      placement: 'above',
    })
  })

  it('never places panel off-screen even in a cramped viewport', () => {
    const smallViewport = { width: 375, height: 300 }
    const anchor = {
      left: 20,
      top: 40,
      right: 355,
      bottom: 260,
      width: 335,
      height: 220,
    }
    const res = placePreviewPanel(anchor, panel, smallViewport, 10, 8)
    expect(res.left).toBeGreaterThanOrEqual(8)
    expect(res.left + panel.width).toBeLessThanOrEqual(smallViewport.width - 8)
    expect(res.top).toBeGreaterThanOrEqual(8)
    expect(res.top + panel.height).toBeLessThanOrEqual(smallViewport.height - 8)
  })
})

describe('preview list edits', () => {
  const p1: WatchCover = { kind: 'post', path: '/aa/bb/1.jpg' }
  const p2: WatchCover = { kind: 'post', path: '/aa/bb/2.jpg' }
  const u1: WatchCover = { kind: 'upload', id: 'c_1' }
  const u2: WatchCover = { kind: 'upload', id: 'c_2' }

  it('movePreview reorders items without mutating the original list', () => {
    const list = [p1, p2, u1]
    expect(movePreview(list, 0, 2)).toEqual([p2, u1, p1])
    expect(movePreview(list, 2, 0)).toEqual([u1, p1, p2])
    expect(movePreview(list, 1, 1)).toEqual(list)
    expect(movePreview(list, -1, 1)).toEqual(list)
    expect(movePreview(list, 0, 99)).toEqual(list)
    expect(list).toEqual([p1, p2, u1])
  })

  it('removePreview deletes the item at index and ignores out-of-bounds', () => {
    const list = [p1, p2, u1]
    expect(removePreview(list, 1)).toEqual([p1, u1])
    expect(removePreview(list, 0)).toEqual([p2, u1])
    expect(removePreview(list, -1)).toEqual(list)
    expect(removePreview(list, 5)).toEqual(list)
  })

  it('togglePreviewItem preserves selection order, removes existing, and caps at max', () => {
    let list: WatchCover[] = []
    list = togglePreviewItem(list, p2)
    list = togglePreviewItem(list, u1)
    list = togglePreviewItem(list, p1)
    expect(list).toEqual([p2, u1, p1])

    // Deselect middle item
    list = togglePreviewItem(list, u1)
    expect(list).toEqual([p2, p1])

    // Cap enforcement
    const capped = togglePreviewItem([p1, p2], u1, 2)
    expect(capped).toEqual([p1, p2])

    // Still allows deselecting when at cap
    const deselected = togglePreviewItem([p1, p2], p1, 2)
    expect(deselected).toEqual([p2])
  })

  it('appendPreviews deduplicates and caps at MAX_PREVIEWS', () => {
    const items: WatchCover[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'post',
      path: `/aa/bb/${i}.jpg`,
    }))
    const res = appendPreviews([items[0], items[1]], [items[1], ...items])
    expect(res).toHaveLength(MAX_PREVIEWS)
    expect(res.map((x) => (x.kind === 'post' ? x.path : x.id))).toEqual([
      '/aa/bb/0.jpg',
      '/aa/bb/1.jpg',
      '/aa/bb/2.jpg',
      '/aa/bb/3.jpg',
      '/aa/bb/4.jpg',
      '/aa/bb/5.jpg',
    ])
  })

  it('removedUploadIds returns only removed uploads not used as activeCover', () => {
    const prev = [p1, u1, u2]
    const next = [p1, p2]
    expect(removedUploadIds(prev, next)).toEqual(['c_1', 'c_2'])
    expect(removedUploadIds(prev, next, u1)).toEqual(['c_2'])
    expect(removedUploadIds(prev, [u2], u1)).toEqual([])
    expect(removedUploadIds(undefined, next)).toEqual([])
  })
})
