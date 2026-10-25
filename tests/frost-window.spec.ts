// @vitest-environment jsdom
/**
 * Frost window contracts: the marker that caps backdrop-filtered rows to the
 * viewport, the incremental mutation handling that keeps the scan off the rest
 * of the app and off the rest of the transcript, and the three failure modes
 * that used to cost the page its frost (boot before body, no
 * IntersectionObserver, a detached row keeping its marker).
 *
 * jsdom has no layout and no IntersectionObserver, so a stub supplies the
 * intersection entries; nothing here proves paint, only marker bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FROST_NEAR_ATTR, FROST_WINDOW_ATTR, installFrostWindow } from '../src/client/runtime/frost-window.ts'

/** Minimal IntersectionObserver double: records targets, fires entries on demand. */
class FakeObserver {
  static live: FakeObserver[] = []

  readonly targets = new Set<Element>()

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.live.push(this)
  }

  observe(el: Element): void {
    this.targets.add(el)
  }

  unobserve(el: Element): void {
    this.targets.delete(el)
  }

  disconnect(): void {
    this.targets.clear()
    FakeObserver.live = FakeObserver.live.filter(observer => observer !== this)
  }

  fire(el: Element, isIntersecting: boolean): void {
    this.callback([{ target: el, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

let frames: Array<FrameRequestCallback | null> = []

/** Run everything queued for the next animation frame. */
function flushFrames(): void {
  const pending = frames.splice(0, frames.length)
  for (const callback of pending) callback?.(0)
}

/** Let a MutationObserver deliver its queued records (macrotask). */
function deliverMutations(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** One conversation scrollport holding reasoning rows, as the shell renders it. */
function buildConversation(rowCount: number): { scrollport: HTMLElement; rows: HTMLElement[] } {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const rows: HTMLElement[] = []
  for (let index = 0; index < rowCount; index += 1) {
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'reasoning')
    scrollport.appendChild(row)
    rows.push(row)
  }
  document.body.appendChild(scrollport)
  return { scrollport, rows }
}

beforeEach(() => {
  frames = []
  FakeObserver.live = []
  window.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    frames.push(callback)
    return frames.length
  }
  window.cancelAnimationFrame = (handle: number): void => {
    frames[handle - 1] = null
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(FROST_WINDOW_ATTR)
})

describe('installFrostWindow', () => {
  it('marks a row while it is near and clears it when it leaves', () => {
    const { rows } = buildConversation(2)
    const dispose = installFrostWindow(document)

    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(true)
    const observer = FakeObserver.live[0]
    expect(observer.targets.has(rows[0])).toBe(true)
    expect(observer.targets.has(rows[1])).toBe(true)

    observer.fire(rows[0], true)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(true)

    observer.fire(rows[0], false)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(false)

    dispose()
  })

  it('keeps the pre-window blur when IntersectionObserver is missing', () => {
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver
    const { rows } = buildConversation(3)

    const dispose = installFrostWindow(document)

    expect(rows.every(row => row.hasAttribute(FROST_NEAR_ATTR))).toBe(true)

    dispose()
    expect(rows.every(row => !row.hasAttribute(FROST_NEAR_ATTR))).toBe(true)
    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(false)
  })

  it('installs once the body appears when boot ran before it existed', () => {
    const { rows } = buildConversation(1)
    const realBody = document.body
    Object.defineProperty(document, 'body', { configurable: true, get: () => null })

    const dispose = installFrostWindow(document)
    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(false)
    expect(FakeObserver.live).toHaveLength(0)

    Object.defineProperty(document, 'body', { configurable: true, get: () => realBody })
    document.dispatchEvent(new Event('DOMContentLoaded'))

    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(true)
    const observer = FakeObserver.live[0]
    expect(observer.targets.has(rows[0])).toBe(true)

    dispose()
  })

  it('keeps the window alive while a second installer still holds it', () => {
    const { rows } = buildConversation(1)
    const first = installFrostWindow(document)
    const second = installFrostWindow(document)

    // One observer for the document, not one per installer.
    expect(FakeObserver.live).toHaveLength(1)

    first()
    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(true)
    FakeObserver.live[0].fire(rows[0], true)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(true)

    second()
    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(false)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(false)
  })

  it('drops the marker from a row it forgets', async () => {
    const { rows } = buildConversation(2)
    const dispose = installFrostWindow(document)
    const observer = FakeObserver.live[0]

    observer.fire(rows[0], true)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(true)

    rows[0].remove()
    await deliverMutations()
    flushFrames()

    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(false)
    expect(observer.targets.has(rows[0])).toBe(false)

    dispose()
  })

  it('does not observe a plate outside the conversation scrollport', () => {
    const { rows } = buildConversation(1)
    const stray = document.createElement('div')
    stray.setAttribute('data-chat-flow-kind', 'reasoning')
    document.body.appendChild(stray)

    const dispose = installFrostWindow(document)
    const observer = FakeObserver.live[0]

    expect(observer.targets.has(rows[0])).toBe(true)
    expect(observer.targets.has(stray)).toBe(false)

    dispose()
  })

  it('does not scan for mutations outside the conversation', async () => {
    const { rows } = buildConversation(1)
    const dispose = installFrostWindow(document)
    expect(FakeObserver.live[0].targets.has(rows[0])).toBe(true)

    const sidebar = document.createElement('div')
    sidebar.setAttribute('data-sidebar', '')
    document.body.appendChild(sidebar)
    await deliverMutations()

    expect(frames.filter(callback => callback !== null)).toHaveLength(0)

    dispose()
  })

  it('observes a row inserted into the conversation', async () => {
    const { scrollport } = buildConversation(1)
    const dispose = installFrostWindow(document)
    const observer = FakeObserver.live[0]

    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'tool-call')
    scrollport.appendChild(row)
    await deliverMutations()
    flushFrames()

    expect(observer.targets.has(row)).toBe(true)

    dispose()
  })

  it('does not re-scan the transcript for one inserted row', async () => {
    const { scrollport } = buildConversation(40)
    const dispose = installFrostWindow(document)
    const scan = vi.spyOn(document, 'querySelectorAll')

    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-kind', 'reasoning')
    scrollport.appendChild(row)
    await deliverMutations()
    flushFrames()

    expect(scan).not.toHaveBeenCalled()

    dispose()
  })

  it('observes an element that becomes a plate after insertion', async () => {
    const { scrollport } = buildConversation(0)
    const dispose = installFrostWindow(document)
    const observer = FakeObserver.live[0]

    const late = document.createElement('div')
    scrollport.appendChild(late)
    await deliverMutations()
    flushFrames()
    expect(observer.targets.has(late)).toBe(false)

    late.setAttribute('data-chat-flow-kind', 'context')
    await deliverMutations()
    flushFrames()
    expect(observer.targets.has(late)).toBe(true)

    dispose()
  })

  it('tears down cleanly and ignores a frame queued before teardown', async () => {
    const { rows } = buildConversation(1)
    const dispose = installFrostWindow(document)

    rows[0].appendChild(document.createElement('span'))
    await deliverMutations()
    dispose()
    flushFrames()

    expect(document.documentElement.hasAttribute(FROST_WINDOW_ATTR)).toBe(false)
    expect(rows[0].hasAttribute(FROST_NEAR_ATTR)).toBe(false)
    expect(FakeObserver.live).toHaveLength(0)
  })
})
