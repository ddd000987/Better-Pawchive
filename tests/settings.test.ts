import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVT } from '../src/EVT'
import { Config } from '../src/Config'
import {
  defaultHotkeys,
  defaultSettings,
  migrateLegacySettings,
  migrateSettingsObject,
  parseStoredSettings,
  sanitizeHotkeys,
  sanitizePreviewHotkeys,
  sanitizeSetting,
  SETTINGS_SCHEMA_VERSION,
  settings,
} from '../src/setting/Settings'
import type { SettingKey } from '../src/setting/Settings'

type StorageListener = (
  changes: Record<string, { newValue?: unknown }>,
  area: string
) => void

// tests/setup.ts has no chrome.storage.onChanged; capture the listener every
// Settings instance registers (hoisted: the singleton registers on import).
const storageListeners = vi.hoisted(() => {
  const list: StorageListener[] = []
  ;(
    globalThis as unknown as {
      chrome: { storage: { onChanged: unknown } }
    }
  ).chrome.storage.onChanged = {
    addListener: (fn: StorageListener) => list.push(fn),
  }
  return list
})

describe('sanitizeSetting', () => {
  it('downloadThread：夾取、四捨五入、非有限數與型別不符回預設', () => {
    expect(sanitizeSetting('downloadThread', 999)).toBe(
      Config.downloadThreadMax
    )
    expect(sanitizeSetting('downloadThread', 0)).toBe(1)
    expect(sanitizeSetting('downloadThread', 2.6)).toBe(3)
    expect(sanitizeSetting('downloadThread', NaN)).toBe(
      Config.downloadThreadDefault
    )
    expect(sanitizeSetting('downloadThread', '4')).toBe(
      Config.downloadThreadDefault
    )
  })

  it('downloadInterval 與 crawlInterval 夾取', () => {
    expect(sanitizeSetting('downloadInterval', -5)).toBe(0)
    expect(sanitizeSetting('downloadInterval', NaN)).toBe(0)
    expect(sanitizeSetting('crawlInterval', 99)).toBe(10)
  })

  it('preview preload counts are clamped to whole numbers 0–10', () => {
    expect(defaultSettings.previewPreloadNext).toBe(1)
    expect(defaultSettings.previewPreloadPrev).toBe(0)
    expect(sanitizeSetting('previewPreloadNext', -1)).toBe(0)
    expect(sanitizeSetting('previewPreloadNext', 99)).toBe(10)
    expect(sanitizeSetting('previewPreloadPrev', 2.6)).toBe(3)
    expect(sanitizeSetting('previewPreloadPrev', NaN)).toBe(0)
    expect(sanitizeSetting('previewPreloadPrev', '3')).toBe(0)
  })

  it('watch scan settings defaults and interval clamping (1–168 integer)', () => {
    expect(defaultSettings.watchScanEnabled).toBe(true)
    expect(defaultSettings.watchScanIntervalHours).toBe(6)
    expect(defaultSettings.watchNotice).toBe(true)
    expect(sanitizeSetting('watchScanIntervalHours', 0)).toBe(1)
    expect(sanitizeSetting('watchScanIntervalHours', 999)).toBe(168)
    expect(sanitizeSetting('watchScanIntervalHours', 4.6)).toBe(5)
    expect(sanitizeSetting('watchScanIntervalHours', NaN)).toBe(6)
    expect(sanitizeSetting('watchScanIntervalHours', '12')).toBe(6)
    expect(sanitizeSetting('watchScanEnabled', 'yes')).toBe(true)
    expect(sanitizeSetting('watchNotice', 0)).toBe(true)
  })

  it('枚舉鍵白名單', () => {
    expect(sanitizeSetting('textContent', 'xxx')).toBe('txt')
    expect(sanitizeSetting('skipDownloaded', 'both')).toBe('both')
    expect(sanitizeSetting('skipDownloaded', 'strict')).toBe('record')
    expect(sanitizeSetting('skipDownloaded', true)).toBe('record')
  })

  it('settings.set 寫入前會清洗', () => {
    settings.set('downloadThread', 999 as never)
    expect(settings.get('downloadThread')).toBe(Config.downloadThreadMax)
  })
})

describe('settings.restore', () => {
  it('存檔值經清洗後寫回', async () => {
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
      [Config.settingStoreName]: {
        downloadThread: 999,
        crawlInterval: 50,
        textContent: 'bad',
        namingRule: 'x',
      },
    } as never)

    await settings.restore()

    expect(settings.get('downloadThread')).toBe(Config.downloadThreadMax)
    expect(settings.get('crawlInterval')).toBe(10)
    expect(settings.get('textContent')).toBe('txt')
    expect(settings.get('namingRule')).toBe('x')
  })

  it('舊存檔（deduplication／skipExistingFiles）合併成 skipDownloaded，舊鍵被丟掉', async () => {
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({
      [Config.settingStoreName]: {
        deduplication: true,
        dupliStrategy: 'strict',
        skipExistingFiles: true,
        switchImageByKeyboard: false,
      },
    } as never)

    await settings.restore()

    expect(settings.get('skipDownloaded')).toBe('both')
    const store = settings as unknown as { store: Record<string, unknown> }
    expect('deduplication' in store.store).toBe(false)
    expect('dupliStrategy' in store.store).toBe(false)
    expect('skipExistingFiles' in store.store).toBe(false)
    expect('switchImageByKeyboard' in store.store).toBe(false)
  })
})

describe('settings.resetAll', () => {
  it('所有鍵恢復預設，物件鍵不共用預設物件的引用', () => {
    settings.set('downloadThread', 1)
    settings.set('namingRule', 'x/{index}')
    settings.set('PreviewWork', false)
    settings.set('wheelScrollPageMoveDistance', 200)
    settings.set('previewInfoPlacement', {
      ...settings.get('previewInfoPlacement'),
      title: 'none',
    })

    settings.resetAll()

    for (const key of Object.keys(defaultSettings) as SettingKey[]) {
      expect(settings.get(key)).toEqual(defaultSettings[key])
    }
    expect(settings.get('hotkeys')).not.toBe(defaultSettings.hotkeys)
    expect(settings.get('previewInfoPlacement')).not.toBe(
      defaultSettings.previewInfoPlacement
    )
  })
})

describe('migrateLegacySettings', () => {
  const derive = (dedup: unknown, folder: unknown) =>
    migrateLegacySettings({ deduplication: dedup, skipExistingFiles: folder })
      .skipDownloaded

  it('去重／資料夾四種組合對應 skipDownloaded', () => {
    expect(derive(true, true)).toBe('both')
    expect(derive(true, false)).toBe('record')
    expect(derive(false, true)).toBe('folder')
    expect(derive(false, false)).toBe('none')
  })

  it('只有一個舊鍵時，缺的那個按舊預設（去重開、資料夾關）', () => {
    expect(migrateLegacySettings({ deduplication: false }).skipDownloaded).toBe(
      'none'
    )
    expect(
      migrateLegacySettings({ skipExistingFiles: true }).skipDownloaded
    ).toBe('both')
  })

  it('已有新鍵時以新鍵為準；沒有任何舊鍵時不憑空產生', () => {
    expect(
      migrateLegacySettings({ skipDownloaded: 'folder', deduplication: true })
        .skipDownloaded
    ).toBe('folder')
    expect(migrateLegacySettings({ namingRule: 'x' })).toEqual({
      namingRule: 'x',
    })
  })

  it('丟掉已移除的鍵，且不改動原物件', () => {
    const input = {
      deduplication: true,
      dupliStrategy: 'loose',
      skipExistingFiles: false,
      switchImageByKeyboard: true,
      textContent: 'html',
    }
    const out = migrateLegacySettings(input)
    expect(out).toEqual({ skipDownloaded: 'record', textContent: 'html' })
    expect(input.deduplication).toBe(true)
  })
})

describe('cross-tab sync (chrome.storage.onChanged)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 80))
  const emit = (value: unknown, area = 'local', listener?: StorageListener) =>
    (listener ?? storageListeners[0])(
      { [Config.settingStoreName]: { newValue: value } },
      area
    )

  const changes: { key: string; value: unknown }[] = []
  const onChange = (ev: CustomEvent) => {
    changes.push(ev.detail.data)
  }
  const track = () => {
    changes.length = 0
    EVT.on(EVT.list.settingChange, onChange)
  }
  afterEach(() => {
    EVT.off(EVT.list.settingChange, onChange)
  })

  /** Bring the singleton to a known state: restored, nothing pending save. */
  async function prepare() {
    vi.spyOn(chrome.storage.local, 'get').mockResolvedValue({} as never)
    await settings.restore()
    settings.resetAll()
    await flush()
  }

  it('applies a remote change, fires settingChange, and does not save', async () => {
    await prepare()
    const set = vi.spyOn(chrome.storage.local, 'set')
    track()

    emit({ ...defaultSettings, crawlInterval: 3, filterTitle: 'abc' })
    await flush()

    expect(settings.get('crawlInterval')).toBe(3)
    expect(settings.get('filterTitle')).toBe('abc')
    expect(changes).toEqual([
      { key: 'crawlInterval', value: 3 },
      { key: 'filterTitle', value: 'abc' },
    ])
    expect(set).not.toHaveBeenCalled()
  })

  it('ignores an echo that carries no differing value', async () => {
    await prepare()
    settings.set('crawlInterval', 2)
    await flush()
    const set = vi.spyOn(chrome.storage.local, 'set')
    track()

    emit(JSON.parse(JSON.stringify(settings['store' as never])))
    await flush()

    expect(changes).toEqual([])
    expect(set).not.toHaveBeenCalled()
  })

  it('leaves keys absent from the remote value alone', async () => {
    await prepare()
    settings.set('namingRule', 'keep/{index}')
    await flush()
    track()

    emit({ crawlInterval: 4 })

    expect(settings.get('namingRule')).toBe('keep/{index}')
    expect(settings.get('crawlInterval')).toBe(4)
    expect(changes).toEqual([{ key: 'crawlInterval', value: 4 }])
  })

  it('sanitizes an invalid remote value to the default', async () => {
    await prepare()
    settings.set('downloadThread', 2)
    await flush()
    track()

    emit({ downloadThread: 'many', textContent: 'bad' })

    expect(settings.get('downloadThread')).toBe(Config.downloadThreadDefault)
    expect(settings.get('textContent')).toBe(defaultSettings.textContent)
    expect(changes).toEqual([
      { key: 'downloadThread', value: Config.downloadThreadDefault },
    ])
  })

  it('runs remote hotkeys through the hotkey validator', async () => {
    await prepare()
    track()
    const alt = (key: string) => ({
      key,
      ctrl: false,
      alt: true,
      shift: false,
      meta: false,
    })

    emit({
      hotkeys: {
        commandToggleCrawlPanel: alt('<img src=x onerror=alert(1)>'),
        commandStartDefaultCrawl: alt('Tab'),
        commandTogglePreviewWork: alt('KeyK'),
      },
    })

    expect(settings.get('hotkeys')).toEqual({
      commandTogglePreviewWork: alt('KeyK'),
    })
    expect(changes).toHaveLength(1)
    expect(changes[0].key).toBe('hotkeys')
  })

  it('ignores other storage areas and a missing/non-object value', async () => {
    await prepare()
    track()
    emit({ crawlInterval: 9 }, 'sync')
    emit(undefined)
    emit('nope')
    expect(settings.get('crawlInterval')).toBe(defaultSettings.crawlInterval)
    expect(changes).toEqual([])
  })

  it('does not overwrite a local change that is still waiting to be saved', async () => {
    await prepare()
    settings.set('crawlInterval', 7)
    track()

    emit({ crawlInterval: 1, filterTitle: 'remote' })

    expect(settings.get('crawlInterval')).toBe(7)
    expect(settings.get('filterTitle')).toBe('remote')
    await flush()
  })

  it('holds an event that arrives before restore() finishes, then applies it', async () => {
    vi.resetModules()
    const before = storageListeners.length
    const mod = await import('../src/setting/Settings')
    const { EVT: evt } = await import('../src/EVT')
    const listener = storageListeners[before]
    const fresh = mod.settings
    const seen: string[] = []
    evt.on(evt.list.settingChange, (ev) => seen.push(ev.detail.data.key))

    let resolveGet!: (v: unknown) => void
    vi.spyOn(chrome.storage.local, 'get').mockReturnValue(
      new Promise((r) => (resolveGet = r)) as never
    )
    const restoring = fresh.restore()
    // storage read started; a remote write lands before it resolves
    emit({ crawlInterval: 5 }, 'local', listener)
    expect(fresh.get('crawlInterval')).toBe(mod.defaultSettings.crawlInterval)
    resolveGet({ [Config.settingStoreName]: { filterTitle: 'old' } })
    await restoring

    expect(fresh.get('filterTitle')).toBe('old')
    expect(fresh.get('crawlInterval')).toBe(5)
    expect(seen).toEqual(['crawlInterval'])
  })
})

describe('settings that could not be read at startup', () => {
  const flush = () => new Promise((r) => setTimeout(r, 80))

  /** A fresh Settings instance whose restore() failed to read storage. */
  async function failedRestore() {
    vi.resetModules()
    const mod = await import('../src/setting/Settings')
    const { EVT: evt } = await import('../src/EVT')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const get = vi
      .spyOn(chrome.storage.local, 'get')
      .mockRejectedValue(new Error('storage unavailable'))
    const set = vi.spyOn(chrome.storage.local, 'set')
    await mod.settings.restore()
    let blocked = 0
    evt.on(evt.list.settingSaveBlocked, () => blocked++)
    return { fresh: mod.settings, get, set, blocked: () => blocked }
  }

  it('does not write defaults over the saved settings while the read keeps failing', async () => {
    const { fresh, set, blocked } = await failedRestore()

    fresh.set('filterTitle', 'mine')
    await flush()
    fresh.set('crawlInterval', 7)
    await flush()

    expect(set).not.toHaveBeenCalled()
    // The user is told once, not on every change
    expect(blocked()).toBe(1)
    expect(fresh.get('filterTitle')).toBe('mine')
  })

  it('reads the saved settings before the first write once storage works again', async () => {
    const { fresh, get, set, blocked } = await failedRestore()
    get.mockResolvedValue({
      [Config.settingStoreName]: { filterTitle: 'saved', crawlInterval: 5 },
    } as never)

    fresh.set('filterTitle', 'mine')
    await flush()

    // The local change wins for its key; every other key takes the saved value
    expect(fresh.get('filterTitle')).toBe('mine')
    expect(fresh.get('crawlInterval')).toBe(5)
    expect(blocked()).toBe(0)
    expect(set).toHaveBeenCalledTimes(1)
    const written = (
      set.mock.calls[0][0] as Record<string, Record<string, unknown>>
    )[Config.settingStoreName]
    expect(written.filterTitle).toBe('mine')
    expect(written.crawlInterval).toBe(5)
  })
})

describe('sanitizeSetting: filter formats', () => {
  it('date bounds are empty or a real YYYY-MM-DD date', () => {
    expect(sanitizeSetting('filterDateFrom', '')).toBe('')
    expect(sanitizeSetting('filterDateFrom', '2024-01-31')).toBe('2024-01-31')
    expect(sanitizeSetting('filterDateTo', ' 2024-02-29 ')).toBe('2024-02-29')
    for (const bad of [
      '2024-02-30',
      '2023-02-29',
      '2024-13-01',
      '2024/01/01',
      '24-01-01',
      '2024-1-1',
      'yesterday',
    ]) {
      expect(sanitizeSetting('filterDateFrom', bad)).toBe('')
      expect(sanitizeSetting('filterDateTo', bad)).toBe('')
    }
    expect(sanitizeSetting('filterDateFrom', 20240101)).toBe('')
  })

  it('post id bounds are empty or digits only', () => {
    expect(sanitizeSetting('filterPostIdFrom', '12345')).toBe('12345')
    expect(sanitizeSetting('filterPostIdTo', ' 99 ')).toBe('99')
    expect(sanitizeSetting('filterPostIdFrom', '')).toBe('')
    for (const bad of ['abc', '12a', '-5', '1.5', '1'.repeat(40)]) {
      expect(sanitizeSetting('filterPostIdFrom', bad)).toBe('')
      expect(sanitizeSetting('filterPostIdTo', bad)).toBe('')
    }
  })

  it('services are a comma-separated list of plain names', () => {
    expect(sanitizeSetting('filterServices', '')).toBe('')
    expect(sanitizeSetting('filterServices', 'patreon')).toBe('patreon')
    expect(sanitizeSetting('filterServices', 'patreon, Fanbox ,')).toBe(
      'patreon,Fanbox'
    )
    expect(sanitizeSetting('filterServices', 'pa treon,<b>,fanbox')).toBe(
      'fanbox'
    )
    expect(sanitizeSetting('filterServices', 'a'.repeat(100))).toBe('')
  })
})

function plain(key: string) {
  return { key, ctrl: false, alt: false, shift: false, meta: false }
}

describe('parseStoredSettings: cross-key checks', () => {
  it('swaps a file-count range whose minimum is above its maximum', () => {
    const out = parseStoredSettings({ filterMinFiles: 9, filterMaxFiles: 3 })
    expect(out.filterMinFiles).toBe(3)
    expect(out.filterMaxFiles).toBe(9)
  })

  it('leaves a range alone when a bound is unset (0) or already ordered', () => {
    expect(
      parseStoredSettings({ filterMinFiles: 9, filterMaxFiles: 0 })
    ).toMatchObject({ filterMinFiles: 9, filterMaxFiles: 0 })
    expect(
      parseStoredSettings({ filterMinFiles: 2, filterMaxFiles: 5 })
    ).toMatchObject({ filterMinFiles: 2, filterMaxFiles: 5 })
  })

  it('checks a lone bound against the current value of the other', () => {
    const out = parseStoredSettings(
      { filterMinFiles: 9 },
      { ...defaultSettings, filterMaxFiles: 4 }
    )
    expect(out.filterMinFiles).toBe(4)
    expect('filterMaxFiles' in out).toBe(false)
  })

  it('a preview key that shares a combo with a global hotkey gives way', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = parseStoredSettings({
      hotkeys: { commandToggleCrawlPanel: plain('KeyD') },
      previewHotkeys: { previewDownloadPost: plain('KeyD') },
    })
    expect(out.hotkeys?.commandToggleCrawlPanel).toEqual(plain('KeyD'))
    // Its own default (D) is taken by the global key, so it is left unbound
    expect(out.previewHotkeys?.previewDownloadPost).toBeUndefined()
  })

  it('a lone imported global hotkey gives way to the current preview keys', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = parseStoredSettings(
      { hotkeys: { commandToggleCrawlPanel: plain('KeyD') } },
      defaultSettings
    )
    // Falls back to its default Alt+X
    expect(out.hotkeys?.commandToggleCrawlPanel).toEqual(
      defaultHotkeys.commandToggleCrawlPanel
    )
  })
})

describe('imported hotkey duplicates', () => {
  const alt = (key: string) => ({ ...plain(key), alt: true })

  it('the later command falls back to its default when that is free', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('KeyX'),
      commandStartDefaultCrawl: alt('KeyX'),
    })
    expect(out.commandToggleCrawlPanel).toEqual(alt('KeyX'))
    expect(out.commandStartDefaultCrawl).toEqual(alt('KeyZ'))
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('the later command is left unbound when its default is taken too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('KeyZ'),
      commandStartDefaultCrawl: alt('KeyZ'),
    })
    expect(out.commandToggleCrawlPanel).toEqual(alt('KeyZ'))
    expect(out.commandStartDefaultCrawl).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a fallback default never takes a combo a later command holds', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = sanitizeHotkeys({
      commandToggleCrawlPanel: alt('KeyP'),
      commandStartDefaultCrawl: alt('KeyP'),
      commandTogglePreviewWork: alt('KeyZ'),
    })
    // The duplicate would default to Alt+Z, but the third command holds it
    expect(out.commandStartDefaultCrawl).toBeUndefined()
    expect(out.commandTogglePreviewWork).toEqual(alt('KeyZ'))
  })

  it('applies to the preview keys too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = sanitizePreviewHotkeys({
      previewDownloadPost: plain('KeyG'),
      previewDownloadImage: plain('KeyG'),
    })
    expect(out.previewDownloadPost).toEqual(plain('KeyG'))
    expect(out.previewDownloadImage).toEqual(plain('KeyC'))
  })

  it('distinct combos and cleared commands are untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = {
      commandToggleCrawlPanel: alt('KeyQ'),
      commandStartDefaultCrawl: { ...alt('KeyQ'), shift: true },
    }
    expect(sanitizeHotkeys(input)).toEqual(input)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('schemaVersion', () => {
  const legacy = {
    deduplication: true,
    skipExistingFiles: true,
    crawlInterval: 2,
  }

  it('an object with no version is legacy: migrated, then stamped', () => {
    const out = migrateSettingsObject(legacy)
    expect(out.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(SETTINGS_SCHEMA_VERSION).toBe(1)
    expect(out.skipDownloaded).toBe('both')
    expect('deduplication' in out).toBe(false)
  })

  it('a versioned object skips the legacy migration', () => {
    const out = migrateSettingsObject({ ...legacy, schemaVersion: 1 })
    expect(out.skipDownloaded).toBeUndefined()
    expect(out.schemaVersion).toBe(1)
  })

  it('an invalid version counts as missing; a newer one is kept', () => {
    expect(
      migrateSettingsObject({ ...legacy, schemaVersion: 'x' })
    ).toMatchObject({ skipDownloaded: 'both', schemaVersion: 1 })
    expect(migrateSettingsObject({ schemaVersion: 7 }).schemaVersion).toBe(7)
  })

  it('parseStoredSettings migrates an old export and ignores the version key', () => {
    const out = parseStoredSettings(legacy)
    expect(out.skipDownloaded).toBe('both')
    expect(out.crawlInterval).toBe(2)
    expect('schemaVersion' in out).toBe(false)
  })

  it('does not change the input object', () => {
    const input = { ...legacy }
    migrateSettingsObject(input)
    expect(input).toEqual(legacy)
  })
})

describe('saving settings', () => {
  const flush = () => new Promise((r) => setTimeout(r, 80))
  const NAME = Config.settingStoreName

  /** A fresh Settings over an in-memory storage that tests can change. */
  async function setup(initial?: Record<string, unknown>) {
    vi.resetModules()
    const mod = await import('../src/setting/Settings')
    const { EVT: evt } = await import('../src/EVT')
    const mem: Record<string, unknown> = initial ? { [NAME]: initial } : {}
    vi.spyOn(chrome.storage.local, 'get').mockImplementation((async () => ({
      ...mem,
    })) as never)
    const set = vi
      .spyOn(chrome.storage.local, 'set')
      .mockImplementation((async (items: Record<string, unknown>) => {
        Object.assign(mem, items)
      }) as never)
    await mod.settings.restore()
    const blocked: unknown[] = []
    evt.on(evt.list.settingSaveBlocked, (ev) => blocked.push(ev.detail.data))
    return { fresh: mod.settings, mod, set, mem, blocked }
  }

  const stored = (mem: Record<string, unknown>) =>
    mem[NAME] as Record<string, unknown>

  it('writes a schemaVersion with the settings', async () => {
    const { fresh, mem } = await setup()
    fresh.set('filterTitle', 'x')
    await flush()
    expect(stored(mem).schemaVersion).toBe(1)
    expect(stored(mem).filterTitle).toBe('x')
  })

  it('a change made by another tab to a different key is not overwritten', async () => {
    const { fresh, mem } = await setup({ schemaVersion: 1, crawlInterval: 1 })
    // Another tab saves other keys while this tab sits idle
    mem[NAME] = {
      schemaVersion: 1,
      crawlInterval: 9,
      namingRule: 'other-tab/{title}',
    }

    fresh.set('filterTitle', 'mine')
    await flush()

    expect(stored(mem)).toMatchObject({
      filterTitle: 'mine',
      crawlInterval: 9,
      namingRule: 'other-tab/{title}',
    })
  })

  it('this tab still wins for a key it changed itself', async () => {
    const { fresh, mem } = await setup({ schemaVersion: 1, crawlInterval: 1 })
    mem[NAME] = { schemaVersion: 1, crawlInterval: 9 }

    fresh.set('crawlInterval', 4)
    await flush()

    expect(stored(mem).crawlInterval).toBe(4)
  })

  it('writes only the keys this tab changed (plus the version)', async () => {
    const { fresh, set } = await setup({ schemaVersion: 1, crawlInterval: 3 })
    fresh.set('filterTitle', 'mine')
    await flush()
    const written = (set.mock.calls[0][0] as Record<string, any>)[NAME]
    expect(Object.keys(written).sort()).toEqual(
      ['crawlInterval', 'filterTitle', 'schemaVersion'].sort()
    )
  })

  it('upgrades a legacy stored object when it saves', async () => {
    const { fresh, mem } = await setup({
      deduplication: false,
      skipExistingFiles: true,
    })
    fresh.set('filterTitle', 'x')
    await flush()
    expect(stored(mem)).toMatchObject({
      schemaVersion: 1,
      skipDownloaded: 'folder',
      filterTitle: 'x',
    })
    expect('deduplication' in stored(mem)).toBe(false)
  })

  it('keeps the keys dirty when the write fails, and tells the user once', async () => {
    const { fresh, set, mem, blocked } = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    set.mockRejectedValueOnce(new Error('quota'))
    set.mockRejectedValueOnce(new Error('quota'))

    fresh.set('filterTitle', 'first')
    await flush()
    fresh.set('crawlInterval', 3)
    await flush()

    expect(blocked).toEqual([{ reason: 'writeFailed' }])
    expect(mem[NAME]).toBeUndefined()
    const dirty = (fresh as unknown as { dirtyRev: Map<string, number> })
      .dirtyRev
    expect([...dirty.keys()].sort()).toEqual(['crawlInterval', 'filterTitle'])

    // Storage works again: the next change carries every unsaved key
    fresh.set('filterMaxFiles', 5)
    await flush()
    expect(stored(mem)).toMatchObject({
      filterTitle: 'first',
      crawlInterval: 3,
      filterMaxFiles: 5,
    })
    expect(dirty.size).toBe(0)
  })

  it('an unreadable store at save time is a failed save, not a blind write', async () => {
    const { fresh, set, blocked } = await setup({ crawlInterval: 4 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(chrome.storage.local, 'get').mockRejectedValue(new Error('gone'))

    fresh.set('filterTitle', 'x')
    await flush()

    expect(set).not.toHaveBeenCalled()
    expect(blocked).toEqual([{ reason: 'writeFailed' }])
  })

  it('a change made while a write is in flight stays dirty for the next one', async () => {
    const { fresh, set, mem } = await setup()
    let release!: () => void
    set.mockImplementationOnce((async (items: Record<string, unknown>) => {
      await new Promise<void>((r) => (release = r))
      Object.assign(mem, items)
    }) as never)

    fresh.set('filterTitle', 'a')
    await flush()
    fresh.set('filterTitle', 'b')
    release()
    await flush()
    await flush()

    expect(stored(mem).filterTitle).toBe('b')
  })

  it('parses an old export (no schemaVersion) against the current values', async () => {
    const { fresh, mod } = await setup()
    const parsed = mod.parseStoredSettings(
      { crawlInterval: 2, deduplication: false, skipExistingFiles: false },
      fresh.snapshot()
    )
    expect(parsed).toMatchObject({ crawlInterval: 2, skipDownloaded: 'none' })
  })
})
