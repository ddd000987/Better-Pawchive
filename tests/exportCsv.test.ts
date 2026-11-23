import { describe, expect, it, vi } from 'vitest'
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

describe('export: per-post download status', () => {
  it('reports done / partial / pending per post from one pass over the results', async () => {
    vi.useFakeTimers()
    const g = globalThis as any
    const { EVT } = await import('../src/EVT')
    const { store } = await import('../src/store/Store')
    const { downloadStates } = await import('../src/download/DownloadStates')
    await import('../src/download/ExportResult2CSV')

    const meta = (postKey: string) =>
      ({
        service: 'patreon',
        creator: 'c',
        creatorId: '1',
        postId: postKey.split('/')[2],
        title: 't',
        published: '2024-01-01',
        fileCount: 1,
        pending: false,
        postKey,
      }) as any
    store.resultMeta = [
      meta('patreon/1/1'), // all files done
      meta('patreon/1/2'), // one of two done
      meta('patreon/1/3'), // none done
      meta('patreon/1/4'), // no files in the results at all
    ]
    store.result = [
      { id: 'patreon/1/1#0', postKey: 'patreon/1/1' },
      { id: 'patreon/1/1#1', postKey: 'patreon/1/1' },
      { id: 'patreon/1/2#0', postKey: 'patreon/1/2' },
      { id: 'patreon/1/2#1', postKey: 'patreon/1/2' },
      { id: 'patreon/1/3#0', postKey: 'patreon/1/3' },
    ] as any
    downloadStates.init()
    downloadStates.setState(0, 1)
    downloadStates.setState(1, 1)
    downloadStates.setState(2, 1)
    downloadStates.setState(4, 0)

    let csv = ''
    const origBlob = globalThis.Blob
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: string[]) {
          csv = parts.join('')
        }
      }
    )
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:x',
      revokeObjectURL() {},
    })
    g.document.createElement = () => ({ click() {}, remove() {} })
    g.document.body = { appendChild() {} }
    try {
      EVT.fire('exportCSV')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
      expect(globalThis.Blob).toBe(origBlob)
      store.result = []
      store.resultMeta = []
      downloadStates.clear()
    }

    const rows = csv
      .replace('﻿', '')
      .split('\n')
      .slice(1)
      .map((line) => line.split(','))
    expect(rows.map((r) => [r[8], r[9]])).toEqual([
      ['patreon/1/1', 'done'],
      ['patreon/1/2', 'partial'],
      ['patreon/1/3', 'pending'],
      ['patreon/1/4', 'pending'],
    ])
  })
})
