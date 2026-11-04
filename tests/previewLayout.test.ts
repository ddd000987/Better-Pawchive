import { describe, expect, it } from 'vitest'
import {
  clampPreviewPosition,
  fitPreview,
  type PreviewFit,
} from '../src/preview/previewLayout'

const VW = 1000
const VH = 800

/** 游標是否落在浮層範圍內 */
function covers(
  fit: PreviewFit,
  chromeW: number,
  chromeH: number,
  mx: number,
  my: number
): boolean {
  return (
    mx >= fit.x &&
    mx <= fit.x + fit.imgW + chromeW &&
    my >= fit.y &&
    my <= fit.y + fit.imgH + chromeH
  )
}

function inView(fit: PreviewFit, chromeW: number, chromeH: number): boolean {
  return (
    fit.x >= 8 &&
    fit.y >= 8 &&
    fit.x + fit.imgW + chromeW <= VW - 8 &&
    fit.y + fit.imgH + chromeH <= VH - 8
  )
}

describe('fitPreview', () => {
  const base = { chromeW: 2, chromeH: 60, viewW: VW, viewH: VH }

  it('小圖：放在游標右側、原尺寸、垂直置中', () => {
    const fit = fitPreview({
      ...base,
      mouseX: 100,
      mouseY: 400,
      naturalW: 200,
      naturalH: 100,
    })
    expect(fit).toEqual({ side: 'right', imgW: 200, imgH: 100, x: 124, y: 320 })
  })

  it('游標靠右：翻到左側', () => {
    const fit = fitPreview({
      ...base,
      mouseX: 900,
      mouseY: 400,
      naturalW: 400,
      naturalH: 300,
    })
    expect(fit.side).toBe('left')
    expect(fit.x + fit.imgW + 2).toBe(900 - 24)
  })

  it('超寬圖、游標在中間：改放上方或下方，取能放最大的那側', () => {
    const fit = fitPreview({
      ...base,
      mouseX: 500,
      mouseY: 150,
      naturalW: 4000,
      naturalH: 1000,
    })
    expect(fit.side).toBe('below')
    expect(fit.y).toBe(150 + 24)
  })

  it('同樣大時依右、左、下、上的順序', () => {
    // 圖小到四側都能原尺寸放下
    const fit = fitPreview({
      ...base,
      mouseX: 500,
      mouseY: 400,
      naturalW: 50,
      naturalH: 50,
    })
    expect(fit.side).toBe('right')
  })

  it('大圖不放大、不超過可用空間', () => {
    const fit = fitPreview({
      ...base,
      mouseX: 100,
      mouseY: 400,
      naturalW: 3000,
      naturalH: 6000,
    })
    expect(fit.imgH).toBeLessThanOrEqual(VH - 16 - 60)
    expect(fit.imgW / fit.imgH).toBeCloseTo(0.5, 2)
  })

  const cases: Array<[number, number, number, number]> = []
  for (const [mx, my] of [
    [10, 10],
    [500, 400],
    [990, 790],
    [100, 700],
    [900, 50],
    [500, 30],
  ]) {
    for (const [nw, nh] of [
      [4000, 1000],
      [1000, 4000],
      [3000, 3000],
      [300, 200],
    ]) {
      cases.push([mx, my, nw, nh])
    }
  }
  it.each(cases)(
    '游標 (%i,%i)、圖 %ix%i：不蓋住游標且留在視窗內',
    (mx, my, nw, nh) => {
      const fit = fitPreview({
        ...base,
        mouseX: mx,
        mouseY: my,
        naturalW: nw,
        naturalH: nh,
      })
      expect(covers(fit, 2, 60, mx, my)).toBe(false)
      expect(inView(fit, 2, 60)).toBe(true)
    }
  )

  it('視窗小到四側都放不下：退回整窗縮放且不產生負座標', () => {
    const fit = fitPreview({
      mouseX: 30,
      mouseY: 30,
      naturalW: 500,
      naturalH: 500,
      chromeW: 2,
      chromeH: 60,
      viewW: 60,
      viewH: 100,
    })
    expect(fit.x).toBeGreaterThanOrEqual(8)
    expect(fit.y).toBeGreaterThanOrEqual(8)
  })
})

describe('clampPreviewPosition', () => {
  it('優先放在游標右側並垂直置中', () => {
    expect(clampPreviewPosition(100, 400, 200, 100, VW, VH)).toEqual({
      x: 124,
      y: 350,
    })
  })

  it('右側空間不足時翻到游標左側', () => {
    expect(clampPreviewPosition(900, 400, 200, 100, VW, VH)).toEqual({
      x: 676,
      y: 350,
    })
  })

  it('左右都放不下時仍留在視窗內（至少 8px 邊距）', () => {
    expect(clampPreviewPosition(10, 400, 990, 100, VW, VH)).toEqual({
      x: 8,
      y: 350,
    })
  })

  it('靠上時夾到 8px', () => {
    expect(clampPreviewPosition(100, 0, 200, 100, VW, VH)).toEqual({
      x: 124,
      y: 8,
    })
  })

  it('靠下時夾到視窗底部（保留 8px）', () => {
    expect(clampPreviewPosition(100, 800, 200, 100, VW, VH)).toEqual({
      x: 124,
      y: 692,
    })
  })

  it('浮層比視窗高時不會產生負座標', () => {
    expect(clampPreviewPosition(100, 400, 200, 900, VW, VH)).toEqual({
      x: 124,
      y: 8,
    })
  })
})
