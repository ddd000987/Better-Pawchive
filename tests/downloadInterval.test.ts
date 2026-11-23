import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ seconds: 2 }))

vi.mock('../src/setting/Settings', () => ({
  settings: { get: (k: string) => (k === 'downloadInterval' ? m.seconds : 0) },
}))
vi.mock('../src/Log', () => ({
  log: { log: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock('../src/Language', () => ({
  lang: { transl: (key: string) => key },
}))

type Mods = {
  EVT: typeof import('../src/EVT').EVT
  downloadInterval: typeof import('../src/download/DownloadInterval').downloadInterval
}
let mods: Mods

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

/** Track whether a promise has settled, and with what */
function track<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T } = { done: false }
  void p.then((value) => {
    state.done = true
    state.value = value
  })
  return state
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  m.seconds = 2
  // The EVT bus is a module singleton: reload so listeners do not pile up
  vi.resetModules()
  const [{ EVT }, { downloadInterval }] = await Promise.all([
    import('../src/EVT'),
    import('../src/download/DownloadInterval'),
  ])
  mods = { EVT, downloadInterval }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DownloadInterval.wait', () => {
  it('lets the first download start at once, and everything when disabled', async () => {
    const first = track(mods.downloadInterval.wait())
    await tick(0)
    expect(first).toEqual({ done: true, value: true })

    m.seconds = 0
    const free = track(mods.downloadInterval.wait())
    await tick(0)
    expect(free).toEqual({ done: true, value: true })
  })

  it('waits the interval in one timer, not by polling', async () => {
    await mods.downloadInterval.wait()
    const second = track(mods.downloadInterval.wait())

    await tick(1000)
    expect(second.done).toBe(false)
    // A single pending timer for the whole wait
    expect(vi.getTimerCount()).toBe(1)

    await tick(1000)
    expect(second).toEqual({ done: true, value: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('spaces concurrent waiters by one interval each', async () => {
    await mods.downloadInterval.wait()
    const a = track(mods.downloadInterval.wait())
    const b = track(mods.downloadInterval.wait())

    await tick(1999)
    expect(a.done || b.done).toBe(false)
    await tick(2)
    expect([a.done, b.done].filter(Boolean)).toHaveLength(1)
    await tick(1900)
    expect([a.done, b.done].filter(Boolean)).toHaveLength(1)
    await tick(200)
    expect(a.done && b.done).toBe(true)
  })

  it.each(['downloadPause', 'downloadStop'] as const)(
    'a waiter notices a cancel right after %s, without waiting out the interval',
    async (evt) => {
      await mods.downloadInterval.wait()
      let cancelled = false
      const waiting = track(mods.downloadInterval.wait(() => cancelled))
      await tick(500)
      expect(waiting.done).toBe(false)

      cancelled = true
      mods.EVT.fire(evt)
      await tick(0)

      expect(waiting).toEqual({ done: true, value: false })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('a waiter that is already cancelled returns false at once', async () => {
    const waiting = track(mods.downloadInterval.wait(() => true))
    await tick(0)
    expect(waiting).toEqual({ done: true, value: false })
  })

  it('a new batch (downloadStart) resets the schedule and wakes the waiters', async () => {
    await mods.downloadInterval.wait()
    const waiting = track(mods.downloadInterval.wait())
    await tick(500)
    expect(waiting.done).toBe(false)

    mods.EVT.fire('downloadStart')
    await tick(0)

    expect(waiting).toEqual({ done: true, value: true })
  })

  it('turning the interval off lets a waiter go at once', async () => {
    await mods.downloadInterval.wait()
    const waiting = track(mods.downloadInterval.wait())
    await tick(500)

    m.seconds = 0
    mods.EVT.fire('settingChange', { key: 'downloadInterval', value: 0 })
    await tick(0)

    expect(waiting).toEqual({ done: true, value: true })
  })
})
