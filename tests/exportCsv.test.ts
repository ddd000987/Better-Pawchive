import { describe, expect, it } from 'vitest'
import { csvCell } from '../src/download/ExportResult2CSV'

describe('csvCell', () => {
  it('leaves plain text alone', () => {
    expect(csvCell('abc')).toBe('abc')
  })

  it('quotes cells with commas, quotes, newlines and carriage returns', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })

  it('prefixes text that a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('+x')).toBe("'+x")
    expect(csvCell('-x')).toBe("'-x")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell('\tx')).toBe("'\tx")
  })

  it('applies both the prefix and the quoting when needed', () => {
    expect(csvCell('=a,b')).toBe('"\'=a,b"')
  })

  it('never prefixes numbers and booleans', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(false)).toBe('false')
  })

  it('keeps an empty string empty', () => {
    expect(csvCell('')).toBe('')
  })
})
