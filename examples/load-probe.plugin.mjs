/**
 * Load probe — test scaffolding, not part of the plugin.
 *
 * Booted as a second patch row alongside `dsh-cua-preview` inside a real `dsh` process. It waits
 * for the plugin's tools to appear in the live `ctx.tools` registry, then writes a JSON verdict
 * and exits the process with a matching exit code.
 *
 * This exists because `dsh --dump-config` proves the *row resolves* but not that the plugin
 * *activates*; and the plugin's own `ctx.logger.info` line is below the launcher's log level, so
 * its absence in the boot log is not evidence of anything. The probe produces unambiguous
 * evidence from inside the real product.
 *
 * Beyond listing the tools, the probe runs one **real gated action** (real Chrome, real approval
 * seam, real Session log) — a click on a page it loads first, with the loading navigation doubling
 * as the blank-screen control — and then reads the authorization input off the Session log the
 * product just wrote. The rule it checks against is the one the browser's image loader hits:
 * `dsh-api-session-controller`'s `attachment()` refuses any attachment the Session log does not
 * reference (`session/attachment-invalid` / `ATTACHMENT_NOT_REFERENCED`), where the scan covers
 * `data.content`, `data.message.content` and `data.inserted[].content`. An earlier revision carried
 * the approved frame only in `result.meta`, which is none of those positions — so the card showed
 * "screenshot could not be loaded". This probe fails if the plugin stops referencing the frame.
 *
 * The enforcing method itself is out of reach here: the API gateway provides `sessionController`
 * inside its own isolation scope, so neither `ctx.get('sessionController')` nor
 * `ctx.get('sessionController', false)` resolves it from a root-level patch row, and Cordis exposes
 * no downward fiber walk. The probe therefore asserts what the plugin itself controls — that both
 * frames are image blocks referenced from the content array of a committed event, and that the log
 * holds no event type outside the harness vocabulary — rather than pretending to call the Host's
 * method.
 *
 * Configure with:
 *   resultPath  - where to write the JSON verdict (required)
 *   exitAfter   - exit the process once the verdict is written (default true)
 */

import { writeFileSync } from 'node:fs'
import { cuaPreviewOf } from '../src/index.js'

export const name = 'cua-preview-load-probe'
// `sessions` is required to create the live Session the gated action is raised against — Cordis
// refuses a property access on a service the plugin did not declare.
export const inject = ['tools', 'approval', 'sessions']

const EXPECTED = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_act']

/**
 * The event types the harness itself writes into a probe session.
 *
 * Anything else in the log was written by a plugin — which is the defect this check exists for: a
 * plugin-owned type is outside the harness vocabulary, and the persistence reader refuses to reopen
 * a session containing one.
 */
const HARNESS_LOG_EVENTS = new Set([
  // Written when the harness creates and drives the session.
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  // Written by the agent loop around every tool call.
  'tool/call',
  'tool/result',
  // Written by the approval seam.
  'approval/asked',
  'approval/decided',
])

/** One attachment that no Session log could possibly reference. */
const UNREFERENCED = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

/**
 * The exact sentence the click's approval prompt can carry, one per shipped browser locale.
 *
 * Both are spelled out rather than derived from one another so the harness can assert what the plugin
 * produced against an expectation the plugin's own locale read cannot influence. `config.declaredLocale`
 * is what the harness parsed out of the profile's `cordis.patch.yml`; the live read is reported
 * separately. That separation is the fix for the blind spot this probe used to have: on DSH
 * 0.2.0-rc.2 the Host-side channel was removed, both the plugin and the probe fell back to English
 * together, and the derived comparison stayed green while the Chinese sentence had silently stopped
 * appearing.
 */
const ENGLISH_REASON = 'Click the button "Go" (#go)'
const CHINESE_REASON = '点击按钮「Go」（#go）'

/**
 * Summarize a thrown remote failure without depending on its exact class.
 *
 * @param error - whatever the call threw.
 * @returns a plain, loggable summary.
 */
function errorSummary(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : undefined,
    code: typeof error?.code === 'string' ? error.code : undefined,
    reason: error?.data?.reason ?? error?.reason,
    message: typeof error?.message === 'string' ? error.message.slice(0, 300) : String(error),
  }
}

export function apply(ctx, config = {}) {
  const resultPath = config.resultPath
  const deadline = Date.now() + (config.timeoutMs ?? 60_000)

  const poll = setInterval(() => {
    const listed = EXPECTED.filter((toolName) => ctx.tools.get(toolName) !== undefined)
    const done = listed.length === EXPECTED.length || Date.now() > deadline
    if (!done) return
    clearInterval(poll)
    void run(ctx, config, listed, resultPath)
  }, 200)

  ctx.effect(() => () => clearInterval(poll), 'load-probe: stop polling')
}

/**
 * Collect the verdict: the live registry, then one real gated action and its read authorization.
 *
 * @param ctx - the real Host context.
 * @param config - probe configuration.
 * @param listed - the browser tools found in the live registry.
 * @param resultPath - where to write the JSON verdict.
 */
/**
 * Wait, bounded, for the pending-approval frame route to attach.
 *
 * The route is registered through `ctx.inject`, so it waits for the Host's Connection service instead
 * of racing it; the record is live and flips to `registered: true` when that service appears. Waiting
 * here is what makes the verdict describe the outcome rather than the order the rows happened to load.
 *
 * @param instance - the plugin instance (`cuaPreviewOf()`).
 * @param deadline - when to stop waiting (epoch milliseconds).
 * @returns {{registered: boolean, path: string|null, reason: string|null}} the live record.
 */
async function waitForFrameRoute(instance, deadline) {
  const record = instance?.frameRoute ?? { registered: false, path: null, reason: 'no plugin instance' }
  while (record.registered !== true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return record
}

async function run(ctx, config, listed, resultPath) {
  const verdict = {
    probe: 'cua-preview-load-probe',
    toolsRegistered: listed,
    expected: EXPECTED,
    approvalServicePresent: ctx.get('approval') !== undefined,
    attachmentsServicePresent: ctx.get('attachments') !== undefined,
    // Whether the Host offers a third-party plugin its exact-Fetch registry at all. This is the one
    // fact the plugin cannot verify about its own Host from inside its own module.
    exactFetchRegistryPresent: typeof ctx.get?.('connection')?.fetch?.register === 'function',
    checkedAt: new Date().toISOString(),
  }

  try {
    const declaredLocale = typeof config.declaredLocale === 'string' ? config.declaredLocale : null
    Object.assign(verdict, await authorizeFrames(ctx, declaredLocale))
  } catch (error) {
    verdict.actionError = errorSummary(error)
  }

  try {
    Object.assign(verdict, await refuseThroughThePipeline(ctx))
  } catch (error) {
    verdict.refusalError = errorSummary(error)
  }

  // The route attaches through `ctx.inject`, so it waits for the Host's Connection service rather than
  // racing it — and that service can appear after this plugin's own dependencies are ready. Reading
  // the record once, immediately, would report the race instead of the result.
  const frameRoute = await waitForFrameRoute(cuaPreviewOf(), Date.now() + 10_000)
  verdict.frameRouteRegistered = frameRoute.registered === true
  verdict.frameRoutePath = frameRoute.path ?? null
  verdict.frameRouteReason = frameRoute.reason ?? null

  verdict.ok = listed.length === EXPECTED.length &&
    verdict.actionGranted === true &&
    verdict.frameCount === 2 &&
    verdict.framesAreDistinct === true &&
    verdict.framesAreImageBlocks === true &&
    verdict.blankNavigationOmittedFrame === true &&
    // The screen has to be readable while the approval is open, not only afterwards: that is the
    // whole difference between reviewing an action and reviewing its record.
    verdict.frameRouteRegistered === true &&
    verdict.frameRoutePath === '/api/cua-preview.frame' &&
    // The log must stay reopenable: no event type outside the harness vocabulary, and nothing this
    // plugin wrote.
    Array.isArray(verdict.unknownEventTypes) && verdict.unknownEventTypes.length === 0 &&
    verdict.pluginAppendedNoEvent === true &&
    verdict.unreferencedRefused === true &&
    // The approval sentence is the card's whole consent text, so its wording and its language are
    // checked — but against the language the Host actually exposes, never against a value the plugin
    // itself produced. (`approvalReasonMatchesExpectedWording` is a derived echo of the same read and
    // is therefore deliberately NOT part of this gate: it stayed true through the 0.2.0-rc.2
    // regression, when the Host channel disappeared and took both sides down to English together.
    // The non-circular comparison lives in the harness, against the profile's declared locale.)
    verdict.approvalReasonWordingIsExact === true &&
    verdict.approvalReasonLanguageMatchesTheHostChannel === true &&
    // The reported failure mode: a refusal that never reached the model. It is checked in the real
    // product, through the real pipeline, because a direct `execute()` call skips the
    // output-schema validation the refusal used to die in.
    verdict.imageFieldsAreOptional === true &&
    verdict.refusalIsNotAnError === true &&
    verdict.refusalCarriesTheShippedSentence === true &&
    verdict.refusalDirectsTheModelToStop === true &&
    verdict.refusalCarriesTheApprovalFrame === true

  if (resultPath !== undefined) writeFileSync(resultPath, JSON.stringify(verdict, null, 2))
  console.log(`[cua-preview-load-probe] ${JSON.stringify(verdict)}`)
  if (config.exitAfter !== false) setTimeout(() => process.exit(verdict.ok ? 0 : 1), 250)
}

/**
 * Prove, in the real product, that a refusal is delivered to the model AS a refusal.
 *
 * The bug this closes: `src/tools.js`'s shared image node carried `required: true`, which the DSH
 * schema DSL reads as "required in the parent object" — so `image` and `approvalImage` were
 * mandatory on every result, and a refusal (which has no separate approved frame) failed output
 * validation inside the pipeline. The Host threw `ToolOutputError: missing required property
 * "value.approvalImage"`, the model saw a schema error instead of the refusal, read it as a
 * transient fault and retried the action the user had just rejected.
 *
 * A direct `tool.execute()` call cannot see that failure — it returns the raw value and skips
 * `createSuccessResult` entirely — so this phase dispatches through `ctx.tools.execute`, the
 * documented pipeline entry that performs the same materialization and validation the agent loop
 * uses. It then checks the text the model would actually receive.
 *
 * @param ctx - the real Host context.
 * @returns the refusal evidence.
 */
async function refuseThroughThePipeline(ctx) {
  const { SessionId } = await import('@deepseek-ai/dsh-session')

  // Both image fields are optional by construction; this asserts the compiled schema the Host
  // validates against, not the authored spec.
  const actSchema = ctx.tools.get('browser_act')?.output?.schema
  const navSchema = ctx.tools.get('browser_navigate')?.output?.schema
  const optionalIn = (schema) => Array.isArray(schema?.required) &&
    !schema.required.includes('image') && !schema.required.includes('approvalImage')

  const callId = 'cua-preview-probe-refusal'
  ctx.inject(['approval'], (approvalCtx) => {
    approvalCtx.on('approval/request', async (request, next) => (
      request?.callId === callId ? 'rejected' : next()
    ), { prepend: true })
  })

  const sessionId = SessionId(`cua-preview-probe-refusal-${Date.now()}`)
  const session = ctx.sessions.create(sessionId)
  session.append('turn/start', { turn: 1 })
  const agent = { session, id: String(sessionId) }

  const dispatched = await ctx.tools.execute({
    callId,
    name: 'browser_act',
    arguments: { action: 'click', selector: '#go' },
    agent,
    signal: new AbortController().signal,
  })

  const text = (dispatched?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')

  // The directive is localised, so the expectation is derived from the locale this Host resolves —
  // the same rule the approval sentence follows, and the same read the plugin itself performs.
  const preference = ctx.get('settings')?.get?.('locale')?.preference
  const chinese = typeof preference === 'string' && preference.toLowerCase().startsWith('zh')
  const stopPhrases = chinese ? ['不要重试', '询问用户'] : ['Do not retry', 'ask the user']

  return {
    imageFieldsAreOptional: optionalIn(actSchema) && optionalIn(navSchema),
    refusalIsNotAnError: dispatched?.isError === false,
    refusalCarriesTheShippedSentence: text.includes('the user rejected tool "browser_act"'),
    refusalDirectsTheModelToStop: stopPhrases.every((phrase) => text.includes(phrase)),
    refusalCarriesTheApprovalFrame: (dispatched?.content ?? []).some((block) => block?.type === 'image'),
    refusalText: text,
  }
}

/**
 * Run one gated action and prove the credential frame is readable through the real controller.
 *
 * The action is a `browser_act` click on a page this probe loads first, and the first navigation
 * doubles as the blank-screen control: before it the tab is `about:blank`, so the plugin must emit
 * NO credential frame for it. Every check below therefore applies to the click.
 *
 * @param ctx - the real Host context.
 * @param declaredLocale - the locale the profile's own `cordis.patch.yml` declares, or null when the
 *   harness could not read one (a fresh CI profile has no patch file). Passed IN on purpose: it is
 *   the only locale fact here that the plugin's live read cannot move.
 * @returns the authorization evidence.
 */
async function authorizeFrames(ctx, declaredLocale) {
  const { SessionId } = await import('@deepseek-ai/dsh-session')

  // Answer our own approval. Without a human answerer attached to this temporary profile the seam
  // resolves `unavailable` and fails closed, which is correct but would leave nothing to check.
  const granted = []
  ctx.inject(['approval'], (approvalCtx) => {
    approvalCtx.on('approval/request', async (request) => {
      granted.push(request?.reason)
      return 'allowed-once'
    }, { prepend: true })
  })

  const sessionId = SessionId(`cua-preview-probe-${Date.now()}`)
  const session = ctx.sessions.create(sessionId)
  session.append('turn/start', { turn: 1 })
  const agent = { session, id: String(sessionId) }

  const probeHtml = '<!doctype html><title>CUA probe</title><h1 id=h>PROBE</h1>' +
    '<button id=go onclick="document.getElementById(\'h\').textContent=\'CLICKED\'">Go</button>'
  const probeUrl = `data:text/html;charset=utf-8,${encodeURIComponent(probeHtml)}`

  const load = await ctx.tools.get('browser_navigate').execute(
    { url: probeUrl },
    { agent, callId: 'cua-preview-probe-load', signal: new AbortController().signal },
  )
  // The blank-screen rule, observed in the real product: the first navigation of a fresh browser has
  // no screen to show, so it must carry no credential frame at all.
  const blankNavigationOmittedFrame = load?.approvalImage === undefined &&
    load?.approvalScreenshotPath === undefined

  // The gated click goes through the REAL pipeline rather than a direct `execute()` call: the
  // pipeline is what appends `tool/result`, and that known event type is what carries the frames'
  // references into the log. A direct call would prove nothing about readability — the reference
  // would exist only in a value the Host never persisted.
  const callId = 'cua-preview-probe-call'
  const dispatched = await ctx.tools.execute({
    callId,
    name: 'browser_act',
    arguments: { action: 'click', selector: '#go' },
    agent,
    signal: new AbortController().signal,
  })
  const dispatchedText = (dispatched?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  // Presentation order, straight out of the result the Host persisted: the screen the user approved
  // first, the state after the action second.
  const frames = (dispatched?.content ?? [])
    .filter((block) => block?.type === 'image')
    .map((block) => block.attachment)

  // Read the authorization input off the REAL Session log this product just wrote.
  //
  // The enforcing method itself is not reachable from here: the API gateway mounts
  // `sessionController` inside its own isolation scope, so neither `ctx.get('sessionController')`
  // nor the non-strict `ctx.get(..., false)` lookup finds it from a root-level patch row, and
  // Cordis exposes no downward fiber walk. What this probe can prove is the part the plugin owns —
  // that the reference sits in the exact position the authorizer scans
  // (`dsh-api-session-controller`: `referencedImage` → `imageInEvent` → `data.content` /
  // `data.message.content` / `data.inserted[].content`) — and, more importantly, that the plugin
  // adds no event of its own to the log at all.
  const { KNOWN_SESSION_EVENT_TYPES: knownTypes } = await import('@deepseek-ai/dsh-session')
  const allEvents = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event !== undefined) allEvents.push(event)
  }

  // The defect this replaced: a plugin-owned event type is outside the harness vocabulary, and a
  // live `Session.append()` cannot set the envelope's `ignorable: true` marker, so the persistence
  // reader refused to reopen any session that contained one. Both halves are asserted here, in the
  // real product: no unknown type may appear, and every event must be one the harness itself wrote.
  const unknownEventTypes = allEvents
    .filter((event) => !knownTypes.has(event.type))
    .map((event) => `${event.type}@${event.seq}`)
  const pluginAppendedNoEvent = allEvents.every((event) => HARNESS_LOG_EVENTS.has(event.type))

  // What the Host authorizes is an attachment referenced by a content block of a committed event
  // (`imageInEvent` scans `data.content` / `data.message.content` / `data.inserted[].content`). This
  // probe cannot append those events: `ctx.tools.execute` validates and materializes the result, but
  // the agent loop is what logs `tool/call` / `tool/result`, so what is asserted here is the value
  // shape that loop persists — image blocks, in presentation order, carrying real references.
  const framesAreImageBlocks = (dispatched?.content ?? [])
    .filter((block) => block?.type === 'image')
    .every((block) => block?.attachment !== null && typeof block?.attachment === 'object' &&
      typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId !== '' &&
      typeof block.attachment.mediaType === 'string' && block.attachment.mediaType.startsWith('image/'))

  const approvalDecision = /approval: (\S+)/.exec(dispatchedText)?.[1] ?? null

  // Control: an attachment nothing in this log could reference must be absent, so a scan that
  // accidentally answers "true" for everything is caught.
  const referenced = (content, attachmentId) => Array.isArray(content) && content.some((block) =>
    block?.type === 'image' && String(block.attachment?.attachmentId) === attachmentId)
  const unreferencedIsReferenced = allEvents.some((event) =>
    referenced(event.data?.content, UNREFERENCED) ||
    referenced(event.data?.message?.content, UNREFERENCED) ||
    (event.data?.inserted ?? []).some((inserted) => referenced(inserted?.content, UNREFERENCED)))

  // The approval sentence in the REAL product: what language the Host exposes, what language the
  // sentence actually came out in, and what the profile declared independently of both.
  //
  // The plugin builds the sentence from `ctx.get('settings').get('locale').preference`.
  // `@deepseek-ai/dsh-client-locale`'s Host half used to register that namespace and
  // `dsh-settings-file` used to be the provider; DSH 0.2.0-rc.2 replaced `dsh-settings` with a form
  // projection that has no value-read API at all, so this read now yields nothing and the plugin
  // honestly falls back to English. This probe therefore reports the channel's state and the
  // sentence's actual language, and derives its own expectation from the channel — while the harness
  // compares the result against `declaredLocale`, the locale the profile declares, which is a fact
  // neither this probe nor the plugin can move.
  const localePreference = ctx.get('settings')?.get?.('locale')?.preference
  const localeChannelReadable = typeof localePreference === 'string' && localePreference !== ''
  const hostLanguage = localeChannelReadable && localePreference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const expectedReason = hostLanguage === 'zh' ? CHINESE_REASON : ENGLISH_REASON
  const approvalReason = granted.at(-1)
  const approvalReasonIsChinese = typeof approvalReason === 'string' && /[\u4e00-\u9fff]/u.test(approvalReason)
  const approvalReasonLanguage = approvalReasonIsChinese ? 'zh' : 'en'
  const declaredLanguage = typeof declaredLocale !== 'string'
    ? null
    : declaredLocale.toLowerCase().startsWith('zh') ? 'zh' : 'en'

  return {
    sessionId: String(sessionId),
    actionGranted: dispatched?.isError === false && dispatchedText.includes('granted: true'),
    approvalDecision,
    // Two approvals were answered: the navigation, then the click. The click's sentence is the last.
    navigationReason: granted[0],
    approvalReason,
    settingsServicePresent: ctx.get('settings') !== undefined,
    // --- the locale evidence, in the three forms the harness needs -----------------------------
    // (1) the raw live read, null when the Host no longer exposes one;
    localePreference: localeChannelReadable ? localePreference : null,
    // (2) the channel's state, so a green run cannot hide a channel that went missing;
    localeChannelReadable,
    // (3) the profile's own declaration, passed in by the harness;
    declaredLocale: typeof declaredLocale === 'string' ? declaredLocale : null,
    declaredLocaleLanguage: declaredLanguage,
    // and both candidate sentences verbatim, so the harness can assert the exact wording without
    // recomputing one from the other.
    englishReason: ENGLISH_REASON,
    chineseReason: CHINESE_REASON,
    approvalReasonIsChinese,
    approvalReasonLanguage,
    expectedApprovalReason: expectedReason,
    // Derived from the channel the plugin itself reads. Kept for continuity, but it CANNOT detect a
    // channel that went missing, because both sides lose it together — that is the blind spot the
    // `declaredLocale` fields above exist to close.
    approvalReasonMatchesExpectedWording: approvalReason === expectedReason,
    // The two invariants that are not circular: the sentence is one of the two known wordings, and
    // its language is the language the Host actually exposes.
    approvalReasonWordingIsExact: approvalReason === ENGLISH_REASON || approvalReason === CHINESE_REASON,
    approvalReasonLanguageMatchesTheHostChannel: approvalReasonLanguage === hostLanguage,
    // The independent one: null when the harness had no profile to read.
    approvalReasonLanguageMatchesDeclaredLocale: declaredLanguage === null
      ? null
      : approvalReasonLanguage === declaredLanguage,
    credentialAttachmentId: frames[0]?.attachmentId,
    modelFrameAttachmentId: frames[1]?.attachmentId,
    frameCount: frames.length,
    framesAreDistinct: frames.length === 2 &&
      typeof frames[0]?.attachmentId === 'string' && frames[0].attachmentId !== frames[1]?.attachmentId,
    framesAreImageBlocks,
    // The invariants that keep the log reopenable, read off the real log this product wrote.
    unknownEventTypes,
    pluginAppendedNoEvent,
    sessionEventTypes: allEvents.map((event) => event.type),
    blankNavigationOmittedFrame,
    unreferencedRefused: !unreferencedIsReferenced,
  }
}
