import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/Toast', () => ({
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock('../src/Log', () => ({
  log: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

const g = globalThis as any

afterEach(() => {
  vi.unstubAllGlobals()
})

async function load() {
  vi.resetModules()
  const { EVT } = await import('../src/EVT')
  const mod = await import('../src/setting/Settings')
  await import('../src/setting/AutoExportSettings')
  const { toast } = await import('../src/Toast')
  return { EVT, mod, toast }
}

describe('settings export', () => {
  let text = ''
  let anchor: Record<string, any>
  let appended: unknown[]

  beforeEach(() => {
    text = ''
    appended = []
    anchor = { click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: string[]) {
          text = parts.join('')
        }
      }
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    g.document.createElement = () => anchor
    g.document.body = { appendChild: (el: unknown) => appended.push(el) }
  })

  it('carries a schemaVersion and every setting key', async () => {
    const { EVT, mod } = await load()
    EVT.fire('exportSettings')

    const data = JSON.parse(text)
    expect(data.schemaVersion).toBe(mod.SETTINGS_SCHEMA_VERSION)
    for (const key of Object.keys(mod.defaultSettings)) {
      expect(data).toHaveProperty(key)
    }
  })

  it('clicks a detached anchor: nothing is added to the page DOM', async () => {
    const { EVT } = await load()
    EVT.fire('exportSettings')

    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.download).toMatch(/^pawchive-settings-\d+\.json$/)
    expect(appended).toEqual([])
  })
})

describe('settings import', () => {
  /** Run the real import handler with a stubbed file picker and reader */
  async function importText(content: string) {
    const loaded = await load()
    const picked: Record<string, () => void> = {}
    g.document.createElement = () => ({
      files: [{}],
      addEventListener: (type: string, fn: () => void) => {
        picked[type] = fn
      },
      click: () => {},
    })
    vi.stubGlobal(
      'FileReader',
      class {
        result = content
        onload: () => void = () => {}
        readAsText() {
          this.onload()
        }
      }
    )
    loaded.EVT.fire('importSettings')
    picked.change()
    return loaded
  }

  it('applies an old export that has no schemaVersion', async () => {
    const { mod, toast } = await importText(
      JSON.stringify({
        crawlInterval: 3,
        deduplication: false,
        skipExistingFiles: true,
      })
    )
    expect(mod.settings.get('crawlInterval')).toBe(3)
    expect(mod.settings.get('skipDownloaded')).toBe('folder')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('round-trips a current export', async () => {
    const { mod } = await importText(
      JSON.stringify({
        schemaVersion: 1,
        filterTitle: 'abc',
        filterMinFiles: 8,
      })
    )
    expect(mod.settings.get('filterTitle')).toBe('abc')
    expect(mod.settings.get('filterMinFiles')).toBe(8)
  })

  it('sanitizes values and fixes conflicts on the way in', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { mod } = await importText(
      JSON.stringify({
        filterDateFrom: 'soon',
        filterMinFiles: 9,
        filterMaxFiles: 2,
        hotkeys: {
          commandToggleCrawlPanel: {
            key: 'KeyQ',
            ctrl: false,
            alt: true,
            shift: false,
            meta: false,
          },
          commandStartDefaultCrawl: {
            key: 'KeyQ',
            ctrl: false,
            alt: true,
            shift: false,
            meta: false,
          },
        },
      })
    )
    expect(mod.settings.get('filterDateFrom')).toBe('')
    expect(mod.settings.get('filterMinFiles')).toBe(2)
    expect(mod.settings.get('filterMaxFiles')).toBe(9)
    const keys = mod.settings.get('hotkeys')
    expect(keys.commandToggleCrawlPanel?.key).toBe('KeyQ')
    expect(keys.commandStartDefaultCrawl?.key).toBe('KeyZ')
  })

  it('rejects a file with no known keys', async () => {
    const { toast } = await importText(JSON.stringify({ unknown: 1 }))
    expect(toast.error).toHaveBeenCalled()
  })
})
