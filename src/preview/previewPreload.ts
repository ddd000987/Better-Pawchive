/* license: GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt */
/*
 * Which images of a post the preview loads ahead of time (pure function, unit
 * tested). Wheel switching loops, so the neighbours wrap around: on the first
 * of 32 images, "previous" means 32, 31, 30.
 */

/**
 * Indices to preload around `index`, nearest first and alternating
 * (next 1, previous 1, next 2, previous 2, ...), so the image the user is most
 * likely to switch to next starts loading first. The current index and
 * duplicates (when the two directions meet in a short post) are left out.
 *
 * @param index current image, 0-based
 * @param total number of images in the post
 * @param next how many images after the current one
 * @param prev how many images before the current one
 */
export function preloadIndices(
  index: number,
  total: number,
  next: number,
  prev: number
): number[] {
  if (total <= 1) {
    return []
  }
  const wrap = (i: number) => ((i % total) + total) % total
  const seen = new Set<number>([wrap(index)])
  const out: number[] = []
  const add = (i: number) => {
    const w = wrap(i)
    if (!seen.has(w)) {
      seen.add(w)
      out.push(w)
    }
  }
  const steps = Math.max(next, prev, 0)
  for (let step = 1; step <= steps && out.length < total - 1; step++) {
    if (step <= next) add(index + step)
    if (step <= prev) add(index - step)
  }
  return out
}
