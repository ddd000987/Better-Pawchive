import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only downloads are tested here; the folder and image window services add
// their own onMessage listeners, so they are left out to keep the indices
vi.mock('../src/folder/folderService', () => ({}))
vi.mock('../src/viewer/viewerService', () => ({}))

type Listener = (...args: any[]) => any

function makeChrome(
  storageData: Record<string, any>,
  downloadImpl: () => Promise<number>
) {
  const listeners: Record<string, Listener[]> = {
    action: [],
    installed: [],
    message: [],
    changed: [],
  }
  const chrome = {
    action: {
      onClicked: {
        addListener: (fn: Listener) => listeners.action.push(fn),
      },
    },
    runtime: {
      id: 'ext-id',
      getURL: vi.fn((path: string) => `chrome-extension://ext-id/${path}`),
      onInstalled: {
        addListener: (fn: Listener) => listeners.installed.push(fn),
      },
      onMessage: {
        addListener: (fn: Listener) => listeners.message.push(fn),
      },
      sendMessage: vi.fn(async () => {}),
    },
    downloads: {
      download: vi.fn(downloadImpl),
      onChanged: {
        addListener: (fn: Listener) => listeners.changed.push(fn),
      },
    },
    tabs: {
      create: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => {}),
      get: vi.fn(async () => ({})),
    },
    storage: {
      local: {
        get: vi.fn(async () => storageData),
        set: vi.fn(async () => {}),
      },
    },
  }
  return { chrome, listeners }
}

describe('background save_work_file', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  it('idList 缺失時仍可建立下載（不拋錯）', async () => {
    const { chrome, listeners } = makeChrome(
      { batchNo: { 1: 5 }, idList: {} },
      async () => 1
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')

    listeners.message[0](
      {
        msg: 'save_work_file',
        id: 'a',
        taskBatch: 5,
        blobURL: 'blob:x',
        fileName: 'f',
      },
      { id: 'ext-id', tab: { id: 1 } }
    )

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledTimes(1)
    })
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('downloads.download 失敗時回報 download_err', async () => {
    const { chrome, listeners } = makeChrome(
      { batchNo: { 1: 5 }, idList: { 1: [] } },
      async () => {
        throw new Error('boom')
      }
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')

    listeners.message[0](
      {
        msg: 'save_work_file',
        id: 'a',
        taskBatch: 5,
        blobURL: 'blob:x',
        fileName: 'f',
      },
      { id: 'ext-id', tab: { id: 1 } }
    )

    await vi.waitFor(() => {
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1)
    })
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ msg: 'download_err', saveRequestFailed: true })
    )
  })

  it('快下不會覆寫主下載的批次與 idList', async () => {
    const { chrome, listeners } = makeChrome(
      { batchNo: {}, idList: {} },
      async () => 1
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')

    const send = (msg: Record<string, unknown>) =>
      listeners.message[0](msg, { id: 'ext-id', tab: { id: 1 } })
    const main = {
      msg: 'save_work_file',
      id: 'a',
      taskBatch: 1700000000000,
      blobURL: 'blob:a',
      fileName: 'a',
    }

    send(main)
    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledTimes(1)
    })

    send({
      msg: 'save_work_file',
      id: 'q',
      taskBatch: 1,
      channel: 'quick',
      blobURL: 'blob:q',
      fileName: 'q',
    })
    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledTimes(2)
    })

    // 主下載重複 id：快下清空過 idList 的話這裡會多下一次
    send({ ...main, blobURL: 'blob:a2' })
    await new Promise((r) => setTimeout(r, 10))
    expect(chrome.downloads.download).toHaveBeenCalledTimes(2)
  })
})

describe('background query_saving', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  // Fresh records are never pruned at startup, so these tests see them as-is
  const rec = (extra: Record<string, unknown>) => ({
    tabId: 1,
    taskBatch: 7,
    uuid: false,
    t: Date.now(),
    ...extra,
  })

  /** Load the worker with the given dlData; `states` maps download id → state */
  async function load(
    dlData: Record<string, any>,
    states: Record<string, string>
  ) {
    const { chrome, listeners } = makeChrome(
      { batchNo: {}, idList: {}, dlData },
      async () => 1
    )
    ;(chrome.downloads as any).search = vi.fn(async (q: { id: number }) =>
      states[q.id] ? [{ id: q.id, state: states[q.id] }] : []
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    // The save handler is registered first, the query handler second
    expect(listeners.message).toHaveLength(2)
    return { chrome, listeners }
  }

  /** Ask the second listener; resolves with whatever it passes to sendResponse */
  function ask(listener: Listener, msg: unknown, sender: unknown) {
    return new Promise<any>((resolve) => {
      const keepOpen = listener(msg, sender, resolve)
      // A handler that answers later must say so by returning true
      if (keepOpen !== true) resolve('not-async')
    })
  }

  it('returns only this tab’s in-progress downloads among the requested ids', async () => {
    const { listeners } = await load(
      {
        10: rec({ id: 'a', taskBatch: 7 }),
        11: rec({ id: 'b' }), // completed
        12: rec({ id: 'c' }), // interrupted
        13: rec({ id: 'd', tabId: 2 }), // another tab
        15: rec({ id: 'f' }), // not requested
        16: rec({ id: 'g' }), // browser no longer knows the download
      },
      {
        10: 'in_progress',
        11: 'complete',
        12: 'interrupted',
        13: 'in_progress',
        15: 'in_progress',
      }
    )

    const reply = await ask(
      listeners.message[1],
      { msg: 'query_saving', ids: ['a', 'b', 'c', 'd', 'g'] },
      { id: 'ext-id', tab: { id: 1 } }
    )
    expect(reply).toEqual({ saving: [{ id: 'a', taskBatch: 7 }] })
  })

  it('reports each batch of the same id', async () => {
    const { listeners } = await load(
      {
        10: rec({ id: 'a', taskBatch: 7 }),
        11: rec({ id: 'a', taskBatch: 8 }),
      },
      { 10: 'in_progress', 11: 'in_progress' }
    )
    const reply = await ask(
      listeners.message[1],
      { msg: 'query_saving', ids: ['a'] },
      { id: 'ext-id', tab: { id: 1 } }
    )
    expect(reply.saving).toEqual([
      { id: 'a', taskBatch: 7 },
      { id: 'a', taskBatch: 8 },
    ])
  })

  it.each([
    [
      'ids is missing',
      { msg: 'query_saving' },
      { id: 'ext-id', tab: { id: 1 } },
    ],
    [
      'ids is not an array',
      { msg: 'query_saving', ids: 'a' },
      { id: 'ext-id', tab: { id: 1 } },
    ],
    [
      'ids holds a non-string',
      { msg: 'query_saving', ids: ['a', 3] },
      { id: 'ext-id', tab: { id: 1 } },
    ],
    [
      'the sender has no tab',
      { msg: 'query_saving', ids: ['a'] },
      { id: 'ext-id' },
    ],
  ])('answers an empty list when %s', async (_name, msg, sender) => {
    const { listeners, chrome } = await load(
      { 10: rec({ id: 'a' }) },
      { 10: 'in_progress' }
    )
    const reply = await ask(listeners.message[1], msg, sender)
    expect(reply).toEqual({ saving: [] })
    expect((chrome.downloads as any).search).not.toHaveBeenCalled()
  })

  it('answers an empty list when the downloads search fails', async () => {
    const { listeners, chrome } = await load(
      { 10: rec({ id: 'a' }) },
      { 10: 'in_progress' }
    )
    ;(chrome.downloads as any).search = vi.fn(async () => {
      throw new Error('boom')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reply = await ask(
      listeners.message[1],
      { msg: 'query_saving', ids: ['a'] },
      { id: 'ext-id', tab: { id: 1 } }
    )
    expect(reply).toEqual({ saving: [] })
  })

  it('ignores other messages and the save handler ignores this one', async () => {
    const { listeners, chrome } = await load({}, {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendResponse = vi.fn()

    expect(
      listeners.message[1](
        { msg: 'save_work_file' },
        { id: 'ext-id', tab: { id: 1 } },
        sendResponse
      )
    ).toBe(false)
    expect(sendResponse).not.toHaveBeenCalled()

    const result = listeners.message[0](
      { msg: 'query_saving', ids: ['a'] },
      { id: 'ext-id', tab: { id: 1 } }
    )
    expect(result).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(warn).not.toHaveBeenCalled()
    expect(chrome.downloads.download).not.toHaveBeenCalled()
  })
})

describe('background dlData pruning', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  const old = (extra: Record<string, unknown>) => ({
    tabId: 1,
    taskBatch: 7,
    uuid: false,
    ...extra,
  })

  /** Load the worker; resolves with the dlData keys of the last save */
  async function loadAndSettle(
    dlData: Record<string, any>,
    states: Record<string, string | Error>,
    goneTabs: number[] = []
  ) {
    const { chrome, listeners } = makeChrome(
      { batchNo: {}, idList: {}, dlData },
      async () => 1
    )
    ;(chrome.tabs as any).get = vi.fn(async (id: number) => {
      if (goneTabs.includes(id)) throw new Error('No tab with id')
      return {}
    })
    ;(chrome.downloads as any).search = vi.fn(async (q: { id: number }) => {
      const s = states[q.id]
      if (s instanceof Error) throw s
      return s ? [{ id: q.id, state: s }] : []
    })
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    // Startup cleanup runs in the background: let it finish
    await new Promise((r) => setTimeout(r, 20))
    const saves = (chrome.storage.local.set as any).mock.calls
      .map((c: any[]) => c[0])
      .filter((o: any) => 'dlData' in o)
    const last = saves[saves.length - 1]
    return {
      chrome,
      listeners,
      saved: last ? Object.keys(last.dlData).sort() : null,
    }
  }

  it('drops entries whose tab is gone or whose download is no longer in progress', async () => {
    const { saved } = await loadAndSettle(
      {
        10: old({ id: 'a' }), // still downloading: kept
        11: old({ id: 'b' }), // finished while no event reached us: dropped
        12: old({ id: 'c', tabId: 9 }), // tab closed: dropped
        13: old({ id: 'd' }), // the browser forgot the download: dropped
      },
      { 10: 'in_progress', 11: 'complete', 12: 'in_progress' },
      [9]
    )
    expect(saved).toEqual(['10'])
  })

  it('keeps recent entries even when the browser does not report them yet', async () => {
    const { saved, chrome } = await loadAndSettle(
      {
        10: old({ id: 'a', t: Date.now() }),
        11: old({ id: 'b', tabId: 9, t: Date.now() }),
      },
      {},
      [9]
    )
    // Nothing to prune: no save and no lookups for them
    expect(saved).toBeNull()
    expect((chrome.downloads as any).search).not.toHaveBeenCalled()
  })

  it('keeps an entry when its state cannot be read', async () => {
    const { saved } = await loadAndSettle(
      {
        10: old({ id: 'a' }),
        11: old({ id: 'b' }),
      },
      { 10: new Error('search failed'), 11: 'complete' }
    )
    expect(saved).toEqual(['10'])
  })

  it('asks the browser about a tab only once', async () => {
    const { chrome } = await loadAndSettle(
      { 10: old({ id: 'a' }), 11: old({ id: 'b' }), 12: old({ id: 'c' }) },
      { 10: 'in_progress', 11: 'in_progress', 12: 'in_progress' }
    )
    // idList is empty, so only the prune asks
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1)
  })
})

describe('background save results', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  async function load(rec: Record<string, unknown>) {
    const { chrome, listeners } = makeChrome(
      {
        batchNo: {},
        idList: {},
        dlData: {
          20: { tabId: 1, taskBatch: 7, uuid: false, t: Date.now(), ...rec },
        },
      },
      async () => 1
    )
    ;(chrome.downloads as any).search = vi.fn(async () => [])
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    return { chrome, listeners }
  }

  const finish = async (
    listeners: Record<string, Listener[]>,
    name: string
  ) => {
    await listeners.changed[0]({ id: 20, filename: { current: name } })
    await listeners.changed[0]({ id: 20, state: { current: 'complete' } })
  }

  const sentData = (chrome: any) => chrome.tabs.sendMessage.mock.calls[0][1]

  it('flags a file saved under a random UUID name we did not ask for', async () => {
    const { chrome, listeners } = await load({
      id: 'a',
      requestedName: 'kemono/p/1-a.png',
    })
    await finish(
      listeners,
      'C:\\Users\\u\\Downloads\\3f2c1a9e-1b2c-4d5e-8f90-123456789abc.png'
    )
    expect(sentData(chrome)).toMatchObject({
      msg: 'downloaded',
      data: { id: 'a', uuid: true },
    })
  })

  it('does not flag the name we asked for, nor an ordinary rename', async () => {
    let t = await load({ id: 'a', requestedName: 'kemono/p/1-a.png' })
    await finish(t.listeners, '/home/u/Downloads/kemono/p/1-a (1).png')
    expect(sentData(t.chrome).data.uuid).toBe(false)

    vi.resetModules()
    // The post's own file is named like a UUID and was requested that way
    t = await load({
      id: 'a',
      requestedName: 'kemono/p/3f2c1a9e-1b2c-4d5e-8f90-123456789abc.png',
    })
    await finish(
      t.listeners,
      '/home/u/Downloads/kemono/p/3f2c1a9e-1b2c-4d5e-8f90-123456789abc.png'
    )
    expect(sentData(t.chrome).data.uuid).toBe(false)
  })

  it('no longer handles no_reply / save_description_file', async () => {
    const { chrome, listeners } = await load({ id: 'a' })
    for (const msg of ['no_reply', 'save_description_file']) {
      listeners.message[0](
        { msg, id: 'x', blobURL: 'blob:x', fileName: 'f' },
        { id: 'ext-id', tab: { id: 1 } }
      )
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(chrome.downloads.download).not.toHaveBeenCalled()
  })
})

describe('background save_work_file request checks', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  const sender = { id: 'ext-id', tab: { id: 1 } }
  const valid = {
    msg: 'save_work_file',
    id: 'a',
    taskBatch: 5,
    blobURL: 'blob:https://kemono.su/1234',
    fileName: 'kemono/patreon/a/1-file.png',
  }

  async function setup() {
    const { chrome, listeners } = makeChrome(
      { batchNo: { 1: 5 }, idList: { 1: [] } },
      async () => 1
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    return { chrome, listeners }
  }

  it('ignores a message that does not come from this extension', async () => {
    const { chrome, listeners } = await setup()

    const foreign = listeners.message[0](valid, { id: 'other', tab: { id: 1 } })
    const anonymous = listeners.message[0](valid, { tab: { id: 1 } })
    await new Promise((r) => setTimeout(r, 10))

    expect(foreign).toBe(false)
    expect(anonymous).toBe(false)
    expect(chrome.downloads.download).not.toHaveBeenCalled()
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('also ignores a foreign sender on clearDownloadsTempData and query_saving', async () => {
    const { chrome, listeners } = await setup()
    const respond = vi.fn()

    listeners.message[0](
      { msg: 'clearDownloadsTempData' },
      { id: 'other', tab: { id: 1 } }
    )
    const keep = listeners.message[1](
      { msg: 'query_saving', ids: ['a'] },
      { id: 'other', tab: { id: 1 } },
      respond
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(keep).toBe(false)
    expect(respond).not.toHaveBeenCalled()
    // The batch of tab 1 was not wiped
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ idList: {} })
    )
  })

  it.each([
    ['an http URL', { blobURL: undefined, url: 'http://kemono.su/a.png' }],
    ['a file: URL', { blobURL: undefined, url: 'file:///etc/passwd' }],
    ['a javascript: URL', { blobURL: undefined, url: 'javascript:alert(1)' }],
    ['an unparseable URL', { blobURL: undefined, url: 'not a url' }],
    ['no URL at all', { blobURL: undefined }],
    ['an empty file name', { fileName: '' }],
    ['a blank file name', { fileName: '   ' }],
    ['a non-string file name', { fileName: 42 }],
    ['a leading slash', { fileName: '/etc/x' }],
    ['a leading backslash', { fileName: '\\Windows\\x' }],
    ['a ".." segment', { fileName: 'a/../../b' }],
    ['a ".." segment with backslashes', { fileName: 'a\\..\\b' }],
  ])('rejects %s with a download_err reply', async (_name, patch) => {
    const { chrome, listeners } = await setup()

    listeners.message[0]({ ...valid, ...patch }, sender)

    await vi.waitFor(() => {
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1)
    })
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        msg: 'download_err',
        saveRequestFailed: true,
        data: expect.objectContaining({ id: 'a', tabId: 1, taskBatch: 5 }),
      })
    )
    expect(chrome.downloads.download).not.toHaveBeenCalled()
  })

  it.each([
    ['an https URL', { blobURL: undefined, url: 'https://kemono.su/a.png' }],
    ['a data URL', { blobURL: undefined, dataURL: 'data:text/plain,hi' }],
    ['a blob URL', {}],
    ['a name that merely contains dots', { fileName: 'a..b/c...d.txt' }],
  ])('accepts %s', async (_name, patch) => {
    const { chrome, listeners } = await setup()

    listeners.message[0]({ ...valid, ...patch }, sender)

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledTimes(1)
    })
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    [undefined, 'uniquify'],
    ['uniquify', 'uniquify'],
    ['overwrite', 'overwrite'],
    ['prompt', 'uniquify'],
    ['bogus', 'uniquify'],
  ])('conflictAction %s is passed on as %s', async (given, expected) => {
    const { chrome, listeners } = await setup()

    listeners.message[0]({ ...valid, conflictAction: given }, sender)

    await vi.waitFor(() => {
      expect(chrome.downloads.download).toHaveBeenCalledTimes(1)
    })
    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ conflictAction: expected })
    )
  })
})

describe('background watchlist navigation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  async function setup() {
    const { chrome, listeners } = makeChrome(
      { batchNo: {}, idList: {} },
      async () => 1
    )
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    return { chrome, listeners }
  }

  it('opens the watch page when action is clicked without tab.url', async () => {
    const { chrome, listeners } = await setup()

    listeners.action[0]({ id: 5 })

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://ext-id/watch.html',
    })
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it('opens the watch page when action is clicked on a non-supported site', async () => {
    const { chrome, listeners } = await setup()

    listeners.action[0]({ id: 5, url: 'https://example.com/page' })

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://ext-id/watch.html',
    })
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['kemono.cr', 'https://kemono.cr/patreon/user/123'],
    ['pawchive.pw', 'https://pawchive.pw/fanbox/user/456'],
  ])('sends click_icon when action is clicked on %s', async (_host, url) => {
    const { chrome, listeners } = await setup()

    listeners.action[0]({ id: 7, url })

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      msg: 'click_icon',
    })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it('opens the watch page on watch_open from a content script or extension page', async () => {
    const { chrome, listeners } = await setup()

    listeners.message[0](
      { msg: 'watch_open' },
      { id: 'ext-id', tab: { id: 1 } }
    )
    listeners.message[0]({ msg: 'watch_open' }, { id: 'ext-id' })

    expect(chrome.tabs.create).toHaveBeenCalledTimes(2)
    expect(chrome.tabs.create).toHaveBeenNthCalledWith(1, {
      url: 'chrome-extension://ext-id/watch.html',
    })
    expect(chrome.tabs.create).toHaveBeenNthCalledWith(2, {
      url: 'chrome-extension://ext-id/watch.html',
    })
  })

  it('ignores watch_open from foreign or anonymous senders', async () => {
    const { chrome, listeners } = await setup()

    listeners.message[0](
      { msg: 'watch_open' },
      { id: 'other-ext', tab: { id: 1 } }
    )
    listeners.message[0]({ msg: 'watch_open' }, { tab: { id: 1 } })

    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it.each(['#/feed', '#/updates', '#/creator/kemono%2Fpatreon%2F1'])(
    'appends valid watch_open hash %s to watch.html URL',
    async (hash) => {
      const { chrome, listeners } = await setup()

      listeners.message[0](
        { msg: 'watch_open', hash },
        { id: 'ext-id', tab: { id: 1 } }
      )

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: `chrome-extension://ext-id/watch.html${hash}`,
      })
    }
  )

  it.each([
    'javascript:alert(1)',
    'https://evil.example/#/',
    '#feed',
    '#/feed?foo=1',
    '#/feed#extra',
    123,
  ])('ignores invalid watch_open hash %s', async (hash) => {
    const { chrome, listeners } = await setup()

    listeners.message[0](
      { msg: 'watch_open', hash },
      { id: 'ext-id', tab: { id: 1 } }
    )

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://ext-id/watch.html',
    })
  })
})

describe('background watchlist unread badge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any)
  })

  function makeWatchDataWithUnread(count: number) {
    const creators: Record<string, any> = {}
    let remaining = count
    let idx = 0
    while (remaining > 0) {
      const take = Math.min(remaining, 500)
      const id = String(++idx)
      const key = `kemono/patreon/${id}`
      creators[key] = {
        key,
        site: 'kemono',
        service: 'patreon',
        creatorId: id,
        name: `Creator ${id}`,
        folderId: 'unsorted',
        addedAt: 1,
        tracking: {
          enabled: true,
          since: 1,
          baselinePublished: '2026-01-01',
          seenIds: [],
          unread: Array.from({ length: take }, (_, i) => ({
            id: `p_${idx}_${i}`,
            title: `Post ${i}`,
            published: '2026-01-02',
          })),
        },
      }
      remaining -= take
    }
    return {
      version: 1,
      folders: [{ id: 'unsorted', name: '', order: 0, createdAt: 0 }],
      creators,
      hosts: {},
    }
  }

  async function setupBadge(initialWatch?: unknown) {
    const storageListeners: Listener[] = []
    const { chrome } = makeChrome(
      {
        batchNo: {},
        idList: {},
        ...(initialWatch !== undefined
          ? { pawchiveProWatchlist: initialWatch }
          : {}),
      },
      async () => 1
    )
    ;(chrome.action as any).setBadgeText = vi.fn(async () => {})
    ;(chrome.action as any).setBadgeBackgroundColor = vi.fn(async () => {})
    ;(chrome.storage as any).onChanged = {
      addListener: (fn: Listener) => storageListeners.push(fn),
    }
    ;(globalThis as any).chrome = chrome
    await import('../src/background')
    await vi.waitFor(() => {
      expect((chrome.action as any).setBadgeText).toHaveBeenCalled()
    })
    return { chrome, storageListeners }
  }

  it.each([
    [0, ''],
    [5, '5'],
    [1200, '999+'],
  ])(
    'sets badge text on startup for %i unread posts -> %j',
    async (count, expected) => {
      const { chrome } = await setupBadge(makeWatchDataWithUnread(count))
      expect((chrome.action as any).setBadgeText).toHaveBeenCalledWith({
        text: expected,
      })
      if (count > 0) {
        expect(
          (chrome.action as any).setBadgeBackgroundColor
        ).toHaveBeenCalledWith({ color: '#e5484d' })
      }
    }
  )

  it('updates badge text when watchlist changes in storage.local', async () => {
    const { chrome, storageListeners } = await setupBadge(
      makeWatchDataWithUnread(0)
    )
    expect((chrome.action as any).setBadgeText).toHaveBeenLastCalledWith({
      text: '',
    })

    storageListeners[0](
      {
        pawchiveProWatchlist: {
          newValue: makeWatchDataWithUnread(5),
        },
      },
      'local'
    )
    expect((chrome.action as any).setBadgeText).toHaveBeenLastCalledWith({
      text: '5',
    })

    storageListeners[0](
      {
        pawchiveProWatchlist: {
          newValue: makeWatchDataWithUnread(1200),
        },
      },
      'local'
    )
    expect((chrome.action as any).setBadgeText).toHaveBeenLastCalledWith({
      text: '999+',
    })
  })
})
