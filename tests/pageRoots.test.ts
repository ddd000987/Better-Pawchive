import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Minimal element: just what PageRoots touches */
function fakeEl(inDoc: boolean) {
  const el = {
    dataset: {} as Record<string, string>,
    isConnected: inDoc,
    remove() {
      el.isConnected = false
    },
  }
  return el
}

type FakeEl = ReturnType<typeof fakeEl>

describe('PageRoots', () => {
  const realDocument = (globalThis as { document: unknown }).document
  let handlers: Record<string, () => void>
  let marked: FakeEl[]
  let body: { appendChild: (el: FakeEl) => void }

  beforeEach(() => {
    handlers = {}
    marked = []
    body = {
      appendChild: (el) => {
        el.isConnected = true
      },
    }
    ;(globalThis as { document: unknown }).document = {
      addEventListener: (type: string, fn: () => void) => {
        handlers[type] = fn
      },
      // Connected elements carrying data-pwp-root
      querySelectorAll: () => marked.filter((el) => el.isConnected),
      body,
    }
    vi.resetModules()
  })

  afterEach(() => {
    ;(globalThis as { document: unknown }).document = realDocument
  })

  it('re-attaches a persistent element after an htmx:afterSettle swap', async () => {
    const mod = await import('../src/PageRoots')
    const panel = fakeEl(true)
    mod.keepInBody(panel as unknown as HTMLElement)
    marked.push(panel)

    // A boosted swap replaced the body content and dropped our element
    panel.isConnected = false
    handlers['htmx:afterSettle']()
    expect(panel.isConnected).toBe(true)
  })

  it('is idempotent and removes snapshot copies only', async () => {
    const mod = await import('../src/PageRoots')
    const panel = fakeEl(true)
    mod.keepInBody(panel as unknown as HTMLElement)
    const copy = fakeEl(true)
    copy.dataset.pwpRoot = ''
    marked.push(panel, copy)

    handlers['htmx:afterSettle']()
    handlers['htmx:afterSettle']()
    expect(panel.isConnected).toBe(true)
    expect(copy.isConnected).toBe(false)
  })
})
