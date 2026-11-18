import { describe, expect, it } from 'vitest'
import { preloadIndices } from '../src/preview/previewPreload'

/** 1-based image numbers, as the user sees them */
const numbers = (index: number, total: number, next: number, prev: number) =>
  preloadIndices(index, total, next, prev).map((i) => i + 1)

describe('preloadIndices', () => {
  it('default (next 1, prev 0) keeps the old next-image preload', () => {
    expect(numbers(0, 32, 1, 0)).toEqual([2])
    expect(numbers(31, 32, 1, 0)).toEqual([1])
  })

  it('next 3 on the first image preloads 2 to 4', () => {
    expect(numbers(0, 32, 3, 0)).toEqual([2, 3, 4])
  })

  it('prev 3 on the first of 32 images wraps to 32, 31, 30', () => {
    expect(numbers(0, 32, 0, 3)).toEqual([32, 31, 30])
  })

  it('both directions alternate, nearest first', () => {
    expect(numbers(0, 32, 3, 3)).toEqual([2, 32, 3, 31, 4, 30])
  })

  it('wraps past the last image', () => {
    expect(numbers(30, 32, 3, 1)).toEqual([32, 30, 1, 2])
  })

  it('a short post loads each other image once and never the current one', () => {
    expect(numbers(0, 5, 3, 3)).toEqual([2, 5, 3, 4])
    expect(numbers(1, 3, 10, 10)).toEqual([3, 1])
  })

  it('uneven counts stop each direction at its own limit', () => {
    expect(numbers(5, 20, 1, 3)).toEqual([7, 5, 4, 3])
  })

  it('nothing to preload', () => {
    expect(preloadIndices(0, 32, 0, 0)).toEqual([])
    expect(preloadIndices(0, 1, 5, 5)).toEqual([])
    expect(preloadIndices(0, 0, 5, 5)).toEqual([])
  })
})
