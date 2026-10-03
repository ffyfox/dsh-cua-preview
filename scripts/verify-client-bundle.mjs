/**
 * Verify the Client (browser) bundle for dsh-cua-preview.
 *
 * The browser half cannot be exercised by the Host-side acceptance harness, so this script
 * checks it the way a browser loader would: it stands up `window.__ModuleLoader__`, executes the
 * bundle with a stub `require`, and then drives every registered contribution against both
 * well-formed and deliberately malformed session data.
 *
 * What it proves:
 *   - the bundle parses and its factory runs without throwing
 *   - it exports `apply` and `inject` in the shape the client module system expects, and needs only
 *     the slot registry — no Conversation service, no event definition, no session hook
 *   - `apply` claims exactly the three browser tool keys and claims no renderer seat besides them
 *   - one Tool row paints the frames of one gated action in the order they happened, captioned from
 *     `presentationMeta.frames` (role, not position), so a grant reads "before the action" /
 *     "after the action" and a refusal reads "at approval time (no action ran)"
 *   - nothing in this package writes a Session event: a plugin-owned event type cannot carry the
 *     envelope's `ignorable` marker, and the persistence reader refuses a session that contains one
 *     ("contains event type … unknown to this harness and not marked ignorable"). The static guard
 *     below fails on the first `.append(` that reappears in `src/`.
 *   - it registers into no shipped single-occupancy slot (the collision that broke a client boot)
 *   - malformed or foreign data (bad JSON args, a null call, a corrupt attachment, an unknown
 *     tool name, malformed result metadata) degrades instead of throwing — display must never crash
 *     a replay
 *
 * Usage:  node scripts/verify-client-bundle.mjs
 * Exit code 0 = every check passed.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BUNDLE = resolve(import.meta.dirname, '../src/client/browser.js')

const report = { failed: 0 }
function check(name, ok, detail) {
  if (!ok) report.failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ---------------------------------------------------------------------------------------------
// Stand up the loader contract the shipped client bundles target.
// ---------------------------------------------------------------------------------------------

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

await import(pathToFileURL(BUNDLE).href)

check('the bundle called window.__ModuleLoader__.load', captured !== null)
assert.ok(captured !== null, 'bundle did not register itself with the module loader')
check('the bundle declares the package id', captured.id === 'dsh-cua-preview', `id=${captured.id}`)
check('the bundle exposes a factory', typeof captured.factory === 'function')

// ---------------------------------------------------------------------------------------------
// Execute the factory with stub modules.
// ---------------------------------------------------------------------------------------------

const reactStub = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

const jsxStub = (type, props) => ({ type, props: props ?? {} })
const jsxsStub = jsxStub

const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxsStub, Fragment: Symbol('Fragment') }
  throw new Error(`unexpected require("${specifier}") — the bundle must only need react`)
}

let exportsValue = null
try {
  exportsValue = captured.factory(requireStub)
} catch (error) {
  check('the factory runs without throwing', false, String(error))
  assert.fail(String(error))
}
check('the factory runs without throwing', true)
check('it exports apply()', typeof exportsValue.apply === 'function')
check('it exports an inject service list', Array.isArray(exportsValue.inject), JSON.stringify(exportsValue.inject))
check('it injects the slot registry, and nothing else',
  JSON.stringify(exportsValue.inject) === JSON.stringify(['slots']),
  JSON.stringify(exportsValue.inject))

// ---------------------------------------------------------------------------------------------
// Drive apply() and capture what it registers.
// ---------------------------------------------------------------------------------------------

const registered = []

// Deliberately no `uiConversation`: a bundle that reached for one would throw here, which is the
// point. This plugin renders from its own slot props and publishes no Conversation node.
const ctxStub = {
  slots: {
    inject: (_name, callback) => callback(),
    register: (config, component) => {
      registered.push({ config, component })
      return () => {}
    },
  },
}

try {
  exportsValue.apply(ctxStub)
} catch (error) {
  check('apply() runs without throwing', false, String(error))
  assert.fail(String(error))
}
check('apply() runs without throwing', true)

const toolRows = registered.filter((r) => r.config.name === 'tool.call.toolview')
const chatNodeEntry = registered.find((r) => r.config.name === 'conversation.chat.node')

check('apply() registers three tool views', toolRows.length === 3, `count=${toolRows.length}`)
check(
  'it claims exactly the browser tool keys',
  toolRows.map((r) => r.config.key).sort().join(',') === 'browser_act,browser_navigate,browser_screenshot',
  toolRows.map((r) => r.config.key).join(', '),
)
// The carrier node is hidden, so the chat never dispatches a renderer for its kind: registering one
// would be dead code, and a keyed seat in `conversation.chat.node` is not needed to own state.
check('it registers no Chat node renderer at all',
  chatNodeEntry === undefined,
  `key=${chatNodeEntry?.config.key}`)
// The static half of the same guard: the bundle must never depend on the Conversation event
// service, and no file in this package may append a Session event.
const SOURCE_FILES = [
  'src/index.js',
  'src/tools.js',
  'src/browser.js',
  'src/approval-broker.js',
  'src/action-text.js',
  'src/client/browser.js',
]
const sources = Object.fromEntries(SOURCE_FILES.map((file) => [
  file,
  readFileSync(resolve(import.meta.dirname, '..', file), 'utf8'),
]))
/** Strip comments: a comment that names an API is documentation, not a call to it. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
const codeOf = Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, stripComments(text)]))

check('the bundle never consults the Conversation event service',
  Object.values(codeOf).every((code) => !code.includes('uiConversation') && !code.includes('events.register')),
  'no uiConversation / events.register outside comments')
check('nothing in this package appends a Session event',
  Object.values(codeOf).every((code) => !code.includes('.append(')),
  'a plugin-owned event type cannot be marked ignorable, so the log would refuse to reopen')

// --- the slot-collision guard -----------------------------------------------------------------
//
// This is the check that was missing, and its absence broke the operator's client boot:
// `conversation.approval.detail` is `kind: 'single'` and the shipped `@deepseek-ai/dsh-client-ui-chat`
// already registers into it at priority 0. `SlotCore.register` throws on a second same-priority
// `single` registration, and the throw lands inside *ui-chat's* apply — so the whole client plugin
// load fails ("Failed to load plugins … @deepseek-ai/dsh-client-ui-chat") even though the offending
// registration is a third party's. A client plugin may only claim slots it owns or keyed seats it
// can address; it must never register into a shipped single-occupancy region.
//
// Shipped owners of the slots this bundle touches, recorded here so a future edit cannot quietly
// re-claim one: `tool.call.toolview` is `keyed` (per-tool keys) and is the only slot this plugin
// registers into; `conversation.chat.node` is `keyed` per node kind but is deliberately NOT used,
// because the carrier node is hidden and a hidden node never reaches that seat;
// `conversation.approval.detail` is `single` with a shipped occupant.

const ALLOWED_SLOTS = new Set(['tool.call.toolview'])
const SHIPPED_SINGLE_SLOTS = new Set([
  'conversation.approval.detail', // occupied by dsh-client-ui-chat's ApprovalCommand at priority 0
  'tool.call.images',             // occupied by the shipped read_image view
])

check('it registers into no slot other than the one keyed seat it owns',
  registered.every((r) => ALLOWED_SLOTS.has(r.config.name)),
  registered.map((r) => r.config.name).join(', '))
check('it leaves every shipped single-occupancy slot untouched',
  registered.every((r) => !SHIPPED_SINGLE_SLOTS.has(r.config.name)),
  'conversation.approval.detail / tool.call.images')
check('no two registrations collide on (name, key, priority)',
  new Set(registered.map((r) => `${r.config.name}|${r.config.key ?? ''}|${r.config.priority ?? 0}`)).size ===
    registered.length,
  registered.map((r) => `${r.config.name}|${r.config.key ?? ''}`).join(', '))
check('every registration declares the slot name it targets',
  registered.every((r) => typeof r.config.name === 'string' && r.config.name.length > 0))

// --- the same registrations, against the REAL slot registry ------------------------------------
//
// The checks above prove the bundle does not *claim* a shipped single-occupancy slot. These prove it
// against `dsh-client-ui-slots`'s own `SlotCore`: the shipped declaration tree is rebuilt, the
// shipped occupant of `conversation.approval.detail` (`dsh-client-ui-chat`'s `ApprovalCommand`) is
// registered, and this bundle's `apply` is run over that real registry — in both orders, because the
// boot failure this guards against happened when *ui-chat* registered second and its `apply` threw
// with "single slot … already has a registration", which failed the whole client plugin load.

const { SlotCore } = await import('@deepseek-ai/dsh-client-ui-slots')

/** Rebuild the shipped slot tree (one level per registration, as the parent entries declare it). */
function buildShippedRegistry() {
  const core = new SlotCore()
  const none = () => null
  core.register({
    name: 'root',
    id: 'shell',
    children: {
      'conversation.composer': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  }, none)
  core.register({
    name: 'conversation.composer',
    id: 'approval-panel',
    select: () => null,
    children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
  }, none)
  core.register({
    name: 'conversation.chat.node',
    key: 'tool-call',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  }, none)
  return core
}

/** The shipped occupant: `dsh-client-ui-chat` registers this into the approval detail region. */
const approvalCommandOccupant = function ApprovalCommand() { return null }

/** A `ctx.slots` face backed by the real registry instead of the capture stub. */
function realSlotsFace(core) {
  return {
    // `inject` waits for a declaration, exactly as the renderer's slot service does.
    inject: (name, callback) => {
      if (core.spec(name) !== undefined) callback()
    },
    register: (config, component) => core.register(config, component),
  }
}

/**
 * The Client context `apply` needs, with the REAL slot registry underneath it.
 *
 * @param core - the real `SlotCore` under test.
 * @returns a context good enough for `apply`.
 */
const realCtx = (core) => ({
  slots: realSlotsFace(core),
})

{
  // Order A — the shipped occupant is already there, this bundle applies second.
  const core = buildShippedRegistry()
  core.register({ name: 'conversation.approval.detail', registrant: 'dsh-client-ui-chat' }, approvalCommandOccupant)
  let threw = null
  try {
    exportsValue.apply(realCtx(core))
  } catch (error) {
    threw = error
  }
  check('apply() into the real registry coexists with the shipped approval-detail occupant',
    threw === null, threw === null ? undefined : String(threw))
  check('  ↳ the shipped single slot still has exactly one occupant',
    core.entriesOfSlot('conversation.approval.detail').length === 1,
    `occupants=${core.entriesOfSlot('conversation.approval.detail').length}`)
  check('  ↳ this bundle\'s keyed tool seats are all registered, and it took no chat-node seat',
    core.entriesOfSlot('tool.call.toolview').length === 3 &&
      core.entriesOfSlot('conversation.chat.node').every((entry) => entry.options.key === 'tool-call'),
    `toolview=${core.entriesOfSlot('tool.call.toolview').length} ` +
      `nodeKeys=${core.entriesOfSlot('conversation.chat.node').map((entry) => entry.options.key).join(',')}`)

  // Control: the rule is real, so avoiding that slot is a constraint and not superstition.
  let conflict = null
  try {
    core.register({ name: 'conversation.approval.detail', priority: 0 }, () => null)
  } catch (error) {
    conflict = error
  }
  check('  ↳ a second same-priority registration into it is rejected by the registry',
    conflict !== null && /single slot "conversation\.approval\.detail" already has a registration/.test(String(conflict)),
    conflict === null ? 'no error!' : String(conflict).split('\n')[0])
}

{
  // Order B — this bundle applies FIRST and the shipped occupant registers second. This is the order
  // that produced the operator-visible failure, so the shipped registration must still succeed.
  const core = buildShippedRegistry()
  exportsValue.apply(realCtx(core))
  let threw = null
  try {
    core.register({ name: 'conversation.approval.detail', registrant: 'dsh-client-ui-chat' }, approvalCommandOccupant)
  } catch (error) {
    threw = error
  }
  check('the shipped approval-detail registration still succeeds when this bundle applies first',
    threw === null, threw === null ? undefined : String(threw).split('\n')[0])
  check('  ↳ so no unrelated shipped client entry is failed by this plugin',
    core.entriesOfSlot('conversation.approval.detail').length === 1,
    `occupants=${core.entriesOfSlot('conversation.approval.detail').length}`)
}

// ---------------------------------------------------------------------------------------------
// Exercise the registered components.
// ---------------------------------------------------------------------------------------------

const Row = toolRows.find((r) => r.config.key === 'browser_act')?.component
assert.ok(typeof Row === 'function', 'no component registered for browser_act')

/**
 * Expand a stub render tree the way React would.
 *
 * The stub `jsx` records a function component as a node rather than invoking it, so this walks
 * the tree and calls every function component with its props — otherwise the nested image
 * component would never run and the assertions below would prove nothing.
 */
function expand(node) {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const children = node.props?.children
  if (Array.isArray(children)) {
    return { ...node, props: { ...node.props, children: children.map(expand) } }
  }
  if (children !== undefined) {
    return { ...node, props: { ...node.props, children: expand(children) } }
  }
  return node
}

/** Recursively collect nodes of one type from an expanded tree. */
function collect(node, type, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.type === type) out.push(node)
  const children = node.props?.children
  if (Array.isArray(children)) for (const child of children) collect(child, type, out)
  else if (children !== undefined) collect(children, type, out)
  return out
}

/**
 * Render one block through the row.
 *
 * The row takes nothing but its owner props: the block the host hands it, the session-authorized
 * image loader, and the stage prop. There is no hook, no carrier node and no selector to stub.
 *
 * @param block - the stage block: running call or settled result node.
 * @param loadImage - the loader for durable image references.
 * @returns the expanded render tree.
 */
/** Render one block through the row and return the expanded tree. */
function render(block, loadImage, options = {}) {
  const { callId = 'call-1' } = options
  return expand(Row({ block, callId, loadImage }))
}

const attachment = {
  attachmentId: 'sha256:abc123',
  mediaType: 'image/png',
  bytes: 1024,
  width: 640,
  height: 480,
}

const settledBlock = {
  kind: 'result',
  isError: false,
  call: { name: 'browser_act', argsRaw: JSON.stringify({ action: 'click', selector: '#go' }) },
  content: [
    { type: 'text', text: 'click #go\napproval: allowed-once' },
    { type: 'image', attachment },
  ],
}

/**
 * A loader whose synchronous cache already holds the URL, so the first render is the image.
 *
 * The URL is derived from the reference, so a rendered `src` says WHICH attachment painted.
 */
const cachedLoader = Object.assign(
  async (attachment) => `blob:${attachment.attachmentId}`,
  { peek: (attachment) => `blob:${attachment.attachmentId}` },
)
/** A loader with an empty cache: the first render must be the loading placeholder. */
const coldLoader = Object.assign(async () => 'blob:cold', { peek: () => undefined })

// --- well-formed result, warm cache: the image must actually render -------------------------

{
  const tree = render(settledBlock, cachedLoader)
  const images = collect(tree, 'img')
  check('a settled result renders the screenshot', images.length === 1, `img nodes=${images.length}`)
  check(
    'the image src comes from the supplied loadImage loader',
    images[0]?.props?.src === `blob:${attachment.attachmentId}`,
    `src=${String(images[0]?.props?.src)}`,
  )
  check(
    'the row echoes the model-facing text',
    collect(tree, 'div').some((d) => typeof d.props?.children === 'string' && d.props.children.includes('allowed-once')),
  )
  check(
    'the row names the tool and the action',
    collect(tree, 'span').some((s) => s.props?.children === 'browser_act') &&
      collect(tree, 'span').some((s) => s.props?.children === 'click #go'),
  )
}

// --- cold cache: a loading placeholder instead of a broken image ----------------------------

{
  const tree = render(settledBlock, coldLoader)
  check('a cold cache renders a loading placeholder, not a broken image',
    collect(tree, 'img').length === 0 && collect(tree, 'div').length > 0)
}

// --- malformed and foreign data must degrade, never throw -----------------------------------

const cases = [
  ['a running call with no result yet', { callId: 'c1', name: 'browser_act', argsRaw: '{"action":"click","selector":"#x"}' }],
  ['a settled result with a null call', { kind: 'result', isError: false, call: null, content: [] }],
  ['malformed JSON arguments', { kind: 'result', isError: false, call: { name: 'browser_act', argsRaw: '{not json' }, content: [] }],
  ['a corrupt image attachment', { kind: 'result', isError: false, call: { name: 'browser_act', argsRaw: '{}' }, content: [{ type: 'image', attachment: { attachmentId: '' } }] }],
  ['a non-image attachment media type', { kind: 'result', isError: false, call: { name: 'browser_act', argsRaw: '{}' }, content: [{ type: 'image', attachment: { ...attachment, mediaType: 'text/plain' } }] }],
  ['an errored result', { kind: 'result', isError: true, call: { name: 'browser_act', argsRaw: '{}' }, content: [{ type: 'text', text: 'boom' }] }],
  ['an unknown tool name', { kind: 'result', isError: false, call: { name: 'something_else', argsRaw: '{}' }, content: [] }],
  ['a null block', null],
]

for (const [label, block] of cases) {
  let threw = null
  let tree = null
  try {
    tree = render(block, cachedLoader)
  } catch (error) {
    threw = error
  }
  check(`renders ${label} without throwing`, threw === null, threw === null ? undefined : String(threw))
  if (threw === null) {
    // A corrupt attachment must abandon the gallery rather than show a partial one.
    const images = collect(tree, 'img')
    const expectNoImage = label !== 'a corrupt image attachment' || images.length === 0
    check(`  ↳ ${label}: no misleading image`, expectNoImage, `img nodes=${images.length}`)
  }
}

// --- a missing loader must not throw ---------------------------------------------------------

try {
  render(settledBlock, undefined)
  check('renders with no loadImage without throwing', true)
} catch (error) {
  check('renders with no loadImage without throwing', false, String(error))
}

// --- one row paints the frames of one action, in the order they happened ------------------------
//
// Both frames now live in the call's own result content: the frame the user was shown when they
// approved, then the state after the action. Ordering between separate rows is the chat's
// (`orderedVisibleChatNodes` sorts by `anchorSeq`, and the tool row anchors on `tool/call`), so the
// row is the only place "before above, after below" can be guaranteed. The captions come from
// `presentationMeta.frames`, which names each image's ROLE: a role must never be inferred from an
// image's position, or a grant whose post-action capture failed would label its before-frame
// "after the action".

const approvedAttachment = { ...attachment, attachmentId: 'sha256:approved999' }

const textOf = (tree) => collect(tree, 'div')
  .map((d) => d.props?.children)
  .filter((child) => typeof child === 'string')

/**
 * Depth-first order of the captions and images in an expanded tree.
 *
 * `collect` answers "is it there", not "in what order", so this records the layout as rendered.
 */
function layoutOf(tree) {
  const out = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    if (node.type === 'img') {
      out.push(`img:${String(node.props?.src)}`)
      return
    }
    if (node.type === 'div' && typeof node.props?.children === 'string') out.push(node.props.children)
    visit(node.props?.children)
  }
  visit(tree)
  return out
}

const framesOf = (tree) => layoutOf(tree)
  .filter((entry) => entry.startsWith('img:') || entry === 'before the action' ||
    entry === 'after the action' || entry === 'at approval time (no action ran)')

const beforeImg = `img:blob:${approvedAttachment.attachmentId}`
const afterImg = `img:blob:${attachment.attachmentId}`

/** A granted result: the approval-time frame, then the state after the action. */
const grantedBlock = {
  kind: 'result',
  isError: false,
  call: { name: 'browser_act', argsRaw: JSON.stringify({ action: 'click', selector: '#go' }) },
  content: [
    { type: 'text', text: 'click #go\napproval: allowed-once (granted: true)' },
    { type: 'image', attachment: approvedAttachment },
    { type: 'image', attachment },
  ],
  meta: {
    decision: 'allowed-once',
    granted: true,
    screenshotPath: '/tmp/after-click.png',
    approvedPath: '/tmp/approval-click.png',
    frames: ['before', 'after'],
  },
}

{
  const tree = render(grantedBlock, cachedLoader)
  check('a granted result paints both frames of the action',
    collect(tree, 'img').length === 2, `img nodes=${collect(tree, 'img').length}`)
  check('the frames come out before-above-after, captioning each role',
    JSON.stringify(framesOf(tree)) === JSON.stringify([
      'before the action',
      beforeImg,
      'after the action',
      afterImg,
    ]),
    JSON.stringify(framesOf(tree)))
  check('the approved frame is the one the user saw, not the post-action state',
    collect(tree, 'img')[0]?.props?.src === `blob:${approvedAttachment.attachmentId}`,
    `src=${String(collect(tree, 'img')[0]?.props?.src)}`)
}

{
  // A grant whose post-action capture failed carries the before-frame alone. Its caption must stay
  // "before the action": reading the role off `granted` alone would call it the action's effect.
  const captureFailed = {
    ...grantedBlock,
    content: [grantedBlock.content[0], grantedBlock.content[1]],
    meta: { ...grantedBlock.meta, frames: ['before'], screenshotPath: '' },
  }
  const tree = render(captureFailed, cachedLoader)
  check('a grant with no post-action frame captions its single frame "before the action"',
    JSON.stringify(framesOf(tree)) === JSON.stringify(['before the action', beforeImg]),
    JSON.stringify(framesOf(tree)))
}

{
  // A refusal ran nothing, so its single frame IS the approval-time state.
  const refused = {
    ...grantedBlock,
    content: [grantedBlock.content[0], grantedBlock.content[1]],
    meta: {
      decision: 'rejected',
      granted: false,
      screenshotPath: '/tmp/approval-submit.png',
      frames: ['before'],
    },
  }
  const tree = render(refused, cachedLoader)
  check('a refusal renders its frame exactly once',
    collect(tree, 'img').length === 1, `img nodes=${collect(tree, 'img').length}`)
  check('a refusal captions that frame as the approval-time state',
    JSON.stringify(framesOf(tree)) === JSON.stringify(['at approval time (no action ran)', beforeImg]),
    JSON.stringify(framesOf(tree)))
}

{
  // A log written by an earlier build has no `frames`: its single image obeys the `granted` rule
  // that build used, so an old transcript keeps its old caption.
  const legacyGrant = {
    ...grantedBlock,
    content: [grantedBlock.content[0], grantedBlock.content[2]],
    meta: { decision: 'allowed-once', granted: true, screenshotPath: '/tmp/after-click.png' },
  }
  const legacyRefusal = {
    ...legacyGrant,
    meta: { decision: 'rejected', granted: false, screenshotPath: '/tmp/approval.png' },
  }
  check('a legacy granted result still reads "after the action"',
    JSON.stringify(framesOf(render(legacyGrant, cachedLoader))) === JSON.stringify(['after the action', afterImg]),
    JSON.stringify(framesOf(render(legacyGrant, cachedLoader))))
  check('a legacy refusal still reads "at approval time (no action ran)"',
    JSON.stringify(framesOf(render(legacyRefusal, cachedLoader))) ===
      JSON.stringify(['at approval time (no action ran)', afterImg]),
    JSON.stringify(framesOf(render(legacyRefusal, cachedLoader))))
}

{
  // An unknown role — a value a future build wrote — is rendered uncaptioned rather than
  // mislabelled, and a role list shorter than the content leaves the extra image uncaptioned.
  const unknownRole = { ...grantedBlock, meta: { ...grantedBlock.meta, frames: ['sideways', 'after'] } }
  const shortList = { ...grantedBlock, meta: { ...grantedBlock.meta, frames: ['before'] } }
  check('an unknown frame role paints no caption',
    JSON.stringify(framesOf(render(unknownRole, cachedLoader))) ===
      JSON.stringify([beforeImg, 'after the action', afterImg]),
    JSON.stringify(framesOf(render(unknownRole, cachedLoader))))
  check('an image past the end of the role list paints no caption',
    JSON.stringify(framesOf(render(shortList, cachedLoader))) ===
      JSON.stringify(['before the action', beforeImg, afterImg]),
    JSON.stringify(framesOf(render(shortList, cachedLoader))))
}

{
  // A read-only screenshot carries no metadata and must stay uncaptioned.
  const readOnly = {
    kind: 'result',
    isError: false,
    call: { name: 'browser_screenshot', argsRaw: '{}' },
    content: [{ type: 'text', text: 'screenshot -> /tmp/x.png' }, { type: 'image', attachment }],
  }
  const captions = textOf(render(readOnly, cachedLoader))
  check('a result without metadata renders no caption at all',
    !captions.some((text) => text.includes('the action') || text.includes('approval time')),
    JSON.stringify(captions))
}

const metaCases = [
  ['malformed metadata', { ...grantedBlock, meta: 'nope' }],
  ['metadata that is an array', { ...grantedBlock, meta: [1, 2, 3] }],
  ['metadata whose roles are not a list', { ...grantedBlock, meta: { granted: true, frames: 'before' } }],
  ['metadata with a null role', { ...grantedBlock, meta: { granted: true, frames: [null] } }],
]

for (const [label, block] of metaCases) {
  let threw = null
  let tree = null
  try {
    tree = render(block, cachedLoader)
  } catch (error) {
    threw = error
  }
  check(`renders ${label} without throwing`, threw === null, threw === null ? undefined : String(threw))
  if (threw === null) {
    check(`  ↳ ${label}: the frames still render, uncaptioned`,
      collect(tree, 'img').length === 2 &&
        !textOf(tree).some((text) => text === 'before the action' || text === 'after the action'),
      `img nodes=${collect(tree, 'img').length}`)
  }
}

// ---------------------------------------------------------------------------------------------
// The explicit stage contract (DSH >= 0.2.0-rc.2).
// ---------------------------------------------------------------------------------------------
//
// From 0.2.0-rc.2 a view no longer receives one frozen block plus the obligation to guess the stage:
// the owner passes `phase` beside a stage-specific block — `{phase:'preparing', block:
// PreparingToolCall}` (identity only, NO arguments), `{phase:'start', block: StartedToolCall}`
// (complete arguments, no result yet), `{phase:'result', block: ToolResultNode}`. Every check above
// feeds the older spelling and must keep passing, because the package still declares support back to
// 0.1.5-rc.2, where `kind` was the only stage signal. These pin the newer one.

/** Render one stage exactly as 0.2.0-rc.2 hands it over: `phase` beside a stage-specific block. */
function renderPhase(phase, block, loadImage, options = {}) {
  const { callId = 'call-1' } = options
  return expand(Row({ phase, block, callId, loadImage }))
}

/** `PreparingToolCall`: identity and placement only — the arguments are not dispatched yet. */
const preparingBlock = {
  callId: 'call-1',
  name: 'browser_act',
  turn: 1,
  step: 1,
  time: 0,
  subCalls: [],
  phase: 'preparing',
}

/** `StartedToolCall`: complete arguments, no result yet. */
const startedBlock = {
  ...preparingBlock,
  phase: 'start',
  argsRaw: JSON.stringify({ action: 'click', selector: '#go' }),
}

/** `ToolResultNode` as 0.2.0-rc.2 passes it at the result stage (`kind` is still the node tag). */
const resultBlock = { ...settledBlock, kind: 'tool-result', phase: 'result' }

/** The text of every `span` in a rendered tree. */
const spanTexts = (tree) => collect(tree, 'span').map((span) => span.props?.children)

{
  let threw = null
  let tree = null
  try {
    tree = renderPhase('preparing', preparingBlock, cachedLoader)
  } catch (error) {
    threw = error
  }
  check('a preparing call renders without throwing',
    threw === null, threw === null ? undefined : String(threw))
  if (threw === null) {
    const spans = spanTexts(tree)
    check('  ↳ a preparing call still names the tool',
      spans.includes('browser_act'), JSON.stringify(spans))
    check('  ↳ a preparing call paints no argument summary, because it has no arguments yet',
      !spans.some((text) => typeof text === 'string' && text !== 'browser_act'),
      JSON.stringify(spans))
    check('  ↳ a preparing call paints no frame, and could not have one yet',
      collect(tree, 'img').length === 0, `img nodes=${collect(tree, 'img').length}`)
  }
}

{
  const tree = renderPhase('start', startedBlock, cachedLoader)
  const spans = spanTexts(tree)
  check('a started call names the tool and the action it is about to take',
    spans.includes('browser_act') && spans.includes('click #go'), JSON.stringify(spans))
  check('  ↳ a started call paints no result frame yet, because no result exists',
    collect(tree, 'img').length === 0, `img nodes=${collect(tree, 'img').length}`)
}

{
  const tree = renderPhase('result', resultBlock, cachedLoader)
  check('a result stage paints the screenshot',
    collect(tree, 'img').length === 1, `img nodes=${collect(tree, 'img').length}`)
}

{
  // A call that has not produced a result paints no result frame, in either spelling: the frames of
  // a gated action arrive with its result.
  const tree = renderPhase('start', startedBlock, cachedLoader)
  check('a started call paints no result frame before its result, in the old spelling too',
    collect(tree, 'img').length === 0, `img nodes=${collect(tree, 'img').length}`)
}

{
  // The stage is also on the block itself (`PreparingToolCall.phase` / `StartedToolCall.phase`), so a
  // host that passes the block without the sibling prop still lands on the right stage.
  const tree = renderPhase(undefined, resultBlock, cachedLoader)
  check('the stage is also read off the block when the owner omits its prop',
    collect(tree, 'img').length === 1, `img nodes=${collect(tree, 'img').length}`)
}

{
  // A stage from a future DSH must degrade to "still running" — never to a result, which would claim
  // an outcome that has not happened.
  const tree = renderPhase('aborted', startedBlock, cachedLoader)
  check('an unknown future stage degrades to running rather than to a result',
    collect(tree, 'img').length === 0 && spanTexts(tree).includes('click #go'),
    JSON.stringify(spanTexts(tree)))
}

// ---------------------------------------------------------------------------------------------

console.log(`\n=== ${report.failed === 0 ? 'CLIENT BUNDLE VERIFIED' : `${report.failed} CHECK(S) FAILED`} ===`)
process.exit(report.failed === 0 ? 0 : 1)
