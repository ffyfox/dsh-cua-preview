/**
 * Acceptance harness for dsh-cua-preview.
 *
 * This script is the runnable entry required by acceptance criterion 3. It reproduces
 * criteria 1 and 2 against the **real** DSH runtime — the same Cordis `Loader`, the same
 * `dsh-tools` registry, the same `dsh-user-approval` service and the same `dsh-attachment`
 * store that the shipped product mounts. Nothing here is a stub of a DSH interface.
 *
 * What it proves:
 *   1. DSH loads the plugin through its documented loader and the plugin's browser tools are
 *      listed in the registry.
 *   2. A click / form-submit through `browser_act` produces exactly one `approval/asked` +
 *      `approval/decided` audit pair on the session, and the approval carries a screenshot that
 *      exists on disk and parses as a real PNG.
 *
 * Usage:  node examples/run-acceptance.mjs
 * Exit code 0 = every check passed.
 */

import { strict as assert } from 'node:assert'
import { readFile, mkdtemp, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { KNOWN_SESSION_EVENT_TYPES as KNOWN_SET } from '@deepseek-ai/dsh-session'

/** The event types the harness itself writes into this session: turn enclosure plus the audit pair. */
const HARNESS_LOG_EVENTS = new Set(['turn/start', 'approval/asked', 'approval/decided'])

const PLUGIN_PATH = resolve(import.meta.dirname, '../src/index.js')
const TOOL_NAMES = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_act']

/** Collected evidence, printed as a machine-readable report at the end. */
const report = { checks: [], failed: 0 }

function check(name, condition, detail) {
  const ok = Boolean(condition)
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  if (!ok) report.failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
  return ok
}

// ---------------------------------------------------------------------------------------------
// Criterion 1 — the plugin loads through the official loader and its tools are listed.
// ---------------------------------------------------------------------------------------------

console.log('\n=== Criterion 1: plugin loads and registers tools ===\n')

const artifactsDir = await mkdtemp(join(tmpdir(), 'dsh-cua-preview-'))
const profileDir = await mkdtemp(join(tmpdir(), 'dsh-cua-profile-'))
await mkdir(artifactsDir, { recursive: true })

// The loader reads a patch-shaped overlay exactly as `dsh --patch <file>` does. The relative
// specifier resolves through Node resolution, which is how a bundle row addresses its code
// (docs/user/develop/basic/publish.md).
const overlay = [
  '- insert:',
  '    - id: cua-preview',
  `      name: '${PLUGIN_PATH}'`,
  '      config:',
  `        artifactsDir: '${artifactsDir}'`,
  '        headless: true',
  '',
].join('\n')
const overlayPath = join(profileDir, 'cordis.patch.yml')
await (await import('node:fs/promises')).writeFile(overlayPath, overlay)

const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: `file://${profileDir}/` })

const loadErrors = []
ctx.on('internal/error', (_fiber, error) => { loadErrors.push(error) })

// Mount the services the plugin declares in `inject`, then the plugin row itself.
// `dsh-tools` itself injects `systemPrompt`, so that service is mounted first.
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const { default: Approval } = await import('@deepseek-ai/dsh-user-approval')
const { default: AttachmentLocal } = await import('@deepseek-ai/dsh-attachment-local')
const { default: SessionService } = await import('@deepseek-ai/dsh-session')

await ctx.plugin(SystemPrompt)
await ctx.plugin(SessionService)
await ctx.plugin(Tools)
await ctx.plugin(AttachmentLocal, { root: join(artifactsDir, 'attachments') })
await ctx.plugin(Approval, { policy: 'ask' })

// Load the plugin the documented way: a loader entry naming the module. `create()` inserts the
// row; `await()` waits for every entry to settle, which is the Loader's own readiness boundary.
await ctx.loader.create({
  id: 'cua-preview',
  name: PLUGIN_PATH,
  config: { artifactsDir, headless: true },
})
await ctx.loader.await()

// Wait for the plugin fiber to become active (dependency-driven loading).
const { cuaPreviewOf } = await import('../src/index.js')
const deadline = Date.now() + 20_000
while (cuaPreviewOf({ artifactsDir }) === undefined && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50))
}

check('loader reported no errors', loadErrors.length === 0,
  loadErrors.map((e) => e?.message ?? String(e)).join('; ') || 'none')

const cuaPreview = cuaPreviewOf({ artifactsDir })
check('plugin applied and exposed its live instance', cuaPreview !== undefined)
assert.ok(cuaPreview !== undefined, 'plugin did not load')

const listed = TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName) !== undefined)
check('all four browser tools are listed in ctx.tools',
  listed.length === TOOL_NAMES.length,
  `listed: ${listed.join(', ')}`)

// ---------------------------------------------------------------------------------------------
// Criterion 2 — a click raises one approval whose screenshot is a real PNG.
// ---------------------------------------------------------------------------------------------

console.log('\n=== Criterion 2: approval popup + screenshot ===\n')

// A live agent with an open turn, so `ctx.approval.request` is legal. The approval seam
// requires turn enclosure (dsh-user-approval: "approval.request() outside an open turn").
const { brandString } = await import('@deepseek-ai/dsh-brand')
const sessionId = brandString(`cua-acceptance-${Date.now()}`)

const agent = await makeAgentWithOpenTurn(ctx, sessionId)

// Stand up a human answerer: the terminal listener of the `approval/request` waterfall.
// This stands in for the browser panel that the shipped web profile mounts; the *seam* being
// exercised is the real one either way.
let answererCalls = 0
const askedEvents = []
const decidedEvents = []

/**
 * Probes the answerer runs while an approval is open.
 *
 * A probe is how this harness stands where the operator's browser stands: the screen has to be
 * readable *during* the question, not only afterwards.
 */
const approvalProbes = []

ctx.on('approval/request', async (req) => {
  answererCalls += 1
  // Probes run *inside* the ask, which is the only moment the pending-frame route is for.
  for (const probe of approvalProbes) await probe(req)
  return 'allowed-once'
})

// Observe the durable audit pair on the session log. Events are collected only from a seq
// watermark onward, so each action's approval is counted independently of the ones before it.
const session = agent.session
let auditWatermark = 0
const auditSeen = () => {
  askedEvents.length = 0
  decidedEvents.length = 0
  for (let seq = auditWatermark; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'approval/asked') askedEvents.push(event)
    if (event?.type === 'approval/decided') decidedEvents.push(event)
  }
  auditWatermark = session.seq
}
auditSeen()

// ---------------------------------------------------------------------------------------------
// The pending-approval frame route — the screen has to reach the DECISION, not just the record.
// ---------------------------------------------------------------------------------------------
//
// While an approval is open nothing has been logged yet, so the frame cannot be read out of the
// session log: the call has produced no result, and the client-side image loader only resolves
// references a known event carries. The Host therefore holds the frame it captured an instant
// earlier (`src/pending-frames.js`) and serves it on the exact Fetch route the Connection documents
// for a browser-native response (`docs/api-gateway.md`: "A feature that needs a streamed or
// browser-native response registers an exact Connection Fetch route instead of defining a Remote
// method").
//
// This section asks that route at the only moment it exists for: from inside the answerer, for the
// very call being decided. The handler and the table behind it are the live ones; what this harness
// does not mount is the Connection's own registration plumbing, so the registration call itself is
// checked against a stub carrying the documented shape.

console.log('\n=== The pending-approval frame route ===\n')

const { FRAME_ROUTE, registerFrameRoute } = await import('../src/frame-route.js')
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

check('a host with no exact-Fetch registry registers no route, and the plugin still loads',
  registerFrameRoute(ctx, cuaPreview.frames, undefined).registered === false)

const routes = []
let effectCalls = 0
let injectedDeps = null

/** The effect stub, counting how many registrations are owned by an effect (and so are undone). */
const effectStub = (callback) => {
  effectCalls += 1
  const disposer = callback()
  return () => {
    if (typeof disposer === 'function') disposer()
  }
}

// A context shaped like a Cordis one. The route is not registered from a one-shot read: `connection`
// is not a dependency of this plugin, so the registration goes through `ctx.inject` and attaches when
// that service appears. Measured against the real web profile, a one-shot `ctx.get` inside `apply`
// found nothing while a later read found the registry — the inject path is the one that works.
const routeCtx = {
  effect: effectStub,
  get: () => undefined,
  inject: (deps, callback) => {
    injectedDeps = deps
    callback({
      connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
      effect: effectStub,
    })
  },
}
const routeRegistration = registerFrameRoute(routeCtx, cuaPreview.frames, undefined)
check('the route is registered once, on the path the client asks for',
  routes.length === 1 && routes[0]?.path === FRAME_ROUTE && FRAME_ROUTE === '/api/cua-preview.frame',
  routes.map((route) => route.path).join(', '))
check('  ↳ as an exact GET/HEAD route with its body handling declared up front',
  JSON.stringify(routes[0]?.methods) === JSON.stringify(['GET', 'HEAD']) &&
    routes[0]?.requestBody === 'buffered' && typeof routes[0]?.fetch === 'function',
  `methods=${JSON.stringify(routes[0]?.methods)} requestBody=${String(routes[0]?.requestBody)}`)
check('  ↳ it attaches by waiting for the connection service, not by reading it once',
  JSON.stringify(injectedDeps) === JSON.stringify(['connection']), JSON.stringify(injectedDeps))
check('  ↳ the registration lives inside an effect, so unloading withdraws it',
  effectCalls === 1 && routeRegistration.registered === true &&
    routeRegistration.path === FRAME_ROUTE && routeRegistration.reason === null,
  JSON.stringify(routeRegistration))

/**
 * Ask the registered route for one call, the way the operator's browser does.
 *
 * @param callId - the call whose frame is wanted; an empty string asks for none.
 * @param method - `GET` (the picture) or `HEAD` (is it there yet).
 * @returns {Promise<{status: number, type: string|null, cache: string|null, body: Buffer|null}>}
 */
async function askFrameRoute(callId, method = 'GET') {
  const handler = routes[0]?.fetch
  const url = `http://127.0.0.1${FRAME_ROUTE}?callId=${encodeURIComponent(callId)}`
  const response = await handler(new Request(url, { method }))
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    cache: response.headers.get('cache-control'),
    body: method === 'HEAD' ? null : Buffer.from(await response.arrayBuffer()),
  }
}

// Armed for the gated click below: the probe asks the route from inside the ask.
let duringAsk = null
let headDuringAsk = null
approvalProbes.push(async (req) => {
  duringAsk = await askFrameRoute(req.callId)
  headDuringAsk = await askFrameRoute(req.callId, 'HEAD')
})

// Drive the page to a known state, then perform a gated click that also submits a form.
const tool = ctx.tools.get('browser_act')
assert.ok(tool !== undefined)

const pageHtml = `<!doctype html><html><body>
  <h1 id="heading">CUA acceptance page</h1>
  <form id="f" onsubmit="event.preventDefault();document.getElementById('heading').textContent='FORM SUBMITTED'">
    <input id="q" name="q" type="text" />
    <button id="go" type="submit">Submit</button>
  </form>
</body></html>`

const browser = cuaPreview.browser
const page = await browser.page()
await page.setContent(pageHtml)

const execBase = {
  agent,
  callId: brandString('call-cua-acceptance-1'),
  signal: new AbortController().signal,
}

const clickResult = await tool.execute({ action: 'click', selector: '#go' }, execBase)

auditSeen()

// ---- The screen was already readable while the card was open ---------------------------------
//
// `duringAsk` was captured from inside the answerer, so it describes the route at the exact moment
// the operator would be looking at the card — not after the action had run.

approvalProbes.length = 0

check('while the approval was open, the current screen was already servable',
  duringAsk?.status === 200 && duringAsk?.type === 'image/png',
  JSON.stringify({ status: duringAsk?.status, type: duringAsk?.type }))
check('  ↳ and it is a complete PNG, not an empty body',
  duringAsk?.body !== null && duringAsk.body.byteLength > 0 &&
    duringAsk.body.subarray(0, 8).equals(PNG_MAGIC),
  `bytes=${duringAsk?.body?.byteLength ?? 0}`)
{
  const approvalFrame = await readFile(clickResult.approvalScreenshotPath)
  check('  ↳ the bytes are the approval-time frame itself',
    duringAsk?.body?.equals(approvalFrame) === true,
    `route=${duringAsk?.body?.byteLength ?? 0}B file=${approvalFrame.byteLength}B`)
}
check('  ↳ marked no-store, so one call id is never served a stale picture',
  duringAsk?.cache === 'no-store', String(duringAsk?.cache))
check('  ↳ a HEAD ask answers with the same status and no body',
  headDuringAsk?.status === 200 && headDuringAsk?.body === null && headDuringAsk?.type === 'image/png',
  JSON.stringify({ status: headDuringAsk?.status, type: headDuringAsk?.type }))

{
  const settled = await askFrameRoute(execBase.callId)
  check('once the call has settled the route serves nothing: the result carries the frame',
    settled.status === 404, `status=${settled.status}`)
}
check('an unknown call id is a 404, not an error',
  (await askFrameRoute('call-that-never-happened')).status === 404)
check('a request naming no call at all is reported as malformed',
  (await askFrameRoute('')).status === 400)

check('exactly one approval/asked was appended', askedEvents.length === 1,
  `count=${askedEvents.length}`)
check('exactly one approval/decided was appended', decidedEvents.length === 1,
  `count=${decidedEvents.length}`)
check('the approval decision is allowed-once',
  decidedEvents[0]?.data?.outcome === 'allowed-once',
  `outcome=${decidedEvents[0]?.data?.outcome}`)
check('the approval carries the correlated tool call id',
  askedEvents[0]?.data?.callId === execBase.callId,
  `callId=${askedEvents[0]?.data?.callId}`)

// `reason` is the seam's one-line explanation of WHY the asker is asking
// (`docs/subsystems/approval.md`), and the shipped panel renders it as the card's headline. The
// screenshot is not carried here: it has its own routes — the pending-frame route while the ask is
// open, and the call's own result afterwards.
{
  const reason = askedEvents[0]?.data?.reason
  check('the approval reason is a single line',
    typeof reason === 'string' && !reason.includes('\n'), JSON.stringify(reason))
  check('the approval reason carries no path and no byte/size metadata',
    typeof reason === 'string' &&
      !reason.includes('screenshot:') && !reason.includes('.png') &&
      !/image\/png/.test(reason) && !/\d+x\d+/.test(reason) && !/\d+ bytes/.test(reason),
    JSON.stringify(reason))
  check('the approval reason still says what is about to happen',
    typeof reason === 'string' && reason.includes('#go'),
    JSON.stringify(reason))
  // The exact sentence, not just a substring: the target is named the way the PAGE names it (this
  // fixture's button carries the visible text "Submit") with the selector kept in parentheses,
  // because the approval is consent for one exact element.
  check('the approval reason names the target the way the page does',
    reason === 'Click the button "Submit" (#go)', JSON.stringify(reason))
}

// The screenshot file the approval advertised must exist and be a real PNG.
check('the action actually ran after approval',
  clickResult.granted === true, `granted=${clickResult.granted}`)

const shotPath = clickResult.screenshotPath
check('a screenshot path was reported', typeof shotPath === 'string' && shotPath.length > 0, shotPath)

let png = null
try {
  png = await readFile(shotPath)
} catch (error) {
  check('the screenshot file exists on disk', false, String(error))
}
if (png !== null) {
  check('the screenshot file exists on disk', true, shotPath)
  const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  check('the screenshot parses as a PNG (magic bytes)', isPng,
    `magic=${png.subarray(0, 8).toString('hex')} bytes=${png.byteLength}`)
  // IHDR carries the real dimensions, so this is a structural parse rather than a header sniff.
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  check('the PNG has non-zero dimensions', width > 0 && height > 0, `${width}x${height}`)
  check('the PNG carries an IEND chunk (complete file)',
    png.subarray(png.byteLength - 8, png.byteLength - 4).toString('ascii') === 'IEND')
}

check('the approval was persisted through the attachment service',
  clickResult.image !== undefined && typeof clickResult.image?.attachmentId === 'string',
  `attachmentId=${clickResult.image?.attachmentId}`)

check('the human answerer was consulted exactly once', answererCalls === 1, `calls=${answererCalls}`)

// ---- The screenshot must be the POST-action frame, not the approval frame -------------------
//
// This is the property a real conversation exposed as broken: the tool used to return the
// pre-action approval frame, so a model read it as "the click did nothing". The two frames are
// asserted to be different files with different bytes, and the returned one is named as the
// post-action frame.

console.log('\n--- screenshot timing ---\n')

check('the tool reports the approval-time frame separately',
  typeof clickResult.approvalScreenshotPath === 'string' && clickResult.approvalScreenshotPath.endsWith('.png'),
  clickResult.approvalScreenshotPath)
check('the returned screenshot is named as the post-action frame',
  typeof shotPath === 'string' && shotPath.includes('after-'),
  shotPath)
check('the approval frame is named as the approval frame',
  typeof clickResult.approvalScreenshotPath === 'string' && clickResult.approvalScreenshotPath.includes('approval-'),
  clickResult.approvalScreenshotPath)

{
  const approvalPng = await readFile(clickResult.approvalScreenshotPath)
  const resultPng = await readFile(clickResult.screenshotPath)
  check('the approval frame and the result frame are different images',
    !approvalPng.equals(resultPng),
    `approval=${approvalPng.byteLength}B result=${resultPng.byteLength}B`)
}

// The result frame must reflect the state the action produced. The page turns its banner green on
// click, so a post-action capture differs from a pre-action one in the rendered pixels.
{
  const approvalPng = await readFile(clickResult.approvalScreenshotPath)
  const resultPng = await readFile(clickResult.screenshotPath)
  // Compare decoded-pixel proxies: PNG byte equality already proved they differ, and the
  // post-action frame is the larger one here because the banner carries more coloured area.
  check('the two frames differ in encoded size (the page changed between them)',
    approvalPng.byteLength !== resultPng.byteLength,
    `${approvalPng.byteLength} vs ${resultPng.byteLength}`)
}

// ---- The approved frame travels inside the call's own result ----------------------------------
//
// The frame the user APPROVED is the audit credential and must stay visible in the conversation.
// It travels as an image block inside the call's own `tool/result` content, which is the one
// position the Host's attachment authorizer scans (`dsh-api-session-controller`'s `imageInEvent`
// reads `data.content`, `data.message.content`, `data.inserted[].content` and assistant stream
// chunks; a reference anywhere else answers `ATTACHMENT_NOT_REFERENCED`). The card learns which
// frame is which from `presentationMeta.frames`, which the core persists on `tool/result` as
// `result.meta` (`docs/cookbook/adding-a-tool.md`: "Project durable card data with
// `presentationMeta`").
//
// An earlier revision referenced the frame from a plugin-owned `cua/preview` event instead. That
// event type is outside the harness's vocabulary, and a live `Session.append()` cannot set the
// envelope's `ignorable: true` marker, so the persistence reader refused every session that had run
// a gated action: "contains event type "cua/preview" (seq 9403) unknown to this harness and not
// marked ignorable; refusing to interpret the log". This plugin now appends NOTHING, and the checks
// below hold that line from both ends: no event type outside the harness vocabulary may appear in
// the log, and the frames must be referenced from the content block the authorizer scans.

console.log('\n--- approval credential channel ---\n')

{
  const args = { action: 'click', selector: '#go' }
  const content = tool.output.render(args, clickResult)
  const imageBlocks = content.filter((block) => block.type === 'image')

  check('the model-facing content carries both frames of the action',
    imageBlocks.length === 2, `images=${imageBlocks.length}`)
  check('the first frame is the screen the user approved',
    imageBlocks[0]?.attachment?.attachmentId === clickResult.approvalImage?.attachmentId,
    `${imageBlocks[0]?.attachment?.attachmentId}`)
  check('the second frame is the post-action state',
    imageBlocks[1]?.attachment?.attachmentId === clickResult.image.attachmentId,
    `${imageBlocks[1]?.attachment?.attachmentId}`)
  check('the two frames are different attachments (the page changed between them)',
    imageBlocks[0]?.attachment?.attachmentId !== imageBlocks[1]?.attachment?.attachmentId)

  const meta = tool.output.presentationMeta(args, clickResult)
  check('the card projection names each frame role in presentation order',
    JSON.stringify(meta?.frames) === JSON.stringify(['before', 'after']), JSON.stringify(meta?.frames))
  check('the card projection reports the grant',
    meta?.granted === true && meta?.decision === 'allowed-once', JSON.stringify(meta))
  check('the card projection keeps the approved frame file for audit',
    meta?.approvedPath === clickResult.approvalScreenshotPath, String(meta?.approvedPath))
  check('the card projection survives a JSON round trip losslessly',
    JSON.stringify(JSON.parse(JSON.stringify(meta))) === JSON.stringify(meta))
  check('the approved frame is referenced from a content block, not from meta alone',
    imageBlocks.some((block) => block.attachment?.attachmentId === clickResult.approvalImage?.attachmentId),
    'the Host authorizer scans data.content, never result.meta')

  // ---- The defect this design replaced, and the checks that keep it out ----------------------
  check('the plugin appends no event type outside the harness vocabulary',
    unknownEventTypes(session).length === 0,
    unknownEventTypes(session).join(', ') || 'every event in the log is one the harness writes')
  check('the plugin appends nothing to the Session log at all',
    sessionEventTypes(session).every((type) => HARNESS_LOG_EVENTS.has(type)),
    sessionEventTypes(session).join(', '))
  check('no plugin-written event references the frames (the pipeline result is their only carrier)',
    !sessionReferencesImage(session, clickResult.approvalImage.attachmentId) &&
      !sessionReferencesImage(session, clickResult.image.attachmentId))
  check('the Host read rule does NOT authorize an unreferenced attachment (control)',
    !sessionReferencesImage(session, 'sha256:definitely-not-in-this-session'))
  check('a real screen produces a credential frame (the blank-screen suppression did not fire)',
    cuaPreview.broker.decisions.at(-1)?.frameOmitted === null,
    JSON.stringify({ frameOmitted: cuaPreview.broker.decisions.at(-1)?.frameOmitted }))
}

// ---- `browser_navigate` must return the page it actually loaded -------------------------------
//
// Two defects met in this path. First, the tool used to return a 4,714-byte blank frame because the
// screenshot was taken BEFORE `page.goto`, so the model saw an empty tab. Second, once the pre- and
// post-action frames were split, the credential frame of a first navigation was still that same
// white rectangle — the tab genuinely is blank before the first navigation. The operator's decision
// was to emit NO credential frame for a blank screen (and no explanatory text either), so this
// section pins both halves: the blank case omits the frame, and the loaded case still produces one.

console.log('\n--- navigation ---\n')

const navServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html><head><title>CUA navigate page</title></head>' +
    '<body><h1>NAVIGATED</h1></body></html>')
})
await new Promise((done) => navServer.listen(0, '127.0.0.1', done))
const navUrl = `http://127.0.0.1:${navServer.address().port}/`

try {
  // A genuine blank baseline from THIS browser at THIS viewport: the defect returned a frame that
  // was indistinguishable from this. The page is left blank, so the navigate approval is raised
  // against an empty tab exactly like the real conversation that found the bug.
  await page.goto('about:blank')
  const screenState = await browser.screenState()
  check('the browser reports an unloaded empty tab as blank',
    screenState.blank === true && screenState.url === 'about:blank', JSON.stringify(screenState))
  const blank = await browser.screenshotToFile({ directory: artifactsDir, name: 'baseline-blank.png' })

  const navTool = ctx.tools.get('browser_navigate')
  const navArgs = { url: navUrl }
  auditSeen()
  const navResult = await navTool.execute(
    navArgs,
    { ...execBase, callId: brandString('call-cua-acceptance-navigate') },
  )
  auditSeen()

  check('navigate raised exactly one approval/asked', askedEvents.length === 1, `count=${askedEvents.length}`)
  check('navigate raised exactly one approval/decided', decidedEvents.length === 1, `count=${decidedEvents.length}`)
  check('navigate reports a one-shot grant',
    navResult.granted === true && navResult.decision === 'allowed-once', `decision=${navResult.decision}`)
  check('navigate reports the page it actually loaded',
    navResult.title === 'CUA navigate page' && navResult.url === navUrl,
    `title="${navResult.title}" url=${navResult.url}`)

  const navContent = navTool.output.render(navArgs, navResult)
  const navImages = navContent.filter((block) => block.type === 'image')
  check('a blank-screen navigation returns one image: only the post-navigation frame exists',
    navImages.length === 1, `images=${navImages.length}`)
  check('that image is the post-navigation attachment',
    navImages[0]?.attachment?.attachmentId === navResult.image.attachmentId,
    `${navImages[0]?.attachment?.attachmentId}`)

  const navPng = await readFile(navResult.screenshotPath)
  check('the returned navigate frame is NOT the blank tab',
    !navPng.equals(blank.data), `${navPng.byteLength}B vs blank ${blank.data.byteLength}B`)

  // ---- The blank-screen rule --------------------------------------------------------------
  const navMeta = navTool.output.presentationMeta(navArgs, navResult)
  check('a blank screen reports no approval-time screenshot path',
    navResult.approvalScreenshotPath === undefined, String(navResult.approvalScreenshotPath))
  check('a blank screen hands the card no credential reference',
    navResult.approvalImage === undefined,
    `approvalImage=${String(navResult.approvalImage)}`)
  check('a blank screen names one frame role: the post-navigation one',
    JSON.stringify(navMeta?.frames) === JSON.stringify(['after']), JSON.stringify(navMeta?.frames))
  check('a blank screen still writes nothing to the Session log',
    unknownEventTypes(session).length === 0,
    unknownEventTypes(session).join(', ') || sessionEventTypes(session).join(', '))
  check('the broker records that it omitted the frame because the screen was blank',
    cuaPreview.broker.decisions.at(-1)?.frameOmitted === 'blank-screen',
    `frameOmitted=${String(cuaPreview.broker.decisions.at(-1)?.frameOmitted)}`)
  check('the omission is not reported as a capture failure',
    cuaPreview.broker.decisions.at(-1)?.captureError === null,
    `captureError=${String(cuaPreview.broker.decisions.at(-1)?.captureError)}`)
  check('the navigate card projection still reports the grant',
    navMeta?.granted === true, JSON.stringify(navMeta))

  // ---- Positive control: the same tool on a loaded screen DOES produce a credential --------
  auditSeen()
  const secondNav = await navTool.execute(
    { url: navUrl },
    { ...execBase, callId: brandString('call-cua-acceptance-navigate-2') },
  )
  auditSeen()
  check('a loaded screen still produces a credential frame',
    typeof secondNav.approvalScreenshotPath === 'string' && secondNav.approvalScreenshotPath.length > 0,
    String(secondNav.approvalScreenshotPath))
  check('a loaded screen hands the card the credential reference',
    secondNav.approvalImage !== undefined && secondNav.approvalImage.attachmentId.length > 0,
    String(secondNav.approvalImage?.attachmentId))
  check('a loaded screen returns both frames, the approved one first',
    (() => {
      const blocks = navTool.output.render(navArgs, secondNav).filter((block) => block.type === 'image')
      return blocks.length === 2 &&
        blocks[0].attachment.attachmentId === secondNav.approvalImage.attachmentId &&
        blocks[1].attachment.attachmentId === secondNav.image.attachmentId
    })(),
    'the row paints them in that order')
  check('a loaded screen names both frame roles',
    JSON.stringify(navTool.output.presentationMeta(navArgs, secondNav)?.frames) ===
      JSON.stringify(['before', 'after']),
    JSON.stringify(navTool.output.presentationMeta(navArgs, secondNav)?.frames))
  check('the blank-screen suppression did not fire for the loaded screen',
    cuaPreview.broker.decisions.at(-1)?.frameOmitted === null,
    `frameOmitted=${String(cuaPreview.broker.decisions.at(-1)?.frameOmitted)}`)
  check('the second navigate credential is not the blank tab',
    !(await readFile(secondNav.approvalScreenshotPath)).equals(blank.data),
    secondNav.approvalScreenshotPath)
} finally {
  await new Promise((done) => navServer.close(done))
}

// ---- The form-submit path, which the task names alongside click ------------------------------

console.log('\n--- form submission ---\n')

await page.setContent(pageHtml)
auditSeen()
const submitResult = await tool.execute(
  { action: 'submit', selector: '#f' },
  { ...execBase, callId: brandString('call-cua-acceptance-2') },
)
auditSeen()

check('a form submit raises its own approval/asked', askedEvents.length === 1,
  `count=${askedEvents.length}`)
check('a form submit raises its own approval/decided', decidedEvents.length === 1,
  `count=${decidedEvents.length}`)
check('the form submit was approved and ran', submitResult.granted === true,
  `granted=${submitResult.granted}`)
const submittedText = await page.$eval('#heading', (el) => el.textContent)
check('the form submit actually changed the page', submittedText === 'FORM SUBMITTED',
  `heading="${submittedText}"`)
check('the form submit carried its own screenshot',
  typeof submitResult.screenshotPath === 'string' && submitResult.screenshotPath.endsWith('.png'),
  submitResult.screenshotPath)
check('two distinct screenshots were captured for two actions',
  clickResult.screenshotPath !== submitResult.screenshotPath,
  `${clickResult.screenshotPath} vs ${submitResult.screenshotPath}`)

// ---- `fill` must REPLACE, not append --------------------------------------------------------
//
// A real conversation found this appending: the field held "Alice", a second fill wrote "Bob", and
// the page showed "AliceBob". Selecting-all and typing does not reliably replace a plain text
// input, so the implementation now clears the field explicitly.

console.log('\n--- fill semantics ---\n')

await page.setContent(`<!doctype html><html><body>
  <input id="field" type="text" />
</body></html>`)
auditSeen()
const fillFirst = await tool.execute(
  { action: 'fill', selector: '#field', value: 'Alice' },
  { ...execBase, callId: brandString('call-cua-acceptance-fill-1') },
)
const afterFirst = await page.$eval('#field', (el) => el.value)

auditSeen()
const fillSecond = await tool.execute(
  { action: 'fill', selector: '#field', value: 'Bob' },
  { ...execBase, callId: brandString('call-cua-acceptance-fill-2') },
)
const afterSecond = await page.$eval('#field', (el) => el.value)

check('a first fill writes the value', fillFirst.granted === true && afterFirst === 'Alice',
  `granted=${fillFirst.granted} value="${afterFirst}"`)
check('a second fill REPLACES the previous value rather than appending',
  afterSecond === 'Bob', `value="${afterSecond}" (appending would give "AliceBob")`)
check('the replacement fill still ran under its own approval',
  fillSecond.granted === true && fillSecond.decision === 'allowed-once',
  `decision=${fillSecond.decision}`)

// ---- The form-submit path, which the task names alongside click ------------------------------

// ---------------------------------------------------------------------------------------------
// The post-action frame must be the page's REACTION, not the state the action started from.
// ---------------------------------------------------------------------------------------------
//
// The failure this section pins down, measured on a page whose own reaction takes 900 ms:
// `page.click()` returned after 23 ms and the frame was captured 64 ms in, so the image the user
// was asked to judge still read `PENDING` — the page had not reacted yet.
//
// `examples/test-page/slow.html` is that page as a fixture. This section takes two references
// directly from the same browser — what a no-wait capture shows (the old behaviour) and what the
// settled page shows — and then requires the TOOL's frame to be the second and not the first.

console.log('\n--- post-action settle ---\n')

const slowPageHtml = await readFile(join(import.meta.dirname, 'test-page/slow.html'), 'utf8')

const settleServer = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/never') {
    // Never answer at all — not even the headers. Puppeteer's inflight accounting decrements as soon
    // as a response's HEADERS arrive (`api/Page.js`: on `requestfailed`, `requestfinished`, or
    // `response`), so a slow BODY does not keep a page busy; only a request still awaiting a
    // response does. A request awaiting a response forever is therefore the case that makes the
    // "network went quiet" condition unreachable, which is what the budget exists to bound.
    request.on('close', () => response.destroy())
    return
  }
  if (path === '/stream-page') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><html><head><title>CUA stream page</title></head><body>' +
      '<h1 id="head">STREAM</h1><button id="go" type="button">go</button>' +
      '<script>fetch("/never").catch(() => {})</script></body></html>')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(slowPageHtml)
})
await new Promise((done) => settleServer.listen(0, '127.0.0.1', done))
const settleBase = `http://127.0.0.1:${settleServer.address().port}`
const slowUrl = `${settleBase}/slow.html`
const settleNavTool = ctx.tools.get('browser_navigate')

// ---- The config surface, before anything touches a browser -----------------------------------
//
// `settle` is new public configuration, so the parsing rules are pinned here rather than assumed:
// the documented default, the disable switch, the shorthand number, the partial object, and the
// refusal of everything else (logged and replaced, never thrown — a wrong timer must not stop the
// plugin from loading).
{
  const { settleOptionsOf } = await import('../src/index.js')
  const DEFAULTS = { graceMs: 250, idleMs: 400, capMs: 3000 }
  const required = tool.output.schema.required

  check('the settle fields are optional in the declared output schema',
    !required.includes('settled') && !required.includes('settleMs') && !required.includes('networkBusy'),
    `required=${JSON.stringify(required)}`)
  check('an omitted settle config is the documented default',
    JSON.stringify(settleOptionsOf({})) === JSON.stringify(DEFAULTS), JSON.stringify(settleOptionsOf({})))
  check('settle: false disables the wait entirely',
    settleOptionsOf({ settle: false }) === null, String(settleOptionsOf({ settle: false })))
  check('a number is the total budget with the other two values defaulted',
    JSON.stringify(settleOptionsOf({ settle: 1200 })) === JSON.stringify({ ...DEFAULTS, capMs: 1200 }),
    JSON.stringify(settleOptionsOf({ settle: 1200 })))
  check('an object overrides only the fields it names',
    JSON.stringify(settleOptionsOf({ settle: { graceMs: 0, capMs: 500 } })) ===
      JSON.stringify({ graceMs: 0, idleMs: 400, capMs: 500 }),
    JSON.stringify(settleOptionsOf({ settle: { graceMs: 0, capMs: 500 } })))

  const warnings = []
  const refused = ['yes', true, -1, null].map((value) => (
    settleOptionsOf({ settle: value }, { warn: (message) => warnings.push(message) })
  ))
  check('an unusable settle value is refused, logged, and replaced by the defaults',
    refused.every((budget) => JSON.stringify(budget) === JSON.stringify(DEFAULTS)) && warnings.length === 4,
    `warnings=${warnings.length}`)
}

try {
  // ---- References, from the controller, bypassing the tool entirely --------------------------
  await page.goto('about:blank')
  await browser.navigate(slowUrl)
  const navImmediate = await browser.screenshotToFile({ directory: artifactsDir, name: 'settle-ref-nav-immediate.png' })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const navSettled = await browser.screenshotToFile({ directory: artifactsDir, name: 'settle-ref-nav-settled.png' })

  check('the fixture really does react late (its immediate frame is not its settled frame)',
    !navImmediate.data.equals(navSettled.data),
    `immediate=${navImmediate.data.byteLength}B settled=${navSettled.data.byteLength}B`)

  // ---- navigate: the tool's frame must be the reaction ----------------------------------------
  auditSeen()
  const settleNav = await settleNavTool.execute(
    { url: slowUrl },
    { ...execBase, callId: brandString('call-cua-acceptance-settle-nav') },
  )
  auditSeen()
  const settleNavPng = await readFile(settleNav.screenshotPath)

  check('navigate waits for the page to react before capturing',
    settleNavPng.equals(navSettled.data), `${settleNavPng.byteLength}B vs settled ${navSettled.data.byteLength}B`)
  check('navigate no longer captures the pre-reaction state',
    !settleNavPng.equals(navImmediate.data),
    `${settleNavPng.byteLength}B vs immediate ${navImmediate.data.byteLength}B`)
  check('navigate reports the page as settled', settleNav.settled === true, `settled=${String(settleNav.settled)}`)
  check('navigate reports a wait inside the configured budget',
    typeof settleNav.settleMs === 'number' && settleNav.settleMs >= 1000 && settleNav.settleMs <= 3000,
    `settleMs=${String(settleNav.settleMs)}`)
  check('a settled frame adds no "may be mid-update" line',
    !settleNavTool.output.render({ url: slowUrl }, settleNav).find((b) => b.type === 'text').text
      .includes('settled: false'),
    'no note expected on a settled frame')

  // ---- click: the same property for the reaction that follows an ACTION -----------------------
  await page.goto('about:blank')
  await browser.navigate(slowUrl)
  await browser.click('#slow-go')
  const clickImmediate = await browser.screenshotToFile({ directory: artifactsDir, name: 'settle-ref-click-immediate.png' })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const clickSettled = await browser.screenshotToFile({ directory: artifactsDir, name: 'settle-ref-click-settled.png' })

  check('the click fixture reacts late too',
    !clickImmediate.data.equals(clickSettled.data),
    `immediate=${clickImmediate.data.byteLength}B settled=${clickSettled.data.byteLength}B`)

  await page.goto('about:blank')
  await browser.navigate(slowUrl)
  auditSeen()
  const settleClick = await tool.execute(
    { action: 'click', selector: '#slow-go' },
    { ...execBase, callId: brandString('call-cua-acceptance-settle-click') },
  )
  auditSeen()
  const settleClickPng = await readFile(settleClick.screenshotPath)

  check('a click waits for the page to react before capturing',
    settleClickPng.equals(clickSettled.data),
    `${settleClickPng.byteLength}B vs settled ${clickSettled.data.byteLength}B`)
  check('a click no longer captures the pre-reaction state',
    !settleClickPng.equals(clickImmediate.data),
    `${settleClickPng.byteLength}B vs immediate ${clickImmediate.data.byteLength}B`)
  check('a click reports the page as settled',
    settleClick.settled === true && settleClick.settleMs >= 1000,
    `settled=${String(settleClick.settled)} settleMs=${String(settleClick.settleMs)}`)

  // The shape a disabled wait produces: no settle fields at all. It has to satisfy the same declared
  // schema, or `settle: false` would turn every granted action into an output-validation failure.
  {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
    const withoutSettle = { ...settleClick }
    delete withoutSettle.settled
    delete withoutSettle.settleMs
    delete withoutSettle.networkBusy
    check('a granted result with the wait disabled (no settle fields) satisfies the schema',
      validateJsonSchemaValue(tool.output.schema, withoutSettle, 'value').length === 0,
      JSON.stringify(validateJsonSchemaValue(tool.output.schema, withoutSettle, 'value')))
  }


  // ---- A page that never goes quiet: bounded wait, and the result says so ---------------------
  //
  // `settled: false` is the honest half of the design. The wait is a heuristic with a budget, so it
  // cannot promise the frame is final; what it CAN promise is that it never claims more than it
  // verified, and that a page which never quiesces costs the budget once rather than stalling.
  await page.goto('about:blank')
  await browser.navigate(`${settleBase}/stream-page`)
  const streamStarted = Date.now()
  auditSeen()
  const settleStream = await tool.execute(
    { action: 'click', selector: '#go' },
    { ...execBase, callId: brandString('call-cua-acceptance-settle-stream') },
  )
  auditSeen()
  const streamElapsed = Date.now() - streamStarted

  check('a never-quiet page still performs the action',
    settleStream.granted === true, `granted=${String(settleStream.granted)}`)
  check('a never-quiet page is reported as NOT settled',
    settleStream.settled === false, `settled=${String(settleStream.settled)}`)
  check('the report names the network as the condition that never held',
    settleStream.networkBusy === true, `networkBusy=${String(settleStream.networkBusy)}`)
  check('the wait is bounded by the configured budget',
    streamElapsed >= 3000 && streamElapsed <= 4500, `elapsed=${streamElapsed}ms`)
  check('the unusable frame is still returned, with a path on disk',
    typeof settleStream.screenshotPath === 'string' && settleStream.screenshotPath.endsWith('.png'),
    settleStream.screenshotPath)
  {
    const text = tool.output.render({ action: 'click', selector: '#go' }, settleStream)
      .find((block) => block.type === 'text').text
    check('the model is told the frame may be mid-update',
      text.includes('settled: false') && text.includes('may be mid-update'), JSON.stringify(text))
    const images = tool.output.render({ action: 'click', selector: '#go' }, settleStream)
      .filter((block) => block.type === 'image')
    check('the frames are still handed to the model as images, the approved one first',
      images.length === 2 &&
        images[0].attachment.attachmentId === settleStream.approvalImage?.attachmentId &&
        images[1].attachment.attachmentId === settleStream.image?.attachmentId,
      `images=${images.length}`)
  }
} finally {
  // The unanswered `/never` request holds its socket open, so the server must be told to drop
  // connections before `close()` can call back.
  settleServer.closeAllConnections()
  await new Promise((done) => settleServer.close(done))
}

// ---------------------------------------------------------------------------------------------
// Fail-closed behaviour — the property both DSH and ZCode insist on.
// ---------------------------------------------------------------------------------------------

console.log('\n=== Fail-closed behaviour ===\n')

// Replace the answerer with a rejecting one and confirm no action reaches the page.
const rejectCtx = new Context()
const rejectHandle = await buildRejectingRuntime(rejectCtx, artifactsDir)

const before = await rejectHandle.browser.snapshot()
const refused = await rejectHandle.tool.execute(
  { action: 'submit', selector: '#f' },
  { agent: rejectHandle.agent, signal: new AbortController().signal },
)
const after = await rejectHandle.browser.snapshot()

check('a rejected approval is reported as not granted', refused.granted === false,
  `decision=${refused.decision}`)
check('a rejected approval performs no action',
  before.url === after.url && after.text === before.text,
  'page unchanged')

{
  const args = { action: 'submit', selector: '#f' }
  const refusedContent = rejectHandle.tool.output.render(args, refused)
  const refusedImages = refusedContent.filter((block) => block.type === 'image')
  const refusedMeta = rejectHandle.tool.output.presentationMeta(args, refused)

  check('a refusal reports granted:false in the card projection',
    refusedMeta?.granted === false, JSON.stringify(refusedMeta))
  check('a refusal names its single frame as the approval-time one',
    JSON.stringify(refusedMeta?.frames) === JSON.stringify(['before']),
    'the single frame already IS the approval-time state')
  check('a refusal still hands the model the approval-time frame',
    refusedImages.length === 1 &&
      refusedImages[0].attachment.attachmentId === refused.image?.attachmentId,
    `images=${refusedImages.length}`)
}

// ---------------------------------------------------------------------------------------------
// The refusal has to REACH the model, as a refusal.
// ---------------------------------------------------------------------------------------------
//
// The reported failure this section pins down: the user declined, and the model was handed
// `missing required property "value.approvalImage"` instead of the refusal. It read that as a
// transient output-validation fault and retried the very action the user had just rejected.
//
// Two independent guarantees are checked, because either one alone can regress:
//   1. the DECLARED output schema must accept a frame-less result, and
//   2. a real dispatch through the documented pipeline (`ctx.tools.execute`) must come back as a
//      SUCCESSFUL result whose content states that a human said no, and what to do next.

console.log('\n=== Fail-closed behaviour: the refusal reaches the model ===\n')

{
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const { refusalNotice } = await import('../src/action-text.js')

  // (1) The schema. `required: true` on a *property* node means "required in the parent object" in
  // this DSL (`dsh-tools`' compiler pushes it into the parent's `required` list), so a `required:
  // true` on the shared image node made `image` AND `approvalImage` mandatory for every result.
  const actSchema = tool.output.schema
  const navSchema = ctx.tools.get('browser_navigate').output.schema

  check('the act output schema does not require the optional image fields',
    !actSchema.required.includes('image') && !actSchema.required.includes('approvalImage'),
    `required=${JSON.stringify(actSchema.required)}`)
  check('the navigation output schema does not require the optional image fields',
    !navSchema.required.includes('image') && !navSchema.required.includes('approvalImage'),
    `required=${JSON.stringify(navSchema.required)}`)

  const frameLessAct = {
    action: 'click', selector: '#go', granted: false, decision: 'rejected',
    url: 'http://127.0.0.1:3097/', screenshotPath: '',
  }
  check('a frame-less act result satisfies its declared output schema',
    validateJsonSchemaValue(actSchema, frameLessAct, 'value').length === 0,
    JSON.stringify(validateJsonSchemaValue(actSchema, frameLessAct, 'value')))

  const frameLessNav = {
    url: 'http://127.0.0.1:3097/', title: 'Test', granted: true, decision: 'allowed-once',
    screenshotPath: '',
  }
  check('a frame-less (blank-screen) navigation result satisfies its declared output schema',
    validateJsonSchemaValue(navSchema, frameLessNav, 'value').length === 0,
    JSON.stringify(validateJsonSchemaValue(navSchema, frameLessNav, 'value')))

  // (2) The notice itself, for every non-granting outcome and both languages. The shipped gating
  // path's sentences are quoted verbatim (`the user rejected tool "X"`, `approval for tool "X" was
  // cancelled`, `tool "X" requires approval, ...`), so a check can assert exactly what the model
  // can rely on.
  const SHIPPED = {
    rejected: 'the user rejected tool "browser_act"',
    cancelled: 'approval for tool "browser_act" was cancelled',
    unavailable: 'tool "browser_act" requires approval, but no approval channel is available.',
  }
  const STOP = { en: ['Do not retry', 'ask'], zh: ['不要重试', '询问'] }

  for (const language of ['en', 'zh']) {
    const notices = Object.keys(SHIPPED).map((decision) => refusalNotice({
      toolName: 'browser_act',
      decision,
      language,
    }))

    check(`a ${language} refusal notice states the shipped sentence for each outcome`,
      notices.every((notice, index) => notice.includes(SHIPPED[Object.keys(SHIPPED)[index]])),
      JSON.stringify(notices))

    check(`a ${language} refusal notice tells the model to stop, not retry, and ask the user`,
      notices.every((notice) => STOP[language].every((phrase) => notice.includes(phrase))),
      JSON.stringify(notices))

    check(`a ${language} refusal notice names the tool and says the action did not happen`,
      notices.every((notice) => notice.includes('browser_act') &&
        notice.includes(language === 'zh' ? '未执行' : 'was NOT performed')),
      JSON.stringify(notices))

    check(`a ${language} refusal notice carries no file path`,
      notices.every((notice) => !/\/(?:tmp|home|var)\//u.test(notice)),
      JSON.stringify(notices))
  }

  check('the three non-granting outcomes are worded differently',
    new Set(Object.keys(SHIPPED).map((decision) => refusalNotice({
      toolName: 'browser_act', decision, language: 'en',
    }))).size === 3,
    'rejected / cancelled / unavailable must not read the same')

  // (3) End to end through the pipeline, with the real service: a rejection dispatched like the
  // agent loop dispatches it. `ctx.tools.execute` is the documented entry that runs the full
  // pipeline — `tools/pre-execute` → dispatch → `tools/post-execute` → the lossless materialization
  // and output-schema validation this bug lived in. Calling `tool.execute()` directly (as the
  // checks above do, to inspect the raw value) skips all of that, which is exactly why the leak
  // survived a green suite.
  check('the harness can dispatch through the documented pipeline entry',
    typeof ctx.tools.execute === 'function', typeof ctx.tools.execute)

  const refusalCallId = brandString('call-forced-refusal')
  const disposeForcedRejection = ctx.on('approval/request', async (req, next) => (
    req.callId === refusalCallId ? 'rejected' : await next()
  ), { prepend: true })

  const mainBefore = await browser.snapshot()
  const dispatched = await ctx.tools.execute({
    callId: refusalCallId,
    name: 'browser_act',
    arguments: { action: 'click', selector: '#click-target' },
    agent,
    signal: new AbortController().signal,
  })
  if (typeof disposeForcedRejection === 'function') disposeForcedRejection()
  const mainAfter = await browser.snapshot()

  const dispatchedText = dispatched.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

  check('a refused dispatch is not an error result',
    dispatched.isError === false, `isError=${dispatched.isError} content=${JSON.stringify(dispatchedText)}`)
  check('the dispatched refusal tells the model the user rejected the tool',
    dispatchedText.includes('the user rejected tool "browser_act"'), JSON.stringify(dispatchedText))
  check('the dispatched refusal tells the model not to retry and to ask the user',
    dispatchedText.includes('Do not retry') && dispatchedText.includes('ask the user'),
    JSON.stringify(dispatchedText))
  check('the dispatched refusal still carries the approval-time frame',
    dispatched.content.some((block) => block.type === 'image'),
    JSON.stringify(dispatched.content.map((block) => block.type)))
  check('a refused dispatch performs no action',
    mainBefore.url === mainAfter.url && mainBefore.text === mainAfter.text,
    'page unchanged')
}

// ---------------------------------------------------------------------------------------------
// The approval sentence: wording, element naming and language
// ---------------------------------------------------------------------------------------------
//
// `reason` is the whole consent text of the card whenever the asked tool has no `command` argument
// to preview: `dsh-client-ui-approval` renders `pending.reason` as the headline and the correlated
// call's `command` (absent for a browser tool) below it. Two rounds of operator feedback produced
// the current shape — the sentence used to be a DOM dump ("Type into #name-input — a
// <input type="text">"), and it was fixed to English while the panel chrome is localised. It is now
// written for a reader, names the target the way the page names it, quotes the text a `fill` will
// write, and follows the DSH user-settings locale (`locale.preference`) with English as the
// fallback. These checks drive the real tool against a real page; only the settings service is a
// facade, because this harness composes no `dsh-settings` provider.

console.log('\n--- approval sentence: wording and language ---\n')

{
  await page.setContent(`<!doctype html><html lang="zh"><body>
    <form id="zh-form" onsubmit="event.preventDefault()">
      <input id="zh-name" name="name" type="text" placeholder="在这里输入一个名字" />
      <input id="zh-bare" type="text" />
      <button id="zh-go" type="submit">提交表单</button>
    </form>
    <button id="zh-click" type="button">点我</button>
  </body></html>`)

  const named = await browser.describe('#zh-name')
  const bare = await browser.describe('#zh-bare')
  const labelled = await browser.describe('#zh-click')
  const form = await browser.describe('#zh-form')

  check('describe() names a field by its placeholder',
    named?.label === '在这里输入一个名字', JSON.stringify(named?.label))
  check('describe() names a button by its visible text',
    labelled?.label === '点我', JSON.stringify(labelled?.label))
  check('describe() reports a field\'s enclosing form',
    named?.form?.id === 'zh-form', JSON.stringify(named?.form))
  check('describe() reads a form element as its own enclosing form',
    form?.form?.id === 'zh-form', JSON.stringify(form?.form))
  check('describe() reports no label for an element that has none',
    bare?.label === '', JSON.stringify(bare?.label))

  // The Host reads the locale through the documented settings service (`ctx.settings.get(ns)`),
  // which the web profile mounts (`dsh-settings-file`) with the `locale` namespace registered by
  // `dsh-client-locale`'s Host half. This facade stands in for that provider.
  let localePreference
  const disposeSettings = ctx.provide('settings', {
    get: (ns) => (ns === 'locale' && localePreference !== undefined ? { preference: localePreference } : undefined),
  })

  const lastReason = () => eventsOfType(session, 'approval/asked').at(-1)?.data?.reason
  const runAction = async (args, tag) => {
    const result = await tool.execute(args, {
      agent,
      callId: brandString(`call-lang-${tag}`),
      signal: new AbortController().signal,
    })
    return { result, reason: lastReason() }
  }

  localePreference = 'zh'
  const zhClick = await runAction({ action: 'click', selector: '#zh-click' }, 'zh-click')
  check('a zh locale writes a Chinese sentence naming the button as the page does',
    zhClick.reason === '点击按钮「点我」（#zh-click）', JSON.stringify(zhClick.reason))

  const zhFill = await runAction({ action: 'fill', selector: '#zh-name', value: 'Alice' }, 'zh-fill')
  check('a zh fill sentence names the field and quotes the text it will write',
    zhFill.reason === '在输入框「在这里输入一个名字」（#zh-name）中输入 "Alice"',
    JSON.stringify(zhFill.reason))

  const zhSubmit = await runAction({ action: 'submit', selector: '#zh-name' }, 'zh-submit')
  check('a zh submit sentence names the enclosing form',
    zhSubmit.reason === '提交表单 #zh-form（其中包含 #zh-name）', JSON.stringify(zhSubmit.reason))

  // A refusal follows the same language rule as the sentence, and it is driven through the
  // documented pipeline entry (`ctx.tools.execute`) so it also exercises the output-schema
  // validation that used to turn a refusal into `missing required property "value.approvalImage"`.
  const zhRefusalCallId = brandString('call-lang-refusal')
  const disposeZhRejection = ctx.on('approval/request', async (req, next) => (
    req.callId === zhRefusalCallId ? 'rejected' : await next()
  ), { prepend: true })
  const zhRefused = await ctx.tools.execute({
    callId: zhRefusalCallId,
    name: 'browser_act',
    arguments: { action: 'click', selector: '#zh-click' },
    agent,
    signal: new AbortController().signal,
  })
  if (typeof disposeZhRejection === 'function') disposeZhRejection()
  const zhRefusedText = zhRefused.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

  check('a zh locale writes the refusal in Chinese and keeps the shipped sentence verbatim',
    zhRefused.isError === false &&
      zhRefusedText.includes('the user rejected tool "browser_act"') &&
      zhRefusedText.includes('未执行') &&
      zhRefusedText.includes('不要重试') &&
      zhRefusedText.includes('询问用户'),
    JSON.stringify(zhRefusedText))

  localePreference = 'zh-CN'
  const zhRegion = await runAction({ action: 'click', selector: '#zh-click' }, 'zh-region')
  check('a regional zh tag (zh-CN) is still Chinese',
    zhRegion.reason === '点击按钮「点我」（#zh-click）', JSON.stringify(zhRegion.reason))

  localePreference = 'ja'
  const jaClick = await runAction({ action: 'click', selector: '#zh-click' }, 'ja-click')
  check('a locale this plugin cannot write falls back to English',
    jaClick.reason === 'Click the button "点我" (#zh-click)', JSON.stringify(jaClick.reason))

  localePreference = undefined
  const fallbackClick = await runAction({ action: 'click', selector: '#zh-click' }, 'fallback-click')
  check('an unset preference falls back to English',
    fallbackClick.reason === 'Click the button "点我" (#zh-click)', JSON.stringify(fallbackClick.reason))

  const bareFill = await runAction({ action: 'fill', selector: '#zh-bare', value: 'Alice' }, 'bare-fill')
  check('an element with no name falls back to its DOM shape, never to a wrong label',
    bareFill.reason === 'Type "Alice" into #zh-bare (a <input type="text">)',
    JSON.stringify(bareFill.reason))

  const longFill = await runAction({ action: 'fill', selector: '#zh-bare', value: 'x'.repeat(45) }, 'long-fill')
  check('a long fill value is truncated to 40 characters with an ellipsis',
    typeof longFill.reason === 'string' &&
      longFill.reason.includes(`"${'x'.repeat(40)}…"`) && !longFill.reason.includes('x'.repeat(41)),
    JSON.stringify(longFill.reason))

  disposeSettings()
}

// ---- The frame box is reserved: measured in the real engine ----------------------------------
//
// The fix for "the `after the action` frame stayed below the fold after an approval" rests on one
// browser fact: an `<img>` with no source yet, carrying the reference's own aspect ratio, already
// occupies exactly the box the loaded image will occupy. That leaves the row ONE growth for the
// conversation's follow-the-tail logic to follow, instead of one per frame per load — and a row
// that grows twice is what made the shipped controller skip the second growth and then read the
// short landing as the reader having moved. Node cannot answer this question (the Client verifier
// has no layout); this browser can. The control below keeps the check from being vacuous: the OLD
// two-step paint really does move the row.

await page.setContent('<!doctype html><html><body style="margin:0;background:#123f8b">'
  + '<div id="host" style="width:1280px"></div></body></html>')
const framePng = await page.screenshot({ type: 'png' })
// `screenshot()` hands back a Uint8Array, not a Buffer: base64 has to go through Buffer explicitly.
const frameDataUrl = `data:image/png;base64,${Buffer.from(framePng).toString('base64')}`

// The frame's own paint, exactly as the Client declares it (width, cap, border, auto height).
const frameBoxCss = 'display:block;width:100%;max-width:640px;height:auto;border-radius:12px;'
  + 'border:0.5px solid rgba(0,0,0,.2)'

const frameLayout = await page.evaluate(async ({ dataUrl, box }) => {
  const host = document.getElementById('host')
  const height = () => host.firstElementChild.getBoundingClientRect().height
  // Learn the real pixel size first: this is what the Host measures and writes into the reference.
  host.innerHTML = `<img style="${box}">`
  const probe = host.firstElementChild
  probe.src = dataUrl
  await probe.decode()
  const natural = { width: probe.naturalWidth, height: probe.naturalHeight }
  // Reserved: the reference's dimensions are known, the bytes are not.
  host.innerHTML = `<img style="${box};aspect-ratio:${natural.width} / ${natural.height}">`
  const reserved = height()
  const image = host.firstElementChild
  image.src = dataUrl
  await image.decode()
  const loaded = height()
  // Control: the old paint — a short text placeholder, then an image with no reserved box.
  host.innerHTML = '<div style="font-size:13px;line-height:20px;border:0.5px dashed rgba(0,0,0,.3);'
    + 'border-radius:12px;padding:10px 12px">loading screenshot…</div>'
  const placeholder = height()
  host.innerHTML = `<img style="${box}">`
  const unsized = host.firstElementChild
  unsized.src = dataUrl
  await unsized.decode()
  const unsizedLoaded = height()
  // The box is capped at 640px wide, so the height its dimensions imply is 640 / (w/h).
  const implied = 640 * natural.height / natural.width
  return { natural, implied, reserved, loaded, placeholder, unsizedLoaded }
}, { dataUrl: frameDataUrl, box: frameBoxCss })

check('the reserved box is a real box before any bytes exist',
  frameLayout.reserved > 100, `reserved=${frameLayout.reserved}px`)
check('  ↳ it is the height the reference\'s own pixel dimensions imply',
  frameLayout.reserved >= frameLayout.implied && frameLayout.reserved - frameLayout.implied <= 2,
  `reserved=${frameLayout.reserved}px implied=${frameLayout.implied}px `
    + '(the difference is the box\'s own two 0.5px borders, which the rect includes)')
check('  ↳ decoding the bytes does not move it: one growth for the row, not two',
  frameLayout.loaded === frameLayout.reserved,
  `reserved=${frameLayout.reserved}px loaded=${frameLayout.loaded}px`)
check('  ↳ control: the old two-step paint DOES move the row, so the check above is not vacuous',
  frameLayout.unsizedLoaded !== frameLayout.placeholder,
  `placeholder=${frameLayout.placeholder}px image=${frameLayout.unsizedLoaded}px`)

// Teardown runs here, not before the section above: the sentence is produced by the real tool
// driving the real browser, so both have to still be alive while it is checked.
await ctx.loader.stop?.()
await browser.close()
await rejectHandle.dispose()

// ---------------------------------------------------------------------------------------------

const { writeFile } = await import('node:fs/promises')
const reportPath = join(artifactsDir, 'acceptance-report.json')
await writeFile(reportPath, JSON.stringify({ ...report, artifactsDir }, null, 2))

console.log(`\n=== ${report.failed === 0 ? 'ALL CHECKS PASSED' : `${report.failed} CHECK(S) FAILED`} ===`)
console.log(`artifacts: ${artifactsDir}`)
console.log(`report:    ${reportPath}`)

process.exit(report.failed === 0 ? 0 : 1)

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/**
 * Every event of one type in the Session log.
 *
 * @param session - the live Session.
 * @param type - the event type to collect.
 * @returns the matching events, in seq order.
 */
function eventsOfType(session, type) {
  const out = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event?.type === type) out.push(event)
  }
  return out
}

/**
 * Every event type in the Session log, in seq order.
 *
 * @param session - the live Session.
 * @returns the event types, one per committed event.
 */
function sessionEventTypes(session) {
  const out = []
  for (let seq = 0; seq < session.seq; seq += 1) out.push(session.eventAt(seq)?.type)
  return out
}

/**
 * Every event type in the log that this harness's own vocabulary does not contain.
 *
 * This is the check that makes the log-corruption defect unable to hide. A plugin-owned event type
 * is outside `KNOWN_SESSION_EVENT_TYPES`, and the persistence reader refuses to interpret a stored
 * log containing one unless the envelope carries `ignorable: true` — which a live
 * `Session.append()` cannot set. So a non-empty answer here is exactly the state that made a real
 * conversation unopenable, and it is detected here rather than after a restart.
 *
 * @param session - the live Session.
 * @returns the offending `type@seq` strings, or an empty array.
 */
function unknownEventTypes(session) {
  const out = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event !== undefined && !KNOWN_SET.has(event.type)) out.push(`${event.type}@${seq}`)
  }
  return out
}

/**
 * Replicate the Host's attachment-read authorization over a Session log.
 *
 * The Client's image loader reaches `dsh-api-session-controller`'s `attachment()`, which refuses
 * with `session/attachment-invalid` / `ATTACHMENT_NOT_REFERENCED` unless the Session log references
 * the attachment. This mirrors that predicate so the harness can prove a frame the card renders is
 * actually readable — the property whose absence produced "screenshot could not be loaded".
 *
 * It scans the positions a tool result and a plugin-owned event can occupy. It deliberately omits
 * the Host's assistant-stream arm, so this is a SUBSET of the Host's scan: passing here implies the
 * Host's fuller scan passes, never the other way round.
 *
 * @param session - the live Session.
 * @param attachmentId - the attachment to look for.
 * @returns whether the Host would authorize reading it.
 */
function sessionReferencesImage(session, attachmentId) {
  const blockMatches = (content) => {
    if (!Array.isArray(content)) return false
    for (const value of content) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      if (value.type === 'image' && value.attachment !== null && typeof value.attachment === 'object') {
        if (String(value.attachment.attachmentId) === attachmentId) return true
      }
      if (value.type === 'tool-result' && blockMatches(value.content)) return true
    }
    return false
  }
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const data = event.data
    if (blockMatches(data?.content)) return true
    if (blockMatches(data?.message?.content)) return true
    for (const inserted of data?.inserted ?? []) {
      if (blockMatches(inserted?.content)) return true
    }
  }
  return false
}

/**
 * Create a live agent whose session has an open turn, using the real session service.
 *
 * The approval seam requires turn enclosure, and a turn exists only under a real agent, so
 * this builds the smallest honest one rather than faking the check.
 */
async function makeAgentWithOpenTurn(context, sessionId) {
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const session = context.sessions.create(SessionId(sessionId))
  session.append('turn/start', { turn: 1 })
  const agent = { session, id: sessionId }
  // `ctx.approval.request` reads `req.agent.session`; the session must be committed by now.
  return agent
}

/** Build a second, independent runtime whose answerer rejects every request. */
async function buildRejectingRuntime(context, dir) {
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await import('@deepseek-ai/dsh-tools')
  const { default: Approval } = await import('@deepseek-ai/dsh-user-approval')
  const { default: AttachmentLocal } = await import('@deepseek-ai/dsh-attachment-local')
  const { default: SessionService } = await import('@deepseek-ai/dsh-session')

  await context.plugin(SystemPrompt)
  await context.plugin(SessionService)
  await context.plugin(Tools)
  await context.plugin(AttachmentLocal, { root: join(dir, 'attachments-2') })
  await context.plugin(Approval, { policy: 'ask' })
  await context.plugin({ name: 'reject-answerer', apply: (c) => { c.on('approval/request', async () => 'rejected') } })

  const { apply, name, inject } = await import('../src/index.js')
  // Keep this copy inside the run's own artifact directory rather than the operator's default one.
  await context.plugin({ name, apply, inject }, { artifactsDir: dir, headless: true })

  const { brandString } = await import('@deepseek-ai/dsh-brand')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const session = context.sessions.create(SessionId(brandString(`cua-reject-${Date.now()}`)))
  session.append('turn/start', { turn: 1 })
  const agent = { session, id: 'reject-agent' }

  // The MOST RECENT instance: this runtime mounts a second copy of the plugin, and its tools drive
  // its own browser. Selecting by artifacts directory would pick the first copy (both share this
  // run's directory) and the assertions would silently read a different browser than the tool used.
  const cuaPreview = cuaPreviewOf()
  const page = await cuaPreview.browser.page()
  await page.setContent(`<!doctype html><html><body><h1>Reject probe</h1>
    <form id="f" onsubmit="event.preventDefault();document.body.innerHTML='SUBMITTED'">
      <input id="q" type="text" /><button id="go" type="submit">Go</button></form></body></html>`)

  return {
    browser: cuaPreview.browser,
    tool: context.tools.get('browser_act'),
    agent,
    dispose: async () => { await context.stop?.() },
  }
}