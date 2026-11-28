/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * 純函數模組（不碰 DOM）：預覽浮層定位計算，供 PreviewWork 與測試共用。
 */

/** 浮層與視窗邊緣的最小距離 */
const MARGIN = 8
/** 浮層與游標之間的距離 */
const GAP = 24
/** 浮層與要避開的卡片之間的距離 */
const CARD_GAP = 8

/** 預覽浮層定位（純函數）：優先放在游標右側、垂直置中；右邊空間不足時
 * 翻到左側，最後把整個浮層夾回視窗（四周至少留 8px）。 */
export function clampPreviewPosition(
  mouseX: number,
  mouseY: number,
  totalW: number,
  totalH: number,
  viewW: number,
  viewH: number
): { x: number; y: number } {
  let x = mouseX + GAP
  if (x + totalW > viewW - MARGIN) x = mouseX - totalW - GAP
  const y = Math.max(
    MARGIN,
    Math.min(mouseY - totalH / 2, viewH - totalH - MARGIN)
  )
  return { x: Math.max(MARGIN, x), y }
}

export type PreviewSide = 'right' | 'left' | 'below' | 'above'

/** A box in viewport coordinates */
export interface PreviewRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PreviewFitInput {
  mouseX: number
  mouseY: number
  /** Keep the float off this box too (the hovered card, which holds the
   * cursor). The float falls back to the cursor alone when the space around
   * the box would shrink the image to under half of that. */
  avoid?: PreviewRect | null
  /** 圖片原始尺寸 */
  naturalW: number
  naturalH: number
  /** 浮層除圖片外的額外寬高（框線、上下資訊列） */
  chromeW: number
  chromeH: number
  viewW: number
  viewH: number
}

export interface PreviewFit {
  side: PreviewSide
  /** 圖片顯示尺寸 */
  imgW: number
  imgH: number
  /** 浮層左上角 */
  x: number
  y: number
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(v, hi))

/** 決定預覽浮層要放在游標哪一側、圖片縮成多大（純函數）。
 * 浮層永遠不蓋住游標：蓋住的話卡片會收到 mouseleave、hit-test 也打不到卡片，
 * 浮層被關掉後又被收斂迴圈重開，造成一直閃。
 * 做法：右／左／下／上四個方向各算一個可用區塊，選圖片能放最大的那一側
 * （同樣大時依右、左、下、上的順序），圖片不放大。
 * With `avoid` (the hovered card) the sides are measured from the card's
 * edges instead, so the float leaves the whole card visible. */
export function fitPreview(input: PreviewFitInput): PreviewFit {
  const { avoid, mouseX, mouseY } = input
  const point = { left: mouseX, top: mouseY, right: mouseX, bottom: mouseY }
  const atCursor = fitAround(input, point, GAP) ?? fitInWindow(input)
  if (!avoid) return atCursor
  // The cursor is on the card; include it anyway in case the card moved
  const box = {
    left: Math.min(avoid.left, mouseX),
    top: Math.min(avoid.top, mouseY),
    right: Math.max(avoid.right, mouseX),
    bottom: Math.max(avoid.bottom, mouseY),
  }
  const beside = fitAround(input, box, CARD_GAP)
  // Too little room around the card (huge card, small window): cover part
  // of the card rather than show a tiny image
  if (!beside || beside.imgW * 2 < atCursor.imgW) return atCursor
  return beside
}

/** Put the float on the side of `box` where the image is largest; null when
 * no side has room */
function fitAround(
  input: PreviewFitInput,
  box: PreviewRect,
  gap: number
): PreviewFit | null {
  const { mouseX, mouseY, chromeW, chromeH, viewW, viewH } = input
  const nw = Math.max(1, input.naturalW)
  const nh = Math.max(1, input.naturalH)
  const fullW = viewW - 2 * MARGIN - chromeW
  const fullH = viewH - 2 * MARGIN - chromeH
  const boxes: Record<PreviewSide, { w: number; h: number }> = {
    right: { w: viewW - MARGIN - (box.right + gap) - chromeW, h: fullH },
    left: { w: box.left - gap - MARGIN - chromeW, h: fullH },
    below: { w: fullW, h: viewH - MARGIN - (box.bottom + gap) - chromeH },
    above: { w: fullW, h: box.top - gap - MARGIN - chromeH },
  }
  const order: PreviewSide[] = ['right', 'left', 'below', 'above']
  let side: PreviewSide | null = null
  let best = 0
  for (const s of order) {
    const b = boxes[s]
    if (b.w < 1 || b.h < 1) continue
    const scale = Math.min(1, b.w / nw, b.h / nh)
    if (scale > best) {
      best = scale
      side = s
    }
  }
  if (!side) return null

  const imgW = Math.max(1, Math.floor(nw * best))
  const imgH = Math.max(1, Math.floor(nh * best))
  const totalW = imgW + chromeW
  const totalH = imgH + chromeH
  const centeredY = clamp(mouseY - totalH / 2, MARGIN, viewH - totalH - MARGIN)
  const centeredX = clamp(mouseX - totalW / 2, MARGIN, viewW - totalW - MARGIN)
  switch (side) {
    case 'right':
      return { side, imgW, imgH, x: box.right + gap, y: centeredY }
    case 'left':
      return { side, imgW, imgH, x: box.left - gap - totalW, y: centeredY }
    case 'below':
      return { side, imgW, imgH, x: centeredX, y: box.bottom + gap }
    case 'above':
      return { side, imgW, imgH, x: centeredX, y: box.top - gap - totalH }
  }
}

/** 視窗小到四側都放不下：退回整個視窗內縮放（只剩這種情況可能蓋到游標） */
function fitInWindow(input: PreviewFitInput): PreviewFit {
  const { mouseX, mouseY, chromeW, chromeH, viewW, viewH } = input
  const nw = Math.max(1, input.naturalW)
  const nh = Math.max(1, input.naturalH)
  const fullW = viewW - 2 * MARGIN - chromeW
  const fullH = viewH - 2 * MARGIN - chromeH
  const scale = Math.min(1, Math.max(1, fullW) / nw, Math.max(1, fullH) / nh)
  const imgW = Math.max(1, Math.floor(nw * scale))
  const imgH = Math.max(1, Math.floor(nh * scale))
  const { x, y } = clampPreviewPosition(
    mouseX,
    mouseY,
    imgW + chromeW,
    imgH + chromeH,
    viewW,
    viewH
  )
  return { side: 'right', imgW, imgH, x, y }
}
