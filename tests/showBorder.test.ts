import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  hasPost: vi.fn(
    async (_key: string, _published: string, _count: number) => false
  ),
}))

vi.mock('../src/download/DownloadRecord', () => ({
  downloadRecord: { hasPost: m.hasPost },
}))

const g = globalThis as any

type Card = { dataset: { postkey: string }; classList: { add: any } }
let cards: Card[]
let querySelectorAll: ReturnType<typeof vi.fn>
let EVT: typeof import('../src/EVT').EVT
let store: typeof import('../src/store/Store').store

const card = (postkey: string): Card => ({
  dataset: { postkey },
  classList: { add: vi.fn() },
})

function res(postKey: string, i: number, published = '2024-01-01'): any {
  return { id: `${postKey}#${i}`, postKey, published }
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  m.hasPost.mockReset()
  m.hasPost.mockImplementation(async () => false)
  cards = []
  querySelectorAll = vi.fn(() => cards)
  g.document.querySelectorAll = querySelectorAll
  // The EVT bus is a module singleton: reload so listeners do not pile up
  vi.resetModules()
  ;({ EVT } = await import('../src/EVT'))
  ;({ store } = await import('../src/store/Store'))
  await import('../src/download/ShowBorderOnDownloadedWorks')
})

afterEach(() => {
  vi.useRealTimers()
  delete g.document.querySelectorAll
})

describe('ShowBorderOnDownloadedWorks', () => {
  it('turns a burst of saved files into one scan after a quiet second', async () => {
    cards = [card('p/1/1')]
    store.result = [res('p/1/1', 0)]
    for (let i = 0; i < 20; i++) {
      EVT.fire('downloadSuccess')
      await tick(20)
    }
    expect(querySelectorAll).not.toHaveBeenCalled()

    await tick(1000)
    expect(querySelectorAll).toHaveBeenCalledTimes(1)
  })

  it('still scans while files keep arriving (maximum wait)', async () => {
    cards = [card('p/1/1')]
    store.result = [res('p/1/1', 0)]
    // One file every 400 ms: the quiet second never comes
    for (let t = 0; t < 6000; t += 400) {
      EVT.fire('downloadSuccess')
      await tick(400)
    }
    expect(querySelectorAll.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('never runs two scans at once', async () => {
    cards = [card('p/1/1')]
    store.result = [res('p/1/1', 0)]
    let release!: () => void
    m.hasPost.mockImplementationOnce(
      () => new Promise<boolean>((r) => (release = () => r(true)))
    )
    EVT.fire('downloadComplete')
    await tick(1000)
    expect(querySelectorAll).toHaveBeenCalledTimes(1)
    expect(m.hasPost).toHaveBeenCalledTimes(1)

    // A trigger while the scan is still running waits for it to finish
    EVT.fire('downloadSuccess')
    await tick(5000)
    expect(querySelectorAll).toHaveBeenCalledTimes(1)

    release()
    await tick(0)
    expect(cards[0].classList.add).toHaveBeenCalledWith('pwp-downloaded')
    await tick(1000)
    expect(querySelectorAll).toHaveBeenCalledTimes(2)
  })

  it('asks once per post with its file count and date, and marks every card', async () => {
    const a1 = card('p/1/1')
    const a2 = card('p/1/1') // the same post shown twice
    const b = card('p/1/2')
    cards = [a1, a2, b, card('p/1/9')] // p/1/9 has no results
    store.result = [
      res('p/1/1', 0, '2024-01-01'),
      res('p/1/1', 1, '2024-01-01'),
      res('p/1/1', 2, '2024-01-01'),
      res('p/1/2', 0, '2024-02-02'),
      res('p/1/7', 0), // not on the page: ignored
    ]
    m.hasPost.mockImplementation(async (key) => key === 'p/1/1')

    EVT.fire('crawlComplete')
    await tick(1000)

    expect(m.hasPost).toHaveBeenCalledTimes(2)
    expect(m.hasPost).toHaveBeenCalledWith('p/1/1', '2024-01-01', 3)
    expect(m.hasPost).toHaveBeenCalledWith('p/1/2', '2024-02-02', 1)
    expect(a1.classList.add).toHaveBeenCalledWith('pwp-downloaded')
    expect(a2.classList.add).toHaveBeenCalledWith('pwp-downloaded')
    expect(b.classList.add).not.toHaveBeenCalled()
  })

  it('does nothing on a page without cards', async () => {
    store.result = [res('p/1/1', 0)]
    EVT.fire('pageSwitch')
    await tick(1000)
    expect(querySelectorAll).toHaveBeenCalledTimes(1)
    expect(m.hasPost).not.toHaveBeenCalled()
  })

  it('a failing scan does not stop later ones', async () => {
    cards = [card('p/1/1')]
    store.result = [res('p/1/1', 0)]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    m.hasPost.mockRejectedValueOnce(new Error('boom'))

    EVT.fire('downloadSuccess')
    await tick(1000)
    EVT.fire('downloadSuccess')
    await tick(1000)

    expect(m.hasPost).toHaveBeenCalledTimes(2)
  })
})
