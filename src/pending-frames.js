/**
 * The approval-time frame, kept reachable while its approval is still pending.
 *
 * A gated browser action has to show the operator the screen **before** the decision, but at that
 * moment nothing has been logged yet: the call's own `tool/result` — the only known event type whose
 * image references a Client is authorized to read — does not exist until the action has run. So the
 * bytes captured an instant before the ask are held here, in the Host's memory, and handed to the
 * operator's own browser through the feature-owned Fetch route in `frame-route.js`. That route is
 * the documented shape for this kind of response, not an invention:
 *
 * > A feature that needs a streamed or browser-native response registers an exact Connection Fetch
 * > route instead of defining a Remote method.
 * > — `docs/api-gateway.md`, "API layers"
 *
 * > The Connection owns … exact Fetch routes …; feature-owned downloads register exact Fetch routes.
 * > — `docs/subsystems/web-client.md`, "Transport and API assembly"
 *
 * An image is exactly that: a browser-native, non-JSON response.
 *
 * The table is deliberately small and self-expiring:
 *
 * - **Lazy expiry, no timers.** An entry is pruned the next time the table is touched. A timer would
 *   need its own disposal, and `record`/`peek` run on every gated action, so staleness cannot go
 *   unnoticed. A dropped frame degrades to "no live preview", never to a wrong picture.
 * - **A hard cap.** A call that throws between the capture and the result would otherwise leave its
 *   frame behind; the oldest entry is evicted once the cap is reached, so memory stays bounded even
 *   on that path.
 * - **Dropped on unload.** These are screenshots of the operator's screen. They must not outlive the
 *   plugin instance that took them.
 *
 * Nothing here is written to the Session log, and no event type is involved.
 */

/** How long one frame stays servable, when nobody drops it first. */
export const FRAME_TTL_MS = 60_000

/** How many frames may be held at once. A gated call needs one. */
export const FRAME_LIMIT = 4

export class PendingFrames {
  /** callId -> {data, mimeType, byteLength, width, height, path, at}, in insertion order. */
  #entries = new Map()
  #ttlMs
  #limit
  #now

  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs] - how long a frame stays servable.
   * @param {number} [options.limit] - how many frames may be held at once.
   * @param {() => number} [options.now] - clock, for tests.
   */
  constructor({ ttlMs = FRAME_TTL_MS, limit = FRAME_LIMIT, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs
    this.#limit = Math.max(1, limit)
    this.#now = now
  }

  /** @returns {number} how many frames are currently held. */
  get size() {
    return this.#entries.size
  }

  /**
   * Hold one captured frame under the tool call it belongs to.
   *
   * @param {string} callId - the tool call the frame was captured for.
   * @param {object} frame - a `BrowserController.screenshotToFile` result.
   * @returns {void}
   */
  record(callId, frame) {
    if (typeof callId !== 'string' || callId === '') return
    if (frame === null || typeof frame !== 'object' || frame.data === undefined) return
    this.#prune()
    // Re-recording the same call moves it to the end, which keeps the eviction order honest.
    this.#entries.delete(callId)
    this.#entries.set(callId, {
      data: frame.data,
      mimeType: typeof frame.mimeType === 'string' ? frame.mimeType : 'image/png',
      ...(typeof frame.byteLength === 'number' ? { byteLength: frame.byteLength } : {}),
      ...(typeof frame.width === 'number' ? { width: frame.width } : {}),
      ...(typeof frame.height === 'number' ? { height: frame.height } : {}),
      ...(typeof frame.path === 'string' ? { path: frame.path } : {}),
      at: this.#now(),
    })
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
  }

  /**
   * The frame held for one call, or null when there is none to serve.
   *
   * Reading never consumes: the operator's browser may ask again (a reload, a retry after a dropped
   * connection), and the answer stays the same until the call's result exists.
   *
   * @param {string} callId - the tool call to look up.
   * @returns {object|null} the frame, or null.
   */
  peek(callId) {
    if (typeof callId !== 'string' || callId === '') return null
    this.#prune()
    const entry = this.#entries.get(callId)
    return entry === undefined ? null : { ...entry }
  }

  /**
   * Drop the frame held for one call.
   *
   * Called once the call's own result exists: from that moment the result carries the same picture,
   * so the live preview has nothing left to add and the bytes should stop being servable.
   *
   * @param {string} callId - the tool call to forget.
   * @returns {void}
   */
  forget(callId) {
    if (typeof callId !== 'string') return
    this.#entries.delete(callId)
  }

  /** Drop every held frame. */
  clear() {
    this.#entries.clear()
  }

  /** Evict what has aged out. Called on every touch, so no timer is needed. */
  #prune() {
    const cutoff = this.#now() - this.#ttlMs
    for (const [callId, entry] of this.#entries) {
      if (entry.at >= cutoff) continue
      this.#entries.delete(callId)
    }
  }
}
