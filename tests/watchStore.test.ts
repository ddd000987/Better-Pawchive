import { describe, expect, it, vi } from 'vitest'
import { UNSORTED_FOLDER_ID } from '../src/watch/watchTypes'

async function freshStore() {
  vi.resetModules()
  const mem: Record<string, any> = {}
  const changeListeners: Array<
    (changes: Record<string, { newValue?: unknown }>, area: string) => void
  > = []

  const get = vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {}))
  const set = vi.fn(async (obj: Record<string, any>) => {
    Object.assign(mem, obj)
  })

  const g = globalThis as any
  g.chrome = {
    ...(g.chrome ?? {}),
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (cb: any) => changeListeners.push(cb),
      },
    },
  }

  const mod = await import('../src/watch/watchStore')
  return {
    store: mod.watchStore,
    STORE_KEY: mod.STORE_KEY,
    mem,
    get,
    set,
    emitChange(key: string, newValue: unknown, area = 'local') {
      for (const cb of changeListeners) {
        cb({ [key]: { newValue } }, area)
      }
    },
  }
}

describe('watchStore', () => {
  it('adds, updates, moves, and removes creators', async () => {
    const { store } = await freshStore()
    await store.ready()

    const f1 = await store.addFolder('Favorites')
    const c1 = await store.addCreator({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '100',
      name: 'Alice',
    })
    expect(c1.folderId).toBe(UNSORTED_FOLDER_ID)
    expect(store.isWatched(c1.key)).toBe(true)
    expect(store.getCreator(c1.key)?.name).toBe('Alice')

    // Re-adding without folderId keeps folder and updates name
    await store.moveCreators([c1.key], f1.id)
    expect(store.getCreator(c1.key)?.folderId).toBe(f1.id)

    await store.addCreator({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '100',
      name: 'Alice Updated',
    })
    expect(store.getCreator(c1.key)?.folderId).toBe(f1.id)
    expect(store.getCreator(c1.key)?.name).toBe('Alice Updated')

    // Unknown folder move is a no-op
    await store.moveCreators([c1.key], 'does-not-exist')
    expect(store.getCreator(c1.key)?.folderId).toBe(f1.id)

    // updateCreator sets fields and null removes them
    await store.updateCreator(c1.key, {
      alias: 'Ali',
      note: 'Great artist',
      cover: { kind: 'post', path: '/a/b.png' },
    })
    expect(store.getCreator(c1.key)?.alias).toBe('Ali')
    expect(store.getCreator(c1.key)?.note).toBe('Great artist')
    expect(store.getCreator(c1.key)?.cover).toEqual({
      kind: 'post',
      path: '/a/b.png',
    })

    await store.updateCreator(c1.key, {
      alias: null,
      note: null,
      cover: null,
    })
    expect(store.getCreator(c1.key)?.alias).toBeUndefined()
    expect(store.getCreator(c1.key)?.note).toBeUndefined()
    expect(store.getCreator(c1.key)?.cover).toBeUndefined()

    await store.removeCreators([c1.key])
    expect(store.isWatched(c1.key)).toBe(false)
  })

  it('manages folders: add, rename, delete moves creators to unsorted, reorder', async () => {
    const { store } = await freshStore()
    await store.ready()

    await expect(store.addFolder('   ')).rejects.toThrow('empty folder name')

    const f1 = await store.addFolder('One')
    const f2 = await store.addFolder('Two')
    const f3 = await store.addFolder('Three')
    expect(f1.id.startsWith('f_')).toBe(true)
    expect(f2.order).toBe(f1.order + 1)

    await store.renameFolder(f1.id, '  First  ')
    expect(store.data.folders.find((f) => f.id === f1.id)?.name).toBe('First')

    // Renaming unsorted or empty name is no-op
    await store.renameFolder(UNSORTED_FOLDER_ID, 'Nope')
    await store.renameFolder(f1.id, '   ')
    expect(
      store.data.folders.find((f) => f.id === UNSORTED_FOLDER_ID)?.name
    ).toBe('')
    expect(store.data.folders.find((f) => f.id === f1.id)?.name).toBe('First')

    // Reorder puts given ids first and keeps remaining in relative order
    await store.reorderFolders([f3.id, f1.id])
    const orderMap = new Map(store.data.folders.map((f) => [f.id, f.order]))
    expect(orderMap.get(f3.id)).toBe(0)
    expect(orderMap.get(f1.id)).toBe(1)
    expect(orderMap.get(f2.id)!).toBeGreaterThan(orderMap.get(f1.id)!)

    // Delete folder moves its creators to unsorted; deleting unsorted is no-op
    const c = await store.addCreator(
      { site: 'kemono', service: 'fanbox', creatorId: '7', name: 'Seven' },
      f2.id
    )
    expect(store.getCreator(c.key)?.folderId).toBe(f2.id)

    await store.deleteFolder(f2.id)
    expect(store.data.folders.some((f) => f.id === f2.id)).toBe(false)
    expect(store.getCreator(c.key)?.folderId).toBe(UNSORTED_FOLDER_ID)

    await store.deleteFolder(UNSORTED_FOLDER_ID)
    expect(store.data.folders.some((f) => f.id === UNSORTED_FOLDER_ID)).toBe(
      true
    )
  })

  it('serializes concurrent mutate calls so both apply', async () => {
    const { store } = await freshStore()
    await store.ready()

    const p1 = store.mutate((draft) => {
      draft.folders.push({ id: 'a', name: 'A', order: 1, createdAt: 1 })
    })
    const p2 = store.mutate((draft) => {
      draft.folders.push({ id: 'b', name: 'B', order: 2, createdAt: 2 })
    })
    await Promise.all([p1, p2])

    const ids = store.data.folders.map((f) => f.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')
  })

  it('keeps memory unchanged and rejects when storage write fails', async () => {
    const { store, set } = await freshStore()
    await store.ready()

    const c1 = await store.addCreator({
      site: 'kemono',
      service: 'patreon',
      creatorId: '1',
      name: 'Kept',
    })

    set.mockRejectedValueOnce(new Error('quota exceeded'))
    await expect(
      store.addCreator({
        site: 'kemono',
        service: 'patreon',
        creatorId: '2',
        name: 'Lost',
      })
    ).rejects.toThrow('quota exceeded')

    expect(store.isWatched(c1.key)).toBe(true)
    expect(store.isWatched('kemono/patreon/2')).toBe(false)

    // Subsequent writes still work after a failed write
    const c3 = await store.addCreator({
      site: 'kemono',
      service: 'patreon',
      creatorId: '3',
      name: 'After',
    })
    expect(store.isWatched(c3.key)).toBe(true)
  })

  it('remembers hosts, skips unchanged writes, syncs onChanged, and supports replaceAll', async () => {
    const { store, STORE_KEY, set, emitChange } = await freshStore()
    await store.ready()

    expect(store.hostFor('kemono')).toBe('kemono.cr')
    expect(store.hostFor('pawchive')).toBe('pawchive.pw')

    await store.rememberHost('example.com')
    expect(set).not.toHaveBeenCalled()

    await store.rememberHost('kemono.su')
    expect(store.hostFor('kemono')).toBe('kemono.su')
    expect(set).toHaveBeenCalledTimes(1)

    // Unchanged host skips write
    await store.rememberHost('kemono.su')
    expect(set).toHaveBeenCalledTimes(1)

    const onChange = vi.fn()
    const unsub = store.onChange(onChange)
    emitChange(STORE_KEY, {
      version: 1,
      folders: [{ id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 }],
      creators: {},
      hosts: { kemono: 'kemono.party' },
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(store.hostFor('kemono')).toBe('kemono.party')

    unsub()
    await store.replaceAll({ hosts: { pawchive: 'www.pawchive.pw' } })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(store.hostFor('pawchive')).toBe('www.pawchive.pw')
    expect(store.hostFor('kemono')).toBe('kemono.cr')
  })

  it('enables, updates via applyCheckResults, marks read, and disables tracking', async () => {
    const { store, set } = await freshStore()
    await store.ready()

    const makePost = (id: string, published: string) => ({
      id,
      user: '100',
      service: 'patreon' as const,
      title: `Post ${id}`,
      published,
      file: { path: `/img/${id}.png` },
      attachments: [],
    })

    // enableTracking adds unwatched creator to unsorted and initializes baseline
    await store.enableTracking(
      { site: 'pawchive', service: 'patreon', creatorId: '100', name: 'Alice' },
      [makePost('p1', '2025-01-01T00:00:00')]
    )
    const key = 'pawchive/patreon/100'
    expect(store.isWatched(key)).toBe(true)
    expect(store.getCreator(key)?.folderId).toBe(UNSORTED_FOLDER_ID)
    expect(store.getCreator(key)?.tracking?.enabled).toBe(true)
    expect(store.getCreator(key)?.tracking?.baselinePublished).toBe(
      '2025-01-01T00:00:00'
    )

    // Add a second creator with tracking, and a third without tracking
    await store.enableTracking(
      { site: 'pawchive', service: 'patreon', creatorId: '200', name: 'Bob' },
      [makePost('b1', '2025-01-01T00:00:00')]
    )
    const key2 = 'pawchive/patreon/200'
    const c3 = await store.addCreator({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '300',
      name: 'Untracked',
    })

    const callsBefore = set.mock.calls.length
    const added = await store.applyCheckResults(
      [
        {
          key,
          name: 'Alice Renamed',
          items: [
            makePost('p3', '2025-01-03T00:00:00'),
            makePost('p2', '2025-01-02T00:00:00'),
            makePost('p1', '2025-01-01T00:00:00'),
          ],
        },
        { key: key2, error: 'not found' },
        { key: c3.key, items: [makePost('u1', '2025-01-05T00:00:00')] },
        { key: 'pawchive/patreon/missing', error: 'gone' },
      ],
      5000
    )

    // Whole batch uses ONE mutate (one storage.local.set call)
    expect(set.mock.calls.length - callsBefore).toBe(1)
    expect(added.map((p) => p.id)).toEqual(['p3', 'p2'])
    expect(store.getCreator(key)?.name).toBe('Alice Renamed')
    expect(store.getCreator(key)?.tracking?.unread.map((p) => p.id)).toEqual([
      'p3',
      'p2',
    ])
    expect(store.getCreator(key2)?.tracking?.lastError).toBe('not found')
    expect(store.getCreator(key2)?.tracking?.lastCheckedAt).toBe(5000)
    expect(store.getCreator(c3.key)?.tracking).toBeUndefined()

    // markPostsRead removes specific posts
    await store.markPostsRead(key, ['p2'])
    expect(store.getCreator(key)?.tracking?.unread.map((p) => p.id)).toEqual([
      'p3',
    ])

    // markRead clears remaining unread and overflow
    await store.markRead([key, c3.key])
    expect(store.getCreator(key)?.tracking?.unread).toEqual([])
    expect(store.getCreator(key)?.tracking?.overflow).toBeUndefined()

    // disableTracking removes tracking field
    await store.disableTracking([key, key2])
    expect(store.getCreator(key)?.tracking).toBeUndefined()
    expect(store.getCreator(key2)?.tracking).toBeUndefined()
  })
})
