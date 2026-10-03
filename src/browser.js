/**
 * Browser control layer for dsh-cua-preview.
 *
 * Library choice: **Puppeteer** (`puppeteer-core`). Rationale is recorded in README.md;
 * the short version is that we drive an already-installed Chrome
 * (`/usr/bin/google-chrome-stable`) so nothing large is downloaded at install time, and
 * `puppeteer-core` carries no browser-download postinstall step at all.
 *
 * This module owns exactly one browser + one page per plugin instance and keeps it across
 * turns, mirroring the DSH browser-use rule that browser state persists across the turns of
 * one live Session (`docs/subsystems/browser-use.md`, "Session ownership").
 *
 * It deliberately exposes NO policy decisions. Deciding whether an action is allowed is the
 * approval broker's job (`approval-broker.js`), exactly as ZCode separates its browser
 * adapter (`browser-control.port.ts`) from its permission flow (`permission-flow.ts`).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer, { ConnectionClosedError, TargetCloseError } from 'puppeteer-core'

/**
 * Candidate Chrome/Chromium executables, most-specific first.
 *
 * Conservative choice: the plugin never downloads a browser. If none of these exist the
 * plugin reports an actionable error instead of silently fetching ~150 MB.
 */
const CHROME_CANDIDATES = [
  process.env.DSH_CUA_CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter((value) => typeof value === 'string' && value.length > 0)

/** Containers run as root without a usable setuid sandbox; this is the standard CI flag set. */
const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
]

/** How many context lines of the target element to include in an approval preview. */
export const PREVIEW_TEXT_LIMIT = 200

/** Longest edge of a persisted screenshot, in CSS pixels. */
export const SCREENSHOT_MAX_DIMENSION = 1280

/**
 * Default budget for the wait between an action and the screenshot that reports it.
 *
 * Why a wait exists at all: `page.click()` returns the moment the input is dispatched, and
 * `goto` with `domcontentloaded` returns before a JS-rendered page has rendered anything. A
 * capture taken right then is the state the action STARTED from, not the state it produced.
 * Measured on a page whose own reaction takes 900 ms: the frame used to be captured 64 ms after
 * the action and still read `PENDING`, so the user reviewing it could not tell what happened.
 *
 * `graceMs` is the period we do not believe anyone yet — it covers a reaction that starts on a
 * timeout rather than synchronously. `idleMs` is how long the page must then stay quiet before we
 * accept that it has finished. `capMs` bounds the whole wait so a page that never goes quiet
 * (a long-poll, a stream, an animation loop) cannot stall a tool call.
 */
export const SETTLE_DEFAULTS = Object.freeze({
  graceMs: 250,
  idleMs: 400,
  capMs: 3000,
})

/** How often the DOM signature is sampled while waiting for the page to stop changing. */
const SETTLE_POLL_MS = 150

/**
 * Whether an error proves the page or browser is GONE, as opposed to the call being wrong.
 *
 * `TargetCloseError` and `ConnectionClosedError` are puppeteer's own exported error classes, so
 * the closed-target cases are typed. The detached-frame case is a plain `Error` from puppeteer's
 * `throwIfDisposed` (`lib/puppeteer/util/decorators.js`), so its wording is what identifies it —
 * and it is the message that actually appears when the browser process is killed.
 *
 * Deliberately NOT included: the bare `ProtocolError` parent. It also covers ordinary protocol
 * failures (a bad parameter, an unknown method), and relaunching the browser for those would hide
 * a real bug instead of recovering from a dead one.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} whether the page/browser must be re-established.
 */
function pageIsGone(error) {
  if (error instanceof TargetCloseError || error instanceof ConnectionClosedError) return true
  return error instanceof Error && error.message.startsWith('Attempted to use detached Frame')
}

export class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

/**
 * Resolve the Chrome executable to drive.
 *
 * @returns {Promise<string>} absolute path to an existing executable.
 * @throws {BrowserUnavailableError} when no candidate exists.
 */
export async function resolveChromeExecutable() {
  const { access, constants } = await import('node:fs/promises')
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  throw new BrowserUnavailableError(
    'no Chrome/Chromium executable found; install one or set DSH_CUA_CHROME_PATH. ' +
      `Checked: ${CHROME_CANDIDATES.join(', ')}`,
  )
}

/**
 * Owns one lazily-launched Chrome and one page. All methods are safe to call repeatedly.
 */
export class BrowserController {
  #browser = undefined
  #page = undefined
  #launching = undefined
  #executablePath

  /**
   * @param {object} [options]
   * @param {string} [options.executablePath] - explicit Chrome path; auto-detected when omitted.
   * @param {boolean} [options.headless] - run headless; defaults to true.
   */
  constructor(options = {}) {
    this.#executablePath = options.executablePath
    this.headless = options.headless ?? true
  }

  /** @returns {boolean} whether a browser is currently open. */
  get isOpen() {
    return this.#browser !== undefined
  }

  /**
   * Launch Chrome if it is not already running, and return the shared page.
   *
   * Concurrent callers share one launch: the in-flight promise is memoized so two tool calls
   * arriving together cannot start two browsers. The cache is validated before it is reused so a
   * browser that died (crash, OOM, SIGKILL, a closed window) is replaced instead of poisoning every
   * later call — see {@link BrowserController#dropDead}.
   *
   * @returns {Promise<import('puppeteer-core').Page>}
   */
  async page() {
    this.#dropDead()
    if (this.#page !== undefined) return this.#page
    if (this.#browser !== undefined) {
      // The browser is alive but our page is gone (its tab was closed). Reuse the browser and take
      // another tab rather than paying for a second browser process.
      const pages = await this.#browser.pages()
      this.#page = pages[0] ?? (await this.#browser.newPage())
      return this.#page
    }
    if (this.#launching !== undefined) return this.#launching
    this.#launching = this.#launch()
    try {
      this.#page = await this.#launching
      return this.#page
    } finally {
      this.#launching = undefined
    }
  }

  /**
   * Forget a cached browser or page that is provably dead.
   *
   * `browser.connected` is the signal that works, and `page.isClosed()` is not: measured against a
   * SIGKILLed Chrome, `isClosed()` still returned `false` while every call failed with
   * `Attempted to use detached Frame`. Trusting `isClosed()` alone leaves exactly the failure this
   * guard exists to fix. The browser handle is dropped without `close()` — the connection is gone,
   * so there is nothing to close and the call would only hang or throw.
   */
  #dropDead() {
    if (this.#browser !== undefined && this.#browser.connected !== true) {
      this.#browser = undefined
      this.#page = undefined
      return
    }
    if (this.#page !== undefined && this.#page.isClosed() === true) this.#page = undefined
  }

  /**
   * Run an operation against the live page, re-establishing it once if it died mid-call.
   *
   * Only used by operations that CANNOT have produced a side effect: a snapshot, an element
   * description, a screenshot, a screen probe, and a navigation (re-navigating is harmless). The
   * gated actions — click, fill, submit — are deliberately NOT retried: a replay of an input whose
   * delivery is unknown can double-act on the page, and the honest answer to the caller is that the
   * outcome is unknown.
   *
   * @param {(page: import('puppeteer-core').Page) => Promise<unknown>} operation - work to run.
   * @returns {Promise<unknown>} the operation's result.
   */
  async #withLivePage(operation) {
    const page = await this.page()
    try {
      return await operation(page)
    } catch (error) {
      if (!pageIsGone(error)) throw error
      this.#dropDead()
      return operation(await this.page())
    }
  }

  async #launch() {
    const executablePath = this.#executablePath ?? (await resolveChromeExecutable())
    const browser = await puppeteer.launch({
      executablePath,
      headless: this.headless,
      args: BASE_ARGS,
      defaultViewport: { width: 1280, height: 800 },
    })
    this.#browser = browser
    const pages = await browser.pages()
    const page = pages[0] ?? (await browser.newPage())
    return page
  }

  /**
   * Navigate the shared page.
   *
   * @param {string} url - absolute http(s) URL.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{url: string, title: string, status: number|null}>}
   */
  async navigate(url, signal) {
    return this.#withLivePage(async (page) => {
      signal?.throwIfAborted()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return { url: page.url(), title: await page.title(), status: response?.status() ?? null }
    })
  }

  /**
   * Describe an element without acting on it — used to build the approval preview.
   *
   * `label` exists so the approval prompt can name the target the way the *page* names it
   * ("在这里输入一个名字") instead of the way the DOM stores it (`<input type="text">`). The
   * priority chain below is the standard accessible-name order; `value` participates only for
   * `<input type="submit|button|reset">`, whose visible name lives there and nowhere else — for any
   * other input `value` is the field's *current contents*, which would name the element after
   * whatever happened to be typed in it.
   *
   * @param {string} selector - CSS selector.
   * @returns {Promise<object|null>} element facts, or null when the selector matches nothing.
   */
  async describe(selector) {
    return this.#withLivePage((page) => page.evaluate((css) => {
      const el = document.querySelector(css)
      if (el === null) return null
      const rect = el.getBoundingClientRect()
      const clean = (value) => (value ?? '').replace(/\s+/gu, ' ').trim()

      const tag = el.tagName.toLowerCase()
      const type = el.getAttribute('type')
      const sources = []
      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy !== null) {
        for (const id of labelledBy.split(/\s+/u)) {
          const target = document.getElementById(id)
          if (target !== null) sources.push(target.textContent)
        }
      }
      // `labels` covers both the explicit `for=` list and a wrapping `<label>`.
      if (el.labels !== undefined && el.labels !== null) {
        for (const label of Array.from(el.labels)) sources.push(label.textContent)
      }
      sources.push(el.getAttribute('aria-label'))
      sources.push(el.getAttribute('placeholder'))
      sources.push(el.getAttribute('title'))
      if (tag === 'input' && ['submit', 'button', 'reset'].includes((type ?? '').toLowerCase())) {
        sources.push(el.value)
      }
      sources.push(el.textContent)
      let label = ''
      for (const source of sources) {
        const candidate = clean(source)
        if (candidate !== '') {
          label = candidate.slice(0, 200)
          break
        }
      }

      const form = tag === 'form' ? el : el.closest('form')
      return {
        tag,
        type,
        name: el.getAttribute('name'),
        id: el.id === '' ? null : el.id,
        label,
        text: clean(el.textContent).slice(0, 200),
        form: form === null
          ? null
          : { id: form.id === '' ? null : form.id, name: form.getAttribute('name') },
        disabled: el.disabled === true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    }, selector))
  }

  /**
   * Activate a control.
   *
   * @param {string} selector - CSS selector.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{url: string}>} the URL after the click.
   */
  async click(selector, signal) {
    const page = await this.page()
    signal?.throwIfAborted()
    await page.click(selector)
    return { url: page.url() }
  }

  /**
   * Type a value into a field.
   *
   * @param {string} selector - CSS selector.
   * @param {string} value - value to enter.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{url: string}>} the URL after typing.
   */
  async fill(selector, value, signal) {
    const page = await this.page()
    signal?.throwIfAborted()
    // Replace, not append. Seeding the field empty and dispatching `input` clears whatever was
    // there — including a value written by an earlier call — and lets the page's own listeners
    // observe the cleared state before the new value is typed. Selecting-all and typing was tried
    // first and did NOT replace on a plain text input, which is why this clears explicitly.
    await page.focus(selector)
    await page.$eval(selector, (element) => {
      element.value = ''
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.type(selector, value)
    return { url: page.url() }
  }

  /**
   * Submit a form by selector (or the form enclosing `selector`).
   *
   * @param {string} selector - the form, or a field inside one.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{url: string}>} the URL after submission.
   */
  async submit(selector, signal) {
    const page = await this.page()
    signal?.throwIfAborted()
    await page.evaluate((css) => {
      const el = document.querySelector(css)
      if (el === null) throw new Error(`no element matches ${css}`)
      const form = el.tagName.toLowerCase() === 'form' ? el : el.closest('form')
      if (form === null) throw new Error(`no enclosing form for ${css}`)
      form.requestSubmit()
    }, selector)
    return { url: page.url() }
  }

  /**
   * Read the page's current state without changing it.
   *
   * @returns {Promise<{url: string, title: string, text: string}>}
   */
  async snapshot() {
    return this.#withLivePage(async (page) => {
      const text = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/gu, ' ').trim())
      return { url: page.url(), title: await page.title(), text: text.slice(0, 4000) }
    })
  }

  /**
   * Report whether the shared page is still an unloaded, empty document.
   *
   * A credential frame exists to let the user *see the screen they are approving an action
   * against*. Before the first navigation there is no such screen: the tab is `about:blank` with
   * an empty body, and rendering it produces a pure-white 1280x800 PNG (measured 4,714 bytes, the
   * same file every fresh browser produces). Showing that to the user is noise that reads as a
   * rendering failure, so the broker omits the credential frame entirely in this case.
   *
   * The predicate is deliberately narrow and provable: BOTH an unloaded URL (`about:blank` or the
   * empty string) AND a document with no child elements and no text. A real page that merely looks
   * white — a canvas app, an image-only page, a page whose CSS hides everything — keeps its URL and
   * therefore never matches, so a genuine screen is never suppressed.
   *
   * @returns {Promise<{url: string, blank: boolean}>}
   */
  async screenState() {
    return this.#withLivePage(async (page) => {
      const url = page.url()
      const unloaded = url === '' || url === 'about:blank'
      if (!unloaded) return { url, blank: false }
      const empty = await page.evaluate(() => {
        const body = document.body
        if (body === null) return (document.documentElement?.textContent ?? '').trim() === ''
        if (body.childElementCount > 0) return false
        return (body.textContent ?? '').trim() === ''
      })
      return { url, blank: empty }
    })
  }

  /**
   * Wait until the page has stopped changing, so a capture taken afterwards shows what an action
   * PRODUCED rather than what it started from.
   *
   * Two conditions must both hold, and each covers a case the other misses:
   *
   * - **The network went quiet.** `page.waitForNetworkIdle` reports no request still awaiting a
   *   response for `idleMs`. This catches a `fetch`/XHR whose answer has not arrived yet — the case
   *   where the DOM has not changed *because there is nothing to change it to*. One detail is easy to
   *   get wrong: puppeteer drops a request from that count as soon as its response HEADERS arrive
   *   (`api/Page.js` subscribes to `response` as well as `requestfinished`), so a slow response BODY
   *   does not keep a page busy — a slow server does.
   * - **The DOM stopped changing.** A cheap signature (URL, title, element count, and a hash of the
   *   body text) is sampled every {@link SETTLE_POLL_MS} and must stay identical for `idleMs`. This
   *   catches a reaction that needs no network at all.
   *
   * The network condition is checked first and the DOM condition only once it holds: a page that is
   * still fetching is still working, so its DOM would not be stable anyway. `graceMs` is waited
   * first, because a reaction scheduled on a timer has not even started when the action returns —
   * without it, "nothing has changed yet" would read as "already finished".
   *
   * The whole wait is bounded by `capMs`, so a page that never goes quiet (a stream, a long-poll, an
   * animation loop) costs the cap once. That outcome is reported as `settled: false` and carried
   * into the tool result rather than hidden, because the frame really may be mid-update.
   *
   * @param {object} [options] - overrides for this call.
   * @param {number} [options.graceMs] - period before the page is believed (default 250).
   * @param {number} [options.idleMs] - how long each condition must hold (default 400).
   * @param {number} [options.capMs] - total budget for the whole wait (default 3000).
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {Promise<{settled: boolean, ms: number, networkIdle: boolean}>} the wait's outcome.
   */
  async settle({
    graceMs = SETTLE_DEFAULTS.graceMs,
    idleMs = SETTLE_DEFAULTS.idleMs,
    capMs = SETTLE_DEFAULTS.capMs,
    signal,
  } = {}) {
    const started = Date.now()
    const deadline = started + Math.max(0, capMs)
    const remaining = () => Math.max(0, deadline - Date.now())
    signal?.throwIfAborted()

    if (graceMs > 0 && remaining() > 0) await delay(Math.min(graceMs, remaining()), undefined, { signal })

    let networkIdle = false
    if (remaining() > 0) {
      try {
        const page = await this.page()
        await page.waitForNetworkIdle({ idleTime: idleMs, timeout: remaining() })
        networkIdle = true
      } catch {
        // Advisory by construction: a timeout, or a page that died while waiting, must never fail
        // the action that already happened. `TimeoutError` is the expected case here.
        networkIdle = false
      }
    }

    let domStable = false
    if (networkIdle && remaining() > 0) domStable = await this.#domStableFor(idleMs, remaining(), signal)

    return { settled: networkIdle && domStable, ms: Date.now() - started, networkIdle }
  }

  /**
   * Whether the DOM signature stayed identical for `idleMs`, within `budget` milliseconds.
   *
   * A signature read that throws counts as a change, not as stability: the usual cause is a
   * navigation tearing down the execution context, which is the opposite of "nothing is happening".
   *
   * @param {number} idleMs - how long the signature must hold.
   * @param {number} budget - milliseconds left for this condition.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<boolean>} whether the DOM went quiet in time.
   */
  async #domStableFor(idleMs, budget, signal) {
    const deadline = Date.now() + budget
    let previous
    let unchangedSince = 0
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      let signature
      try {
        signature = await this.#signature()
      } catch (error) {
        // A page that is gone is the caller's problem to recover from, not a stability signal.
        if (pageIsGone(error)) throw error
        signature = `unreadable:${Date.now()}`
      }
      if (signature === previous) {
        if (Date.now() - unchangedSince >= idleMs) return true
      } else {
        previous = signature
        unchangedSince = Date.now()
      }
      const left = deadline - Date.now()
      if (left > 0) await delay(Math.min(SETTLE_POLL_MS, left), undefined, { signal })
    }
    return false
  }

  /**
   * A cheap fingerprint of the page's rendered state, read inside the page.
   *
   * `textContent` rather than `innerText`: it answers the same question without forcing layout on
   * every poll. The explicit hash is what catches an in-place change that keeps the same length —
   * a digit becoming another digit, which a length-only signature would read as "no change".
   *
   * @returns {Promise<string>} the signature.
   */
  async #signature() {
    return this.#withLivePage((page) => page.evaluate(() => {
      const body = document.body
      const text = body === null ? '' : (body.textContent ?? '')
      let hash = 2166136261
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619) >>> 0
      }
      return [
        document.location.href,
        document.title,
        document.querySelectorAll('*').length,
        text.length,
        hash,
      ].join('|')
    }))
  }

  /**
   * Render the current screen to a PNG file and return its metadata.
   *
   * This is the "screenshot feedback" half of the ZCode borrow: ZCode captures the live
   * browser frame and carries it into the result the user reviews
   * (`browser-turn-screenshot.ts`). Here the frame is captured at *ask* time, because the DSH
   * approval precedes the action rather than following it.
   *
   * @param {object} options
   * @param {string} options.directory - directory to write the PNG into.
   * @param {string} options.name - file name (without directory).
   * @returns {Promise<{path: string, mimeType: string, byteLength: number, width: number, height: number, data: Buffer}>}
   */
  async screenshotToFile({ directory, name }) {
    return this.#withLivePage(async (page) => {
      const data = Buffer.from(await page.screenshot({ type: 'png', encoding: 'base64' }), 'base64')
      const path = join(directory, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
      const viewport = page.viewport() ?? { width: 0, height: 0 }
      return {
        path,
        mimeType: 'image/png',
        byteLength: data.byteLength,
        width: viewport.width,
        height: viewport.height,
        data,
      }
    })
  }

  /** Close the browser and release the page. Safe to call when nothing is open. */
  async close() {
    const browser = this.#browser
    this.#browser = undefined
    this.#page = undefined
    // A browser that is already gone has nothing to close, and asking it to would hang or throw
    // during teardown — the one place an exception helps nobody.
    if (browser !== undefined && browser.connected === true) {
      try {
        await browser.close()
      } catch {
        // The process died between the check and the close; teardown is still complete.
      }
    }
  }
}