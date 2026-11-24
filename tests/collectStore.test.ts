import { describe, expect, it, vi } from 'vitest'
import { FAV_IMAGES_KEY, FAV_POSTS_KEY } from '../src/watch/collectTypes'
import { UNSORTED_FOLDER_ID } from '../src/watch/watchTypes'

async function freshStores() {
  vi.resetModules()
  const mem: Record<string, unknown> = {}
  const changeListeners: Array<
    (changes: Record<string, { newValue?: unknown }>, area: string) => void
  > = []

  const get = vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {}))
  const set = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(mem, obj)
  })

  const g = globalThis as unknown as { chrome?: unknown }
  g.chrome = {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (
          cb: (
            changes: Record<string, { newValue?: unknown }>,
            area: string
          ) => void
        ) => changeListeners.push(cb),
      },
    },
  }

  const mod = await import('../src/watch/collectStore')
  return {
    favPosts: mod.favPosts,
    favImages: mod.favImages,
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

describe('CollectStore', () => {
  it('adds items, refreshes descriptive fields on re-add while keeping labels/note/addedAt', async () => {
    const { favPosts } = await freshStores()
    await favPosts.ready()

    const f1 = await favPosts.addFolder('Best')
    const p1 = await favPosts.add({
      key: 'pawchive/patreon/1/10',
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
      title: 'Old Title',
      creatorName: 'Alice',
    })
    expect(p1.folderId).toBe(UNSORTED_FOLDER_ID)
    expect(favPosts.has(p1.key)).toBe(true)

    await favPosts.update(p1.key, {
      rating: 5,
      tags: ['Great', 'Art'],
      note: 'My note',
    })
    await favPosts.move([p1.key], f1.id)
    const originalAddedAt = favPosts.get(p1.key)!.addedAt

    // Re-add without folderId keeps folder, labels, note, addedAt, and refreshes title/coverPath
    const refreshed = await favPosts.add({
      key: 'pawchive/patreon/1/10',
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
      title: 'New Title',
      coverPath: '/5a/48/5a48abcd.jpeg',
      creatorName: 'Alice V2',
    })
    expect(refreshed.title).toBe('New Title')
    expect(refreshed.coverPath).toBe('/5a/48/5a48abcd.jpeg')
    expect(refreshed.creatorName).toBe('Alice V2')
    expect(refreshed.folderId).toBe(f1.id)
    expect(refreshed.rating).toBe(5)
    expect(refreshed.tags).toEqual(['Great', 'Art'])
    expect(refreshed.note).toBe('My note')
    expect(refreshed.addedAt).toBe(originalAddedAt)
  })

  it('supports move, remove, folders (delete moves to unsorted), reorder, and itemsInFolder', async () => {
    const { favPosts } = await freshStores()
    await favPosts.ready()

    await expect(favPosts.addFolder('   ')).rejects.toThrow('empty folder name')
    const f1 = await favPosts.addFolder('One')
    const f2 = await favPosts.addFolder('Two')
    expect(f1.id.startsWith('f_')).toBe(true)

    await favPosts.renameFolder(f1.id, '  First  ')
    await favPosts.renameFolder(UNSORTED_FOLDER_ID, 'Nope')
    expect(favPosts.data.folders.find((f) => f.id === f1.id)?.name).toBe(
      'First'
    )
    expect(
      favPosts.data.folders.find((f) => f.id === UNSORTED_FOLDER_ID)?.name
    ).toBe('')

    await favPosts.reorderFolders([f2.id, f1.id])
    const orderMap = new Map(favPosts.data.folders.map((f) => [f.id, f.order]))
    expect(orderMap.get(f2.id)).toBe(0)
    expect(orderMap.get(f1.id)).toBe(1)

    await favPosts.add(
      {
        key: 'pawchive/patreon/1/1',
        site: 'pawchive',
        service: 'patreon',
        creatorId: '1',
        postId: '1',
        title: 'First',
        creatorName: 'A',
      },
      f1.id
    )
    await favPosts.mutate((d) => {
      d.items['pawchive/patreon/1/1'].addedAt = 100
    })
    await favPosts.add(
      {
        key: 'pawchive/patreon/1/2',
        site: 'pawchive',
        service: 'patreon',
        creatorId: '1',
        postId: '2',
        title: 'Second',
        creatorName: 'A',
      },
      f1.id
    )
    await favPosts.mutate((d) => {
      d.items['pawchive/patreon/1/2'].addedAt = 200
    })

    // itemsInFolder sorted by addedAt desc
    expect(favPosts.itemsInFolder(f1.id).map((i) => i.postId)).toEqual([
      '2',
      '1',
    ])

    // Unknown folder move is no-op
    await favPosts.move(['pawchive/patreon/1/1'], 'nope')
    expect(favPosts.get('pawchive/patreon/1/1')?.folderId).toBe(f1.id)

    // Delete folder moves items to unsorted; deleting unsorted is no-op
    await favPosts.deleteFolder(f1.id)
    expect(favPosts.get('pawchive/patreon/1/1')?.folderId).toBe(
      UNSORTED_FOLDER_ID
    )
    expect(favPosts.get('pawchive/patreon/1/2')?.folderId).toBe(
      UNSORTED_FOLDER_ID
    )

    await favPosts.deleteFolder(UNSORTED_FOLDER_ID)
    expect(favPosts.data.folders.some((f) => f.id === UNSORTED_FOLDER_ID)).toBe(
      true
    )

    await favPosts.remove(['pawchive/patreon/1/1'])
    expect(favPosts.has('pawchive/patreon/1/1')).toBe(false)
  })

  it('supports update and updateMany bulk patches', async () => {
    const { favImages } = await freshStores()
    await favImages.ready()

    const k1 = 'pawchive/5a/48/5a480001.jpeg'
    const k2 = 'pawchive/5a/48/5a480002.jpeg'
    await favImages.add({
      key: k1,
      site: 'pawchive',
      path: '/5a/48/5a480001.jpeg',
      service: 'patreon',
      creatorId: '1',
      postId: '1',
    })
    await favImages.add({
      key: k2,
      site: 'pawchive',
      path: '/5a/48/5a480002.jpeg',
      service: 'patreon',
      creatorId: '1',
      postId: '2',
    })

    await favImages.update(k1, {
      rating: 3,
      tags: ['Alpha', 'Beta'],
      note: 'n',
    })
    await favImages.update(k1, { note: null })
    expect(favImages.get(k1)?.note).toBeUndefined()

    await favImages.updateMany([k1, k2], {
      addTags: ['beta', 'Gamma'],
      removeTags: ['alpha'],
      rating: 4,
    })
    expect(favImages.get(k1)?.tags).toEqual(['Beta', 'Gamma'])
    expect(favImages.get(k1)?.rating).toBe(4)
    expect(favImages.get(k2)?.tags).toEqual(['beta', 'Gamma'])
    expect(favImages.get(k2)?.rating).toBe(4)

    await favImages.updateMany([k1], { rating: null })
    expect(favImages.get(k1)?.rating).toBeUndefined()
  })

  it('serializes concurrent mutate calls and syncs onChanged only for its own storage key', async () => {
    const { favPosts, favImages, emitChange } = await freshStores()
    await favPosts.ready()
    await favImages.ready()

    const p1 = favPosts.mutate((draft) => {
      draft.folders.push({ id: 'a', name: 'A', order: 1, createdAt: 1 })
    })
    const p2 = favPosts.mutate((draft) => {
      draft.folders.push({ id: 'b', name: 'B', order: 2, createdAt: 2 })
    })
    await Promise.all([p1, p2])
    const ids = favPosts.data.folders.map((f) => f.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')

    const onPosts = vi.fn()
    const onImages = vi.fn()
    favPosts.onChange(onPosts)
    favImages.onChange(onImages)

    emitChange(FAV_POSTS_KEY, {
      version: 1,
      folders: [{ id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 }],
      items: {},
    })
    expect(onPosts).toHaveBeenCalledTimes(1)
    expect(onImages).not.toHaveBeenCalled()

    emitChange(FAV_IMAGES_KEY, {
      version: 1,
      folders: [{ id: UNSORTED_FOLDER_ID, name: '', order: 0, createdAt: 0 }],
      items: {},
    })
    expect(onPosts).toHaveBeenCalledTimes(1)
    expect(onImages).toHaveBeenCalledTimes(1)
  })
})
