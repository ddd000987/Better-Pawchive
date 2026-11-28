import { describe, expect, it } from 'vitest'
import {
  buildInnerSlices,
  buildOuterCells,
  clampCenter,
  DEAD_ZONE,
  hitTest,
  INNER_OUTER,
  MENU_RADIUS,
  OUTER_OUTER,
  RATING_DEG,
  RATING_INNER,
  RATING_OUTER,
  VIEWPORT_MARGIN,
  type HitTestState,
  type InnerKind,
} from '../src/preview/radialGeometry'

const center = { x: 500, y: 500 }
const folders = [
  { id: 'unsorted', name: 'Unsorted' },
  { id: 'a', name: 'A' },
]

function state(
  over: Partial<HitTestState> = {},
  disabled: InnerKind[] = []
): HitTestState {
  return {
    center,
    innerSlices: buildInnerSlices(),
    outerCells: buildOuterCells(folders),
    expanded: false,
    disabled: new Set(disabled),
    ...over,
  }
}

/** Point at `dist` from the center, `deg` clockwise from 12 o'clock */
function at(deg: number, dist: number) {
  const rad = ((deg - 90) * Math.PI) / 180
  return {
    x: center.x + dist * Math.cos(rad),
    y: center.y + dist * Math.sin(rad),
  }
}

describe('radialGeometry', () => {
  it('lays out favorite, download, more, remove clockwise from the top', () => {
    const slices = buildInnerSlices()
    expect(slices.map((s) => [s.kind, s.angle])).toEqual([
      ['favorite', 0],
      ['download', 90],
      ['more', 180],
      ['remove', 270],
    ])
  })

  it('leaves out hidden slices and spreads the rest evenly', () => {
    const three = buildInnerSlices(new Set<InnerKind>(['download']))
    expect(three.map((s) => [s.kind, s.angle, s.index])).toEqual([
      ['favorite', 0, 0],
      ['more', 120, 1],
      ['remove', 240, 2],
    ])
    const two = buildInnerSlices(new Set<InnerKind>(['download', 'remove']))
    expect(two.map((s) => [s.kind, s.angle])).toEqual([
      ['favorite', 0],
      ['more', 180],
    ])
    // A point at 180 deg now picks "more"
    const r = hitTest(state({ innerSlices: two }), at(180, 60))
    expect(r.highlight).toEqual({ kind: 'inner', sliceIndex: 1 })
  })

  it('adds new, and more when there are over 9 folders', () => {
    expect(buildOuterCells(folders).map((c) => c.kind)).toEqual([
      'folder',
      'folder',
      'new',
    ])
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      name: String(i),
    }))
    const cells = buildOuterCells(many)
    expect(cells).toHaveLength(10)
    expect(cells.slice(-2).map((c) => c.kind)).toEqual(['new', 'more'])
  })

  it('highlights nothing in the dead zone', () => {
    const r = hitTest(state(), at(90, DEAD_ZONE - 1))
    expect(r.highlight).toEqual({ kind: 'none' })
  })

  it('opens the folder ring on the favorite slice', () => {
    const r = hitTest(state(), at(0, (DEAD_ZONE + INNER_OUTER) / 2))
    expect(r).toEqual({
      highlight: { kind: 'inner', sliceIndex: 0 },
      expanded: true,
      ratingCell: null,
    })
  })

  it('picks a folder cell beyond the inner ring', () => {
    // Two folders + new: cells centered on 0 deg, 28 deg apart
    const r = hitTest(state({ expanded: true }), at(-28, OUTER_OUTER - 20))
    expect(r.highlight).toEqual({ kind: 'outer', cellIndex: 0 })
  })

  it('flicks straight out to a folder cell', () => {
    const r = hitTest(state(), at(0, OUTER_OUTER - 20))
    expect(r).toEqual({
      highlight: { kind: 'outer', cellIndex: 1 },
      expanded: true,
      // A folder cell opens its rating ring
      ratingCell: 1,
    })
  })

  it('skips disabled slices', () => {
    const r = hitTest(state({}, ['download']), at(90, 60))
    expect(r.highlight).toEqual({ kind: 'none' })
    const ok = hitTest(state(), at(90, 60))
    expect(ok.highlight).toEqual({ kind: 'inner', sliceIndex: 1 })
  })

  it('keeps the menu inside the viewport', () => {
    const pad = MENU_RADIUS + VIEWPORT_MARGIN
    expect(clampCenter({ x: 0, y: 0 }, { width: 1000, height: 1000 })).toEqual({
      x: pad,
      y: pad,
    })
    expect(clampCenter({ x: 10, y: 10 }, { width: 200, height: 200 })).toEqual({
      x: 100,
      y: 100,
    })
  })

  describe('rating ring', () => {
    const midRating = (RATING_INNER + RATING_OUTER) / 2
    // Folder "A" (cell 1) is centered on 0 deg; ratings 1-5 around it
    const open = () => state({ expanded: true, ratingCell: 1 })

    it('picks a rating around the folder cell', () => {
      expect(hitTest(open(), at(0, midRating)).highlight).toEqual({
        kind: 'rating',
        cellIndex: 1,
        rating: 3,
      })
      expect(hitTest(open(), at(2 * RATING_DEG, midRating)).highlight).toEqual({
        kind: 'rating',
        cellIndex: 1,
        rating: 5,
      })
      expect(hitTest(open(), at(-2 * RATING_DEG, midRating)).highlight).toEqual(
        { kind: 'rating', cellIndex: 1, rating: 1 }
      )
    })

    it('highlights nothing past the rings it covers', () => {
      expect(hitTest(open(), at(4 * RATING_DEG, midRating)).highlight).toEqual({
        kind: 'none',
      })
    })

    it('does not pick a rating before its folder cell opened the ring', () => {
      const r = hitTest(state({ expanded: true }), at(0, midRating))
      expect(r.highlight).toEqual({ kind: 'none' })
    })

    it('closes the rating ring on the new folder cell', () => {
      // Cell 2 ("new") is at +28 deg
      const r = hitTest(open(), at(28, OUTER_OUTER - 20))
      expect(r).toEqual({
        highlight: { kind: 'outer', cellIndex: 2 },
        expanded: true,
        ratingCell: null,
      })
    })
  })

  describe('nothing to pick', () => {
    it('in the center', () => {
      const r = hitTest(state({ expanded: true, ratingCell: 1 }), at(0, 5))
      expect(r).toEqual({
        highlight: { kind: 'none' },
        expanded: false,
        ratingCell: null,
      })
    })

    it('outside the open rings', () => {
      expect(hitTest(state(), at(90, INNER_OUTER + 10)).highlight).toEqual({
        kind: 'none',
      })
      expect(
        hitTest(state({ expanded: true }), at(0, OUTER_OUTER + 10)).highlight
      ).toEqual({ kind: 'none' })
      expect(
        hitTest(
          state({ expanded: true, ratingCell: 1 }),
          at(0, RATING_OUTER + 10)
        ).highlight
      ).toEqual({ kind: 'none' })
    })
  })
})
