import { describe, expect, it } from 'vitest'
import { downloadName } from '../src/watchpage/imageContextMenu'
import { fitPreviewBox } from '../src/watchpage/hoverPreview'

const viewport = { width: 1600, height: 900 }

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }
}

describe('fitPreviewBox', () => {
  it('keeps the aspect ratio and stays inside the window', () => {
    for (const aspect of [0.5, 1, 1.78, 3]) {
      for (const anchor of [
        rect(10, 10, 200, 200),
        rect(1390, 690, 200, 200),
        rect(700, 350, 200, 200),
      ]) {
        const box = fitPreviewBox(anchor, aspect, viewport)
        expect(box.width / box.height).toBeCloseTo(aspect, 1)
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.top).toBeGreaterThanOrEqual(0)
        expect(box.left + box.width).toBeLessThanOrEqual(viewport.width)
        expect(box.top + box.height).toBeLessThanOrEqual(viewport.height)
      }
    }
  })

  it('puts a tall image beside a tile on the left edge, not over it', () => {
    const anchor = rect(20, 300, 200, 200)
    const box = fitPreviewBox(anchor, 0.7, viewport)
    expect(box.left).toBeGreaterThanOrEqual(anchor.right)
    // Uses the full height of the window
    expect(box.height).toBe(viewport.height - 16)
  })

  it('flips to the left of a tile on the right edge', () => {
    const anchor = rect(1380, 300, 200, 200)
    const box = fitPreviewBox(anchor, 0.7, viewport)
    expect(box.left + box.width).toBeLessThanOrEqual(anchor.left)
  })

  it('puts a wide image above or below when the sides are too narrow', () => {
    const narrow = { width: 700, height: 1000 }
    const anchor = rect(250, 50, 200, 200)
    const box = fitPreviewBox(anchor, 2, narrow)
    expect(box.top).toBeGreaterThanOrEqual(anchor.bottom)
  })

  it('centres over the tile when no side has room', () => {
    const small = { width: 400, height: 400 }
    const box = fitPreviewBox(rect(100, 100, 200, 200), 1, small)
    expect(box.width).toBe(384)
    expect(box.left).toBe(8)
    expect(box.top).toBe(8)
  })

  it('falls back to a square for a bad aspect ratio', () => {
    const box = fitPreviewBox(rect(20, 300, 200, 200), NaN, viewport)
    expect(box.width).toBe(box.height)
  })
})

describe('downloadName', () => {
  it('uses the original file name when known', () => {
    expect(downloadName({ fileName: 'cat.png', path: '/ab/cd/hash.png' })).toBe(
      'cat.png'
    )
  })

  it('falls back to the stored file name', () => {
    expect(downloadName({ path: '/ab/cd/hash.png' })).toBe('hash.png')
    expect(downloadName({ fileName: '  ', path: '/ab/cd/hash.png' })).toBe(
      'hash.png'
    )
  })

  it('removes characters a file name cannot hold', () => {
    const name = downloadName({ fileName: 'a/b:c?.jpg', path: '/x/y.jpg' })
    expect(name).not.toMatch(/[/:?]/)
    expect(name.endsWith('.jpg')).toBe(true)
  })
})
