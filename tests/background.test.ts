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
      { tab: { id: 1 } }
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
      { tab: { id: 1 } }
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
      listeners.message[0](msg, { tab: { id: 1 } })
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

  const rec = (extra: Record<string, unknown>) => ({
    tabId: 1,
    taskBatch: 7,
    uuid: false,
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
        14: rec({ id: 'e', noReply: true }), // text file, no reply
        15: rec({ id: 'f' }), // not requested
        16: rec({ id: 'g' }), // browser no longer knows the download
      },
      {
        10: 'in_progress',
        11: 'complete',
        12: 'interrupted',
        13: 'in_progress',
        14: 'in_progress',
        15: 'in_progress',
      }
    )

    const reply = await ask(
      listeners.message[1],
      { msg: 'query_saving', ids: ['a', 'b', 'c', 'd', 'e', 'g'] },
      { tab: { id: 1 } }
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
      { tab: { id: 1 } }
    )
    expect(reply.saving).toEqual([
      { id: 'a', taskBatch: 7 },
      { id: 'a', taskBatch: 8 },
    ])
  })

  it.each([
    ['ids is missing', { msg: 'query_saving' }, { tab: { id: 1 } }],
    [
      'ids is not an array',
      { msg: 'query_saving', ids: 'a' },
      { tab: { id: 1 } },
    ],
    [
      'ids holds a non-string',
      { msg: 'query_saving', ids: ['a', 3] },
      { tab: { id: 1 } },
    ],
    ['the sender has no tab', { msg: 'query_saving', ids: ['a'] }, {}],
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
      { tab: { id: 1 } }
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
        { tab: { id: 1 } },
        sendResponse
      )
    ).toBe(false)
    expect(sendResponse).not.toHaveBeenCalled()

    const result = listeners.message[0](
      { msg: 'query_saving', ids: ['a'] },
      { tab: { id: 1 } }
    )
    expect(result).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(warn).not.toHaveBeenCalled()
    expect(chrome.downloads.download).not.toHaveBeenCalled()
  })
})
