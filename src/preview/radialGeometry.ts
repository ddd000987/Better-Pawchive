/*
 * license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
 * derived from: PixStash src/content/radialGeometry.ts (MIT, ddd000987)
 * changes: the inner ring holds fixed actions (favorite, download, more,
 *          remove) instead of folder categories; the one "favorite" slice
 *          opens the outer ring of favorite folders (flat, no categories);
 *          a folder cell opens a third ring of ratings (1-5 stars); nothing
 *          is picked in the center or past the outermost open ring.
 */

export const DEAD_ZONE = 30
export const INNER_OUTER = 95
export const OUTER_INNER = 99
export const OUTER_OUTER = 175
export const RATING_INNER = 179
export const RATING_OUTER = 229
/** Outermost radius of the whole menu */
export const MENU_RADIUS = RATING_OUTER
export const CELL_DEG = 28
export const RATING_DEG = 18
export const RATINGS = [1, 2, 3, 4, 5] as const
export const MOVE_THRESHOLD = 8
export const MAX_OUTER_CELLS = 10
export const VIEWPORT_MARGIN = 8
/** Hold time before the menu opens on a press that does not move */
export const HOLD_MS = 150

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

export interface RadialFolder {
  id: string
  name: string
}

export type InnerKind = 'favorite' | 'download' | 'more' | 'remove'

export interface InnerSlice {
  kind: InnerKind
  index: number
  angle: number
  span: number
}

export type OuterCell =
  | { kind: 'folder'; folderId: string; name: string }
  | { kind: 'new' }
  | { kind: 'more' }

export type RadialHighlight =
  | { kind: 'none' }
  | { kind: 'inner'; sliceIndex: number }
  | { kind: 'outer'; cellIndex: number }
  /** A rating on the ring of the folder cell `cellIndex` */
  | { kind: 'rating'; cellIndex: number; rating: number }

export interface HitTestState {
  center: Point
  innerSlices: InnerSlice[]
  outerCells: OuterCell[]
  /** Whether the outer (folder) ring is open */
  expanded: boolean
  /** Inner slices that cannot be chosen right now */
  disabled: ReadonlySet<InnerKind>
  /** Outer (folder) cell whose rating ring is open, or null */
  ratingCell?: number | null
}

export interface HitTestResult {
  highlight: RadialHighlight
  expanded: boolean
  ratingCell: number | null
}

/** Normalizes an angle in degrees to [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Signed shortest angular difference from `a` to `b` in [-180, 180). */
export function angleDiff(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180
}

/** Clockwise angle in degrees from 12 o'clock, from `center` to `point`. */
export function pointAngle(center: Point, point: Point): number {
  const dx = point.x - center.x
  const dy = point.y - center.y
  return normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/** Inner ring, clockwise from the top: favorite, download, more, remove.
 * Kinds in `hidden` are left out and the others share the ring evenly
 * (favorite stays at the top). */
export function buildInnerSlices(
  hidden: ReadonlySet<InnerKind> = new Set()
): InnerSlice[] {
  const all: InnerKind[] = ['favorite', 'download', 'more', 'remove']
  const kinds = all.filter((k) => !hidden.has(k))
  const span = 360 / kinds.length
  return kinds.map((kind, index) => ({
    kind,
    index,
    angle: normalizeAngle(index * span),
    span,
  }))
}

/**
 * Outer-ring cells: folders + new, or when there are more than 9 folders,
 * the first 8 folders + new + more (max 10 cells).
 */
export function buildOuterCells(folders: RadialFolder[]): OuterCell[] {
  const toCell = (f: RadialFolder): OuterCell => ({
    kind: 'folder',
    folderId: f.id,
    name: f.name,
  })
  if (folders.length > MAX_OUTER_CELLS - 1) {
    return [
      ...folders.slice(0, MAX_OUTER_CELLS - 2).map(toCell),
      { kind: 'new' },
      { kind: 'more' },
    ]
  }
  return [...folders.map(toCell), { kind: 'new' }]
}

/** Center angles (clockwise from 12 o'clock) for `cellCount` outer cells. */
export function outerCellAngles(
  sliceAngle: number,
  cellCount: number
): number[] {
  const angles: number[] = []
  const half = (cellCount - 1) / 2
  for (let i = 0; i < cellCount; i++) {
    angles.push(normalizeAngle(sliceAngle + (i - half) * CELL_DEG))
  }
  return angles
}

function findInnerSliceIndex(slices: InnerSlice[], angle: number): number {
  const count = slices.length
  if (count === 0) return -1
  const span = 360 / count
  return Math.floor((normalizeAngle(angle) + span / 2) / span) % count
}

/** Center angles of the rating cells around a folder cell at `cellAngle` */
export function ratingCellAngles(cellAngle: number): number[] {
  const half = (RATINGS.length - 1) / 2
  return RATINGS.map((_, i) =>
    normalizeAngle(cellAngle + (i - half) * RATING_DEG)
  )
}

function findRating(cellAngle: number, angle: number): number | null {
  const angles = ratingCellAngles(cellAngle)
  for (let i = 0; i < angles.length; i++) {
    if (Math.abs(angleDiff(angles[i], angle)) <= RATING_DEG / 2) {
      return RATINGS[i]
    }
  }
  return null
}

function findOuterCellIndex(
  sliceAngle: number,
  cellCount: number,
  angle: number
): number {
  const angles = outerCellAngles(sliceAngle, cellCount)
  let bestIndex = -1
  let bestAbs = CELL_DEG / 2
  for (let i = 0; i < angles.length; i++) {
    const abs = Math.abs(angleDiff(angles[i], angle))
    if (abs <= bestAbs) {
      bestAbs = abs
      bestIndex = i
    }
  }
  return bestIndex
}

function favoriteSlice(slices: InnerSlice[]): InnerSlice | undefined {
  return slices.find((s) => s.kind === 'favorite')
}

/**
 * Which entry is highlighted, whether the folder ring is open and which
 * folder's rating ring is open, for a pointer position. Resting on the
 * favorite slice opens the folder ring; once open it stays open while the
 * pointer is beyond the inner ring. A folder cell opens its rating ring,
 * which stays open while the pointer is beyond the folder ring. The center
 * and anything past the outermost open ring highlight nothing.
 */
export function hitTest(state: HitTestState, point: Point): HitTestResult {
  const none: RadialHighlight = { kind: 'none' }
  const ratingCell = state.ratingCell ?? null
  const dist = Math.hypot(point.x - state.center.x, point.y - state.center.y)
  if (dist < DEAD_ZONE || state.innerSlices.length === 0) {
    return { highlight: none, expanded: false, ratingCell: null }
  }

  const angle = pointAngle(state.center, point)
  const sliceIndex = findInnerSliceIndex(state.innerSlices, angle)
  const slice = state.innerSlices[sliceIndex]
  const fav = favoriteSlice(state.innerSlices)
  const cellAngles = fav
    ? outerCellAngles(fav.angle, state.outerCells.length)
    : []

  if (dist <= INNER_OUTER) {
    if (!slice || state.disabled.has(slice.kind)) {
      return { highlight: none, expanded: false, ratingCell: null }
    }
    return {
      highlight: { kind: 'inner', sliceIndex },
      expanded: slice.kind === 'favorite',
      ratingCell: null,
    }
  }

  // Beyond the inner ring the folder ring must be open, or be flicked
  // open straight from the favorite slice
  const expanded =
    state.expanded ||
    (!!slice && !state.disabled.has(slice.kind) && slice.kind === 'favorite')
  if (!expanded || !fav) {
    return { highlight: none, expanded: false, ratingCell: null }
  }

  if (dist <= OUTER_OUTER) {
    const cellIndex = findOuterCellIndex(
      fav.angle,
      state.outerCells.length,
      angle
    )
    if (cellIndex < 0) return { highlight: none, expanded, ratingCell }
    const cell = state.outerCells[cellIndex]
    return {
      highlight: { kind: 'outer', cellIndex },
      expanded,
      // A folder opens its ratings; "new" and "more" close them
      ratingCell: cell?.kind === 'folder' ? cellIndex : null,
    }
  }

  // Rating ring: only the one already opened by its folder cell
  if (dist <= RATING_OUTER && ratingCell !== null) {
    const rating = findRating(cellAngles[ratingCell] ?? 0, angle)
    return {
      highlight:
        rating === null
          ? none
          : { kind: 'rating', cellIndex: ratingCell, rating },
      expanded,
      ratingCell,
    }
  }

  // Outside the menu
  return { highlight: none, expanded, ratingCell }
}

/** Outer radius of the outermost ring that is open */
export function openRadius(
  expanded: boolean,
  ratingCell: number | null
): number {
  if (ratingCell !== null) return RATING_OUTER
  return expanded ? OUTER_OUTER : INNER_OUTER
}

/**
 * Clamps the menu center so the outer ring plus margin fits inside the
 * viewport. If the viewport is smaller than the menu, centers in it.
 */
export function clampCenter(point: Point, viewport: Viewport): Point {
  const pad = MENU_RADIUS + VIEWPORT_MARGIN
  const x =
    viewport.width < pad * 2
      ? viewport.width / 2
      : Math.min(viewport.width - pad, Math.max(pad, point.x))
  const y =
    viewport.height < pad * 2
      ? viewport.height / 2
      : Math.min(viewport.height - pad, Math.max(pad, point.y))
  return { x, y }
}
