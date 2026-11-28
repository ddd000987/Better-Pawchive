import { describe, expect, it } from 'vitest'
import type { Labels } from '../src/watch/collectTypes'
import {
  MAX_TAG_LEN,
  MAX_TAGS,
  applyBulkLabelsPatch,
  applyLabelsPatch,
  collectTagCounts,
  matchesLabels,
  normalizeTag,
  normalizeTags,
  sanitizeRating,
} from '../src/watch/labels'

describe('labels', () => {
  it('normalizeTag trims, collapses inner whitespace, caps length, and rejects non-strings/empty', () => {
    expect(normalizeTag('  hello   world \t\n ')).toBe('hello world')
    expect(normalizeTag('   ')).toBeNull()
    expect(normalizeTag('')).toBeNull()
    expect(normalizeTag(123)).toBeNull()
    expect(normalizeTag(null)).toBeNull()
    expect(normalizeTag('a'.repeat(MAX_TAG_LEN + 10))).toHaveLength(MAX_TAG_LEN)
  })

  it('normalizeTags dedupes case-insensitively keeping first spelling, caps at MAX_TAGS, returns undefined when empty', () => {
    expect(
      normalizeTags(['  Art  ', 'art', 'ART', 'Sketch', '  ', 42, 'sketch'])
    ).toEqual(['Art', 'Sketch'])

    expect(normalizeTags(['   ', '', null])).toBeUndefined()
    expect(normalizeTags([])).toBeUndefined()
    expect(normalizeTags('not-an-array')).toBeUndefined()

    const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `tag-${i}`)
    const normalized = normalizeTags(many)
    expect(normalized).toHaveLength(MAX_TAGS)
    expect(normalized?.[0]).toBe('tag-0')
    expect(normalized?.[MAX_TAGS - 1]).toBe(`tag-${MAX_TAGS - 1}`)
  })

  it('sanitizeRating accepts integers 1..5 only', () => {
    for (const r of [1, 2, 3, 4, 5]) {
      expect(sanitizeRating(r)).toBe(r)
    }
    expect(sanitizeRating(0)).toBeUndefined()
    expect(sanitizeRating(6)).toBeUndefined()
    expect(sanitizeRating(3.5)).toBeUndefined()
    expect(sanitizeRating(Number.NaN)).toBeUndefined()
    expect(sanitizeRating('5')).toBeUndefined()
    expect(sanitizeRating(null)).toBeUndefined()
  })

  it('applyLabelsPatch updates, sanitizes, and removes fields with null or empty tags', () => {
    const item: Labels = {}
    applyLabelsPatch(item, { rating: 4, tags: ['  Anime ', 'anime', 'CG'] })
    expect(item).toEqual({ rating: 4, tags: ['Anime', 'CG'] })

    // undefined leaves fields untouched
    applyLabelsPatch(item, {})
    expect(item).toEqual({ rating: 4, tags: ['Anime', 'CG'] })

    // normalized-empty tags removes tags
    applyLabelsPatch(item, { tags: ['   '] })
    expect(item.tags).toBeUndefined()
    expect(item.rating).toBe(4)

    // null removes rating and tags
    applyLabelsPatch(item, { rating: null, tags: ['A'] })
    expect(item.rating).toBeUndefined()
    expect(item.tags).toEqual(['A'])

    applyLabelsPatch(item, { tags: null })
    expect(item.tags).toBeUndefined()
  })

  it('applyBulkLabelsPatch adds/removes tags case-insensitively and updates rating', () => {
    const item: Labels = { rating: 2, tags: ['Old', 'Keep'] }
    applyBulkLabelsPatch(item, {
      removeTags: ['old'],
      addTags: ['keep', 'New'],
      rating: 5,
    })
    expect(item).toEqual({ rating: 5, tags: ['Keep', 'New'] })

    applyBulkLabelsPatch(item, {
      removeTags: ['KEEP', 'new'],
      rating: null,
    })
    expect(item).toEqual({})
  })

  it('matchesLabels checks picked ratings and all filter tags case-insensitively', () => {
    const item: Labels = { rating: 4, tags: ['Landscape', 'Watercolor'] }
    expect(matchesLabels(item, {})).toBe(true)
    expect(matchesLabels(item, { ratings: [4] })).toBe(true)
    expect(matchesLabels(item, { ratings: [2, 4] })).toBe(true)
    expect(matchesLabels(item, { ratings: [5] })).toBe(false)
    expect(matchesLabels(item, { ratings: [3, 5] })).toBe(false)
    expect(matchesLabels(item, { tags: ['landscape', 'WATERCOLOR'] })).toBe(
      true
    )
    expect(matchesLabels(item, { tags: ['landscape', 'missing'] })).toBe(false)

    // Unrated fails when any rating is picked, passes when none is
    const unrated: Labels = { tags: ['Solo'] }
    expect(matchesLabels(unrated, { ratings: [1] })).toBe(false)
    expect(matchesLabels(unrated, { ratings: [] })).toBe(true)
    expect(matchesLabels(unrated, { tags: ['solo'] })).toBe(true)
  })

  it('collectTagCounts merges case-insensitively (first spelling wins) and sorts by count desc then tag asc', () => {
    const listA: Labels[] = [
      { tags: ['Anime', 'Sketch'] },
      { tags: ['anime', 'Portrait'] },
    ]
    const listB: Labels[] = [{ tags: ['ANIME', 'CG'] }, { tags: ['cg'] }]
    expect(collectTagCounts([listA, listB])).toEqual([
      { tag: 'Anime', count: 3 },
      { tag: 'CG', count: 2 },
      { tag: 'Portrait', count: 1 },
      { tag: 'Sketch', count: 1 },
    ])
  })
})
