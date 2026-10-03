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
 * no downward fiber walk. The probe therefore asserts the plugin-owned half — the event and its
 * position — rather than pretending to call the Host's method.
 *
 * Configure with:
 *   resultPath  - where to write the JSON verdict (required)
 *   exitAfter   - exit the process once the verdict is written (default true)
 */

import { writeFileSync } from 'node:fs'

export const name = 'cua-preview-load-probe'
// `sessions` is required to create the live Session the gated action is raised against — Cordis
// refuses a property access on a service the plugin did not declare.
export const inject = ['tools', 'approval', 'sessions']

const EXPECTED = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_act']

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
async function run(ctx, config, listed, resultPath) {
  const verdict = {
    probe: 'cua-preview-load-probe',
    toolsRegistered: listed,
    expected: EXPECTED,
    approvalServicePresent: ctx.get('approval') !== undefined,
    attachmentsServicePresent: ctx.get('attachments') !== undefined,
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

  verdict.ok = listed.length === EXPECTED.length &&
    verdict.actionGranted === true &&
    verdict.previewEventsInSessionLog === 1 &&
    verdict.referenceIsInScannedPosition === true &&
    verdict.previewEventIsLogOnly === true &&
    verdict.previewEventCallId === 'cua-preview-probe-call' &&
    verdict.blankNavigationOmittedFrame === true &&
    verdict.credentialReferenced === true &&
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

  const result = await ctx.tools.get('browser_act').execute(
    { action: 'click', selector: '#go' },
    { agent, callId: 'cua-preview-probe-call', signal: new AbortController().signal },
  )

  // Read the authorization input off the REAL Session log this product just wrote.
  //
  // The enforcing method itself is not reachable from here: the API gateway mounts
  // `sessionController` inside its own isolation scope, so neither `ctx.get('sessionController')`
  // nor the non-strict `ctx.get(..., false)` lookup finds it from a root-level patch row, and
  // Cordis exposes no downward fiber walk. What this probe can prove is the part the plugin owns —
  // that the real product commits an event carrying the reference in the exact position the
  // authorizer scans (`dsh-api-session-controller`: `referencedImage` → `imageInEvent` →
  // `data.content` / `data.message.content` / `data.inserted[].content`), and that nothing else in
  // this log references it, so the credential stands on the plugin's own event.
  const previewEvents = []
  const allEvents = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    allEvents.push(event)
    if (event.type === 'cua/preview') previewEvents.push(event)
  }

  const credential = result?.approvalImage?.attachmentId
  const modelFrame = result?.image?.attachmentId
  const blockMatches = (content, attachmentId) => {
    if (!Array.isArray(content)) return false
    for (const value of content) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      if (value.type === 'image' && value.attachment !== null && typeof value.attachment === 'object' &&
          String(value.attachment.attachmentId) === attachmentId) return true
      if (value.type === 'tool-result' && blockMatches(value.content, attachmentId)) return true
    }
    return false
  }
  const logReferences = (attachmentId) => allEvents.some((event) =>
    blockMatches(event.data?.content, attachmentId) ||
    blockMatches(event.data?.message?.content, attachmentId) ||
    (event.data?.inserted ?? []).some((inserted) => blockMatches(inserted?.content, attachmentId)))

  const previewEvent = previewEvents[0]
  const previewContent = previewEvent?.data?.content

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
    actionGranted: result?.granted === true,
    approvalDecision: result?.decision,
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
    credentialAttachmentId: credential,
    modelFrameAttachmentId: modelFrame,
    previewEventsInSessionLog: previewEvents.length,
    // The plugin's own event is the ONLY thing that can authorize the credential here, because this
    // probe calls `execute()` directly and so no `tool/result` event is ever appended.
    toolResultEventsInSessionLog: allEvents.filter((event) => event.type === 'tool/result').length,
    credentialReferenced: credential !== undefined && logReferences(credential),
    referenceIsInScannedPosition: previewContent?.[0]?.type === 'image' &&
      previewContent[0].attachment?.attachmentId === credential,
    previewEventIsLogOnly: previewEvent !== undefined && previewEvent.surfaceOp === undefined,
    // The join key the shipped approval panel's `conversation.approval.detail` region receives.
    previewEventCallId: previewEvent?.data?.callId,
    previewEventAction: previewEvent?.data?.action,
    blankNavigationOmittedFrame,
    unreferencedRefused: !logReferences(UNREFERENCED),
  }
}
