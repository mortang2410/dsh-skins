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
 * per-frame query. A MutationObserver re-scans when rows stream in, and the scan
 * is coalesced into one animation frame because a streaming turn mutates the
 * chat several times per second. The window margin covers the rows just above
 * and below the viewport, so a row is already filtered when it scrolls in.
 *
 * The attribute is presentational only and never carries a value. Removing the
 * plugin removes it with the observer, and the stylesheet is inert without it.
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
 * How far outside the viewport a row still counts as near, in px. A plate is
 * about 110px tall, so this keeps roughly three rows cached above and below the
 * fold and leaves the live count in the low dozens.
 */
const WINDOW_MARGIN_PX = 400

/** Install the frost window on one document; returns its teardown. */
export function installFrostWindow(doc: Document): () => void {
  const win = doc.defaultView
  if (doc.body === null || win === null) return () => {}
  if (typeof win.IntersectionObserver !== 'function') return () => {}
  if (doc.documentElement.hasAttribute(FROST_WINDOW_ATTR)) return () => {}

  const tracked = new Set<Element>()
  let frame: number | null = null
  let disposed = false

  const mark = (el: Element, near: boolean): void => {
    if (near) el.setAttribute(FROST_NEAR_ATTR, '')
    else el.removeAttribute(FROST_NEAR_ATTR)
  }

  const observer = new win.IntersectionObserver(
    (entries) => {
      for (const entry of entries) mark(entry.target, entry.isIntersecting)
    },
    { rootMargin: `${WINDOW_MARGIN_PX}px 0px ${WINDOW_MARGIN_PX}px 0px` },
  )

  const scan = (): void => {
    frame = null
    if (disposed || doc.body === null) return
    const plates = doc.querySelectorAll(FROST_PLATE_SELECTOR)
    for (const plate of plates) {
      if (tracked.has(plate)) continue
      tracked.add(plate)
      observer.observe(plate)
    }
    // Rows that left the transcript are dropped, so a long session does not keep
    // observing every row it has ever shown.
    for (const plate of tracked) {
      if (plate.isConnected) continue
      observer.unobserve(plate)
      tracked.delete(plate)
    }
  }

  const schedule = (): void => {
    if (frame !== null || disposed) return
    frame = win.requestAnimationFrame(scan)
  }

  const mutations = new win.MutationObserver(schedule)
  doc.documentElement.setAttribute(FROST_WINDOW_ATTR, '')
  mutations.observe(doc.body, { childList: true, subtree: true })
  scan()

  return () => {
    disposed = true
    if (frame !== null) {
      win.cancelAnimationFrame(frame)
      frame = null
    }
    mutations.disconnect()
    observer.disconnect()
    for (const plate of tracked) plate.removeAttribute(FROST_NEAR_ATTR)
    tracked.clear()
    doc.documentElement.removeAttribute(FROST_WINDOW_ATTR)
  }
}
