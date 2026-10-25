/**
 * Frost window: cap the number of backdrop-filtered chat rows to the ones the
 * reader can actually see (backdrop-filter element cap).
 *
 * WebKit stops painting `backdrop-filter` for the whole document once a page
 * carries too many filtered elements, so a long conversation loses the frost on
 * every bubble at once instead of losing it only where it is dense. Measured in
 * Safari on 2026-10-25 against this app's own session page: with 233 elements
 * carrying a non-none backdrop-filter, a control element with
 * `backdrop-filter: blur(40px)` over live text changed 0.1/255 of the pixels it
 * covered (nothing painted), while the same control painted a full blur
 * (99.3% of pixels changed, contrast sd 56.2 -> 5.5) as soon as the count fell
 * to a handful. A document-order ladder showed 120 filtered elements still
 * painting and 160, 200 and 233 not painting. The skin reaches that count on
 * its own: one session held 78 reasoning plates and 117 tool/process plates.
 *
 * The skin's per-row frost rules therefore key on FROST_NEAR_ATTR (patches.css),
 * and this module owns that attribute: a row gets it while it intersects the
 * viewport plus a margin, and loses it when it scrolls away. Offscreen rows keep
 * their tint and drop only the blur, which cannot be seen because they are not
 * on screen, so the live filtered count stays near the dozen rows a viewport
 * holds instead of growing with the transcript.
 *
 * IntersectionObserver does the visibility work, so scrolling costs no
 * per-frame query. Rows streaming in are processed from their own mutation
 * records (`performance-guidelines-v1` R1): a record outside the conversation
 * scrollport is discarded after one containment check, and a record inside it
 * observes only the added subtree instead of re-scanning the transcript. A full
 * scan runs at install, when the shell rebuilds the scrollport, and for a bulk
 * insert large enough that per-node queries would cost more.
 *
 * Two failure modes must not cost the page its frost: a boot that runs before
 * the body exists installs once parsing reaches it, and a browser without
 * IntersectionObserver keeps the blur on every plate, which is the behaviour
 * before this module existed. The attribute is presentational only and never
 * carries a value; removing the plugin removes it with the observers, and the
 * stylesheet is inert without it.
 * @module @linxin666/dsh-client-ui-skin-center/runtime/frost-window
 */

/** Marker on a chat row while it sits in or near the viewport. */
export const FROST_NEAR_ATTR = 'data-dsh-frost-near'

/** Marker on the document element while the window is installed. */
export const FROST_WINDOW_ATTR = 'data-dsh-frost-window'

/**
 * Rows the skin paints a frost plate on. Each entry repeats a selector from
 * patches.css, so a row that gains the blur there is a row this module tracks;
 * a plate rule added without a row here would keep its blur outside the window
 * and keep counting toward the cap.
 */
const FROST_PLATE_SELECTOR = [
  '[data-chat-group-part="reasoning"]',
  '[data-chat-flow-kind="reasoning"]',
  '[data-chat-flow-kind="tool-call"]',
  '[data-chat-flow-kind="turn-process"]',
  '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"] [class*="_body"]',
  '[data-chat-flow-kind="context"]',
  '[data-chat-flow-kind="compaction"]',
  '[data-chat-flow-kind="manual-compaction"]',
  '[data-chat-flow-kind="model-retry"]',
  '[data-chat-flow-kind="turn-max-tokens"]',
  '[data-chat-flow-kind="turn-error"]',
].join(', ')

/**
 * The two attributes that decide whether an element is a row plate. A node that
 * gains one after insertion is a plate this module has not observed yet, so the
 * observer watches for those writes alone.
 */
const PLATE_ATTRIBUTES = ['data-chat-flow-kind', 'data-chat-group-part']

/**
 * The shell's conversation scrollport. Every chat row renders inside it, so it
 * is the narrowest stable anchor this module can scope to, and the same node
 * backdrop-scene.ts already scopes its own row query to. The shell rebuilds it
 * only on a session switch, which the connectivity check below detects.
 */
const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'

/**
 * How far outside the viewport a row still counts as near, in px. A plate is
 * about 110px tall, so this keeps roughly three rows cached above and below the
 * fold and leaves the live count in the low dozens.
 */
const WINDOW_MARGIN_PX = 400

/** One document's installed window, shared by every installer of that document. */
interface FrostWindow {
  refs: number
  dispose: () => void
}

const windows = new WeakMap<Document, FrostWindow>()

/** Install the frost window on one document; returns its teardown. */
export function installFrostWindow(doc: Document): () => void {
  const existing = windows.get(doc)
  if (existing !== undefined) {
    // A second installer (a re-imported plugin, a hot reload) shares the live
    // window instead of being refused: refusing would let the first teardown
    // delete the only observer while the second caller still expects a window.
    existing.refs += 1
    return () => releaseFrostWindow(doc, existing)
  }
  const window: FrostWindow = { refs: 1, dispose: () => {} }
  windows.set(doc, window)
  window.dispose = startFrostWindow(doc)
  return () => releaseFrostWindow(doc, window)
}

/** Drop one installer's claim; the last one tears the window down. */
function releaseFrostWindow(doc: Document, window: FrostWindow): void {
  window.refs -= 1
  if (window.refs > 0) return
  if (windows.get(doc) === window) windows.delete(doc)
  window.dispose()
}

/** Install now, or once parsing reaches the body. */
function startFrostWindow(doc: Document): () => void {
  const view = doc.defaultView
  if (view === null) return () => {}
  if (doc.body !== null) return installWindow(doc, view)
  // A client plugin can apply before the body exists. Returning a no-op there
  // would leave the page without a single marked row for its whole life, which
  // is a silent loss of every frosted bubble.
  let dispose: (() => void) | null = null
  let cancelled = false
  const onReady = (): void => {
    doc.removeEventListener('DOMContentLoaded', onReady)
    if (!cancelled) dispose = installWindow(doc, view)
  }
  doc.addEventListener('DOMContentLoaded', onReady)
  return () => {
    cancelled = true
    doc.removeEventListener('DOMContentLoaded', onReady)
    dispose?.()
  }
}

/** The live window for one document; the returned closure is idempotent. */
function installWindow(doc: Document, view: Window & typeof globalThis): () => void {
  const tracked = new Set<Element>()
  const added = new Set<Element>()
  const removed = new Set<Element>()
  /** The scrollport the last scan found; re-located when the shell rebuilds it. */
  let anchor: Element | null = null
  let needsFullScan = false
  let frame: number | null = null
  let disposed = false

  /** Write a marker only when the state is not applied yet. */
  const mark = (el: Element, near: boolean): void => {
    if (near) {
      if (!el.hasAttribute(FROST_NEAR_ATTR)) el.setAttribute(FROST_NEAR_ATTR, '')
      return
    }
    if (el.hasAttribute(FROST_NEAR_ATTR)) el.removeAttribute(FROST_NEAR_ATTR)
  }

  // A browser without IntersectionObserver cannot answer "is this row near?".
  // Degrade to the behaviour before this module existed (every plate keeps its
  // blur, the cap is not enforced) rather than dropping the frost from the
  // whole page, which no later state could recover from.
  const observes = typeof view.IntersectionObserver === 'function'
  const observer = observes
    ? new view.IntersectionObserver(
        (entries) => {
          for (const entry of entries) mark(entry.target, entry.isIntersecting)
        },
        { rootMargin: `${WINDOW_MARGIN_PX}px 0px ${WINDOW_MARGIN_PX}px 0px` },
      )
    : null

  /** Track one plate, at most once. */
  function track(el: Element): void {
    if (tracked.has(el)) return
    tracked.add(el)
    observer?.observe(el)
  }

  /** Forget a plate that left the transcript, and take its marker with it. */
  function forget(el: Element): void {
    if (!tracked.has(el) || el.isConnected) return
    el.removeAttribute(FROST_NEAR_ATTR)
    observer?.unobserve(el)
    tracked.delete(el)
  }

  /** Observe every plate the scrollport holds now; used at install and on rebuild. */
  function scanAll(): void {
    anchor = doc.querySelector(SCROLLPORT_SELECTOR)
    const root = anchor ?? doc.body
    if (root === null) return
    for (const plate of root.querySelectorAll(FROST_PLATE_SELECTOR)) track(plate)
    for (const plate of tracked) forget(plate)
  }

  /** Observe the plates one added subtree holds, without touching its siblings. */
  function scanSubtree(node: Element): void {
    if (!node.isConnected) return
    if (node.matches(FROST_PLATE_SELECTOR)) track(node)
    for (const plate of node.querySelectorAll(FROST_PLATE_SELECTOR)) track(plate)
  }

  /** Apply what the mutation records collected, once per frame. */
  function scan(): void {
    frame = null
    if (disposed) return
    if (!observes) {
      // No observer: keep the pre-window behaviour, blur on every plate. A new
      // subtree only needs marking, so this stays proportional to the insert.
      if (needsFullScan || anchor === null || !anchor.isConnected) {
        anchor = doc.querySelector(SCROLLPORT_SELECTOR)
        for (const plate of doc.querySelectorAll(FROST_PLATE_SELECTOR)) mark(plate, true)
      }
      for (const node of added) {
        if (!node.isConnected) continue
        if (node.matches(FROST_PLATE_SELECTOR)) mark(node, true)
        for (const plate of node.querySelectorAll(FROST_PLATE_SELECTOR)) mark(plate, true)
      }
      added.clear()
      removed.clear()
      needsFullScan = false
      return
    }
    // A batch that would add more rows than the transcript already holds is a
    // bulk render (session restore, session switch): one scan of the scrollport
    // costs less than a query per record. Measured at 1000 rows in jsdom:
    // 200 added rows cost 14 ms incrementally and 32 ms as a scan.
    const bulk = added.size > tracked.size
    if (needsFullScan || anchor === null || !anchor.isConnected || bulk) {
      needsFullScan = false
      added.clear()
      scanAll()
    } else {
      for (const node of added) scanSubtree(node)
      added.clear()
    }
    for (const node of removed) forget(node)
    removed.clear()
    anchor = anchor?.isConnected === true ? anchor : doc.querySelector(SCROLLPORT_SELECTOR)
  }

  /** Coalesce a mutation burst into one scan per animation frame. */
  function schedule(): void {
    if (frame !== null || disposed) return
    if (typeof view.requestAnimationFrame !== 'function') {
      scan()
      return
    }
    frame = view.requestAnimationFrame(scan)
  }

  /** Record what one mutation batch changed, or ignore it when it cannot matter. */
  const collect = (records: MutationRecord[]): boolean => {
    if (records.length === 0) return false
    if (!observes) {
      // Without a window there is nothing to filter against: every insertion can
      // carry a plate.
      needsFullScan ||= anchor === null || !anchor.isConnected
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target.nodeType === 1 && (record.target as Element).matches(FROST_PLATE_SELECTOR)) added.add(record.target as Element)
          continue
        }
        for (const node of record.addedNodes) if (node.nodeType === 1) added.add(node as Element)
        for (const node of record.removedNodes) if (node.nodeType === 1) removed.add(node as Element)
      }
      return added.size > 0 || needsFullScan
    }
    if (anchor === null || !anchor.isConnected) {
      // The shell rebuilt the scrollport; only a full scan can find the new one.
      needsFullScan = true
      return true
    }
    let relevant = false
    for (const record of records) {
      if (record.target !== anchor && !anchor.contains(record.target)) continue
      relevant = true
      if (record.type === 'attributes') {
        if (record.target.nodeType === 1 && (record.target as Element).matches(FROST_PLATE_SELECTOR)) added.add(record.target as Element)
        continue
      }
      for (const node of record.addedNodes) if (node.nodeType === 1) added.add(node as Element)
      for (const node of record.removedNodes) if (node.nodeType === 1) removed.add(node as Element)
    }
    return relevant
  }

  const mutationRecords = new view.MutationObserver((records) => {
    if (disposed || !collect(records)) return
    schedule()
  })

  doc.documentElement.setAttribute(FROST_WINDOW_ATTR, '')
  mutationRecords.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: PLATE_ATTRIBUTES,
  })
  if (!observes) {
    anchor = doc.querySelector(SCROLLPORT_SELECTOR)
    for (const plate of doc.querySelectorAll(FROST_PLATE_SELECTOR)) mark(plate, true)
  } else {
    scanAll()
  }

  return () => {
    disposed = true
    if (frame !== null) {
      view.cancelAnimationFrame(frame)
      frame = null
    }
    mutationRecords.disconnect()
    observer?.disconnect()
    if (!observes) {
      // The no-observer path marked plates it never tracked.
      for (const plate of doc.querySelectorAll(FROST_PLATE_SELECTOR)) plate.removeAttribute(FROST_NEAR_ATTR)
    }
    for (const plate of tracked) plate.removeAttribute(FROST_NEAR_ATTR)
    tracked.clear()
    added.clear()
    removed.clear()
    doc.documentElement.removeAttribute(FROST_WINDOW_ATTR)
  }
}
