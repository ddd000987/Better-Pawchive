import { describe, expect, it } from 'vitest'
import {
  clampView,
  fitView,
  initialWindowRect,
  overflows,
  zoomAt,
} from '../src/viewer/viewerMath'
import {
  parseViewerQuery,
  readViewerImage,
  readWindowRect,
  viewerQuery,
} from '../src/viewer/viewerLink'

const screen = { left: 0, top: 0, w: 1920, h: 1080 }

describe('initialWindowRect', () => {
  it('keeps the aspect ratio inside 80% of the screen, centred', () => {
    const r = initialWindowRect({ w: 1000, h: 2000 }, screen, false)
    // page height = 1080 * 0.8 - 64 = 800 → width 400
    expect(r.height).toBe(800 + 64)
    expect(r.width).toBe(400 + 16)
    expect(r.left).toBe(Math.round((1920 - r.width) / 2))
    expect(r.top).toBe(Math.round((1080 - r.height) / 2))
  })

  it('does not blow a full-size small image up past its pixels', () => {
    const r = initialWindowRect({ w: 300, h: 240 }, screen, true)
    expect(r.width).toBe(316)
    expect(r.height).toBe(304)
  })

  it('a smaller copy is scaled up to the screen share', () => {
    const r = initialWindowRect({ w: 300, h: 240 }, screen, false)
    expect(r.height).toBe(864)
  })

  it('without a size it takes a default box; never below the minimum', () => {
    expect(initialWindowRect(null, screen, false).width).toBeGreaterThan(200)
    const tiny = initialWindowRect({ w: 10, h: 10 }, screen, true)
    expect(tiny.width).toBe(216)
  })

  it('places the window on the screen it is on', () => {
    const r = initialWindowRect(
      { w: 100, h: 100 },
      { left: 1920, top: 0, w: 1280, h: 1024 },
      false
    )
    expect(r.left).toBeGreaterThanOrEqual(1920)
  })
})

describe('view geometry', () => {
  const image = { w: 2000, h: 1000 }
  const view = { w: 1000, h: 800 }

  it('fitView shows the whole image centred', () => {
    expect(fitView(image, view)).toEqual({ scale: 0.5, x: 0, y: 150 })
    // A small image is enlarged to fill the window
    expect(fitView({ w: 100, h: 100 }, view).scale).toBe(8)
  })

  it('zoomAt keeps the point under the cursor in place', () => {
    const start = fitView(image, view)
    const z = zoomAt(start, 2, 500, 400, image, view)
    expect(z.scale).toBe(1)
    // Image point under (500, 400) before: ((500-0)/0.5, (400-150)/0.5)
    const px = (500 - start.x) / start.scale
    expect(z.x + px * z.scale).toBeCloseTo(500)
    // Height 1000 > 800 now, so y is clamped but still covers the page
    expect(z.y).toBeLessThanOrEqual(0)
    expect(z.y).toBeGreaterThanOrEqual(800 - 1000)
  })

  it('clampView centres a small axis and leaves no gap on a large one', () => {
    expect(clampView({ scale: 1, x: 50, y: -999 }, image, view)).toEqual({
      scale: 1,
      x: 0,
      y: -200,
    })
    expect(clampView({ scale: 0.25, x: 0, y: 0 }, image, view)).toEqual({
      scale: 0.25,
      x: 250,
      y: 275,
    })
  })

  it('overflows tells pan from window move', () => {
    expect(overflows(fitView(image, view), image, view)).toBe(false)
    expect(overflows({ scale: 1, x: 0, y: 0 }, image, view)).toBe(true)
  })
})

describe('viewer link', () => {
  const image = {
    src: 'https://n1.kemono.cr/data/a.png?f=a b.png',
    placeholder: 'https://img.kemono.cr/thumbnail/data/a.png',
    title: '標題 & more (1/3)',
  }

  it('round-trips through the query string', () => {
    expect(parseViewerQuery('?' + viewerQuery(image))).toEqual(image)
  })

  it('rejects non-web image urls; a bad placeholder falls back to src', () => {
    expect(readViewerImage({ src: 'javascript:alert(1)' })).toBeNull()
    expect(readViewerImage({ src: 'chrome-extension://x/a.png' })).toBeNull()
    expect(readViewerImage(null)).toBeNull()
    expect(
      readViewerImage({ src: image.src, placeholder: 'data:,x', title: 3 })
    ).toEqual({ src: image.src, placeholder: image.src, title: '' })
    expect(parseViewerQuery('')).toBeNull()
  })

  it('accepts only a complete numeric window rect', () => {
    expect(
      readWindowRect({ left: 1.4, top: 2, width: 300, height: 200 })
    ).toEqual({ left: 1, top: 2, width: 300, height: 200 })
    expect(readWindowRect({ left: 1, top: 2, width: '300', height: 200 })).toBe(
      null
    )
    expect(
      readWindowRect({ left: NaN, top: 2, width: 300, height: 200 })
    ).toBeNull()
  })
})
