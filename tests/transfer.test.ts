import { describe, expect, it, vi } from 'vitest'

async function freshTransferEnv() {
  vi.resetModules()
  const mem: Record<string, unknown> = {}
  const blobs = new Map<string, Blob>()

  const get = vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {}))
  const set = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(mem, obj)
  })

  const g = globalThis as unknown as { chrome?: unknown }
  g.chrome = {
    storage: {
      local: { get, set },
      onChanged: { addListener: () => {} },
    },
  }

  vi.doMock('../src/watchpage/coverStore', () => ({
    coverStore: {
      get: vi.fn(async (id: string) => blobs.get(id)),
      put: vi.fn(async (id: string, blob: Blob) => {
        blobs.set(id, blob)
      }),
    },
  }))

  const { watchStore } = await import('../src/watch/watchStore')
  const { favPosts, favImages } = await import('../src/watch/collectStore')
  const transfer = await import('../src/watchpage/transfer')

  await Promise.all([watchStore.ready(), favPosts.ready(), favImages.ready()])

  return { watchStore, favPosts, favImages, transfer, blobs }
}

describe('transfer payload export/import', () => {
  it('exports favPosts, favImages, and uploaded blobs for both cover and previews, and restores them on import', async () => {
    const { watchStore, favPosts, favImages, transfer, blobs } =
      await freshTransferEnv()

    blobs.set(
      'c_main',
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    )
    blobs.set(
      'c_prev',
      new Blob([new Uint8Array([4, 5, 6])], { type: 'image/webp' })
    )

    const creator = await watchStore.addCreator({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      name: 'Alice',
    })
    await watchStore.updateCreator(creator.key, {
      cover: { kind: 'upload', id: 'c_main' },
      previews: [
        { kind: 'post', path: '/a/b.jpg' },
        { kind: 'upload', id: 'c_prev' },
      ],
      rating: 5,
      tags: ['Art'],
    })

    await favPosts.add({
      key: 'pawchive/patreon/1/10',
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
      title: 'Post 10',
      creatorName: 'Alice',
    })
    await favImages.add({
      key: 'pawchive/5a/48/5a48abcd.jpeg',
      site: 'pawchive',
      path: '/5a/48/5a48abcd.jpeg',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
    })

    const payload = await transfer.buildExportPayload()
    expect(payload.type).toBe(transfer.EXPORT_TYPE)
    expect(payload.version).toBe(2)
    expect(Object.keys(payload.covers).sort()).toEqual(['c_main', 'c_prev'])
    expect(payload.covers.c_main.startsWith('data:image/png;base64,')).toBe(
      true
    )
    expect(payload.covers.c_prev.startsWith('data:image/webp;base64,')).toBe(
      true
    )
    expect(Object.keys(payload.favPosts.items)).toEqual([
      'pawchive/patreon/1/10',
    ])
    expect(Object.keys(payload.favImages.items)).toEqual([
      'pawchive/5a/48/5a48abcd.jpeg',
    ])

    // Clear state and re-import
    blobs.clear()
    await watchStore.replaceAll({})
    await favPosts.replaceAll({})
    await favImages.replaceAll({})

    const { importCount } = await transfer.applyImportPayload(payload)
    expect(importCount).toBe(1)
    expect(watchStore.getCreator(creator.key)?.tags).toEqual(['Art'])
    expect(watchStore.getCreator(creator.key)?.previews).toHaveLength(2)
    expect(favPosts.has('pawchive/patreon/1/10')).toBe(true)
    expect(favImages.has('pawchive/5a/48/5a48abcd.jpeg')).toBe(true)
    expect(blobs.has('c_main')).toBe(true)
    expect(blobs.has('c_prev')).toBe(true)
  })

  it('keeps existing favorites when importing an older export without favPosts/favImages', async () => {
    const { watchStore, favPosts, favImages, transfer } =
      await freshTransferEnv()

    await favPosts.add({
      key: 'pawchive/patreon/1/10',
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
      title: 'Existing Post',
      creatorName: 'Alice',
    })
    await favImages.add({
      key: 'pawchive/5a/48/5a48abcd.jpeg',
      site: 'pawchive',
      path: '/5a/48/5a48abcd.jpeg',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
    })

    const v1Payload = {
      type: transfer.EXPORT_TYPE,
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      data: {
        version: 1,
        folders: [{ id: 'unsorted', name: '', order: 0, createdAt: 0 }],
        creators: {
          'kemono/fanbox/2': {
            key: 'kemono/fanbox/2',
            site: 'kemono',
            service: 'fanbox',
            creatorId: '2',
            name: 'Bob',
            folderId: 'unsorted',
            addedAt: 1,
          },
        },
        hosts: {},
      },
      covers: {},
    }

    const res = await transfer.applyImportPayload(v1Payload)
    expect(res.importCount).toBe(1)
    expect(watchStore.isWatched('kemono/fanbox/2')).toBe(true)
    // Existing favorites are preserved
    expect(favPosts.has('pawchive/patreon/1/10')).toBe(true)
    expect(favImages.has('pawchive/5a/48/5a48abcd.jpeg')).toBe(true)
  })
})
