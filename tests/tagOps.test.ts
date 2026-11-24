import { describe, expect, it, vi } from 'vitest'

async function freshEnv() {
  vi.resetModules()
  const mem: Record<string, unknown> = {}

  const get = vi.fn(async (k: string) => (k in mem ? { [k]: mem[k] } : {}))
  const set = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(mem, obj)
  })

  const g = globalThis as unknown as { chrome?: unknown }
  g.chrome = {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: () => {},
      },
    },
  }

  const { watchStore } = await import('../src/watch/watchStore')
  const { favPosts, favImages } = await import('../src/watch/collectStore')
  const { allTagCounts, renameTag, deleteTag } =
    await import('../src/watch/tagOps')

  await Promise.all([watchStore.ready(), favPosts.ready(), favImages.ready()])

  return { watchStore, favPosts, favImages, allTagCounts, renameTag, deleteTag }
}

describe('tagOps and watchStore labels', () => {
  it('allTagCounts, renameTag (merging without duplicates), and deleteTag work across all three stores', async () => {
    const {
      watchStore,
      favPosts,
      favImages,
      allTagCounts,
      renameTag,
      deleteTag,
    } = await freshEnv()

    const c = await watchStore.addCreator({
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      name: 'Alice',
    })
    await watchStore.updateCreator(c.key, {
      rating: 5,
      tags: ['OldTag', 'Target'],
      previews: [{ kind: 'post', path: '/a/1.jpg' }],
    })
    expect(watchStore.getCreator(c.key)?.previews).toEqual([
      { kind: 'post', path: '/a/1.jpg' },
    ])

    await watchStore.updateCreatorsLabels([c.key], {
      addTags: ['Extra'],
      rating: 4,
    })
    expect(watchStore.getCreator(c.key)?.rating).toBe(4)
    expect(watchStore.getCreator(c.key)?.tags).toEqual([
      'OldTag',
      'Target',
      'Extra',
    ])

    const p = await favPosts.add({
      key: 'pawchive/patreon/1/10',
      site: 'pawchive',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
      title: 'Post',
      creatorName: 'Alice',
    })
    await favPosts.update(p.key, { tags: ['oldtag', 'Solo'] })

    const img = await favImages.add({
      key: 'pawchive/5a/48/5a48aaaa.jpeg',
      site: 'pawchive',
      path: '/5a/48/5a48aaaa.jpeg',
      service: 'patreon',
      creatorId: '1',
      postId: '10',
    })
    await favImages.update(img.key, { tags: ['OLDTAG'] })

    expect(allTagCounts()).toEqual([
      { tag: 'OldTag', count: 3 },
      { tag: 'Extra', count: 1 },
      { tag: 'Solo', count: 1 },
      { tag: 'Target', count: 1 },
    ])

    // No-op when `to` normalizes to null
    await renameTag('OldTag', '   ')
    expect(watchStore.getCreator(c.key)?.tags).toEqual([
      'OldTag',
      'Target',
      'Extra',
    ])

    // Rename OldTag -> Target merges into existing Target without duplicates
    await renameTag('oldtag', '  Target  ')
    expect(watchStore.getCreator(c.key)?.tags).toEqual(['Target', 'Extra'])
    expect(favPosts.get(p.key)?.tags).toEqual(['Target', 'Solo'])
    expect(favImages.get(img.key)?.tags).toEqual(['Target'])

    // Delete Target removes it everywhere and clears empty tags array on favImage
    await deleteTag('target')
    expect(watchStore.getCreator(c.key)?.tags).toEqual(['Extra'])
    expect(favPosts.get(p.key)?.tags).toEqual(['Solo'])
    expect(favImages.get(img.key)?.tags).toBeUndefined()
  })
})
