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
import puppeteer from 'puppeteer-core'

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
   * arriving together cannot start two browsers.
   *
   * @returns {Promise<import('puppeteer-core').Page>}
   */
  async page() {
    if (this.#page !== undefined) return this.#page
    if (this.#launching !== undefined) return this.#launching
    this.#launching = this.#launch()
    try {
      this.#page = await this.#launching
      return this.#page
    } finally {
      this.#launching = undefined
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
    const page = await this.page()
    signal?.throwIfAborted()
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null }
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
    const page = await this.page()
    return page.evaluate((css) => {
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
    }, selector)
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
    const page = await this.page()
    const text = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/gu, ' ').trim())
    return { url: page.url(), title: await page.title(), text: text.slice(0, 4000) }
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
    const page = await this.page()
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
    const page = await this.page()
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
  }

  /** Close the browser and release the page. Safe to call when nothing is open. */
  async close() {
    const browser = this.#browser
    this.#browser = undefined
    this.#page = undefined
    if (browser !== undefined) await browser.close()
  }
}