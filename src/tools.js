/**
 * Model-facing tools for dsh-cua-preview.
 *
 * Registration follows the documented tool-authoring contract
 * (`docs/cookbook/adding-a-tool.md`): a declared `parameters` spec, one canonical JSON value
 * from `execute` described by `output.schema`, and model-facing content produced by
 * `output.render`.
 *
 * The image is returned exactly the way the shipped `read_image` tool returns one
 * (`@deepseek-ai/dsh-tool-fs`, `lib/index.js`): `output.render` yields a text block plus an
 * `{ type: 'image', attachment: <ImageAttachmentRef> }` block. That is the documented image
 * return channel (`docs/subsystems/attachment.md`, `docs/subsystems/llm-streaming.md`), so no
 * private pathway is introduced.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { approvalLanguage, describeAction, refusalNotice } from './action-text.js'

/**
 * The durable image-reference value schema, mirroring `ImageAttachmentRef`.
 *
 * **No `required: true` on this node.** In the DSH schema DSL a property node carrying
 * `required: true` means "this key is required in the PARENT object", not "the fields inside this
 * object are required" — `dsh-tools`' compiler collects those annotations into the parent's
 * `required` list (`lib/types/schema.js`: `if (task.property.required === true) task.required.push(task.key)`).
 * A top-level `required: true` here therefore made BOTH `image` and `approvalImage` mandatory on
 * every result, and any frame-less result — a refusal (no approved frame), a first navigation from
 * a blank tab, a failed capture — failed output validation in the pipeline with
 * `missing required property "value.approvalImage"`.
 *
 * That is not a cosmetic error: `createSuccessResult` throws `ToolOutputError`, so the model
 * received a *schema* error instead of the result text, read it as a transient fault and retried
 * the very action the user had just rejected. The optionality of both fields is real (both are
 * genuinely absent sometimes), so it is expressed by leaving them out of the parent's required set.
 * The inner `required: true` annotations below are correct and stay: they belong to this object's
 * own property map, so they name attachmentId/mediaType/bytes/width/height as required *within*
 * this object.
 *
 * @see docs/subsystems/attachment.md — "Identity and verified metadata"
 * @see docs/subsystems/tools.md — `ValueSchemaSpec`, per-property `required: true`
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
}

/**
 * Build the model-facing content for a result that carries zero or more durable images.
 *
 * The reference must sit in `content` — the position the Host's attachment authorizer scans
 * (`imageInEvent`) — because a reference carried only by `result.meta` is persisted but not
 * readable, and a card built on it renders "screenshot could not be loaded".
 *
 * @param {string} text - the result text.
 * @param {object|object[]|null} [images] - one reference, a list of them, or nothing.
 * @returns {object[]} the content blocks.
 */
function imageContent(text, images) {
  const blocks = [{ type: 'text', text }]
  for (const entry of images === null || images === undefined
    ? []
    : Array.isArray(images) ? images : [images]) {
    if (entry === null || entry === undefined) continue
    // A frame record carries its role beside the reference (`gatedFrames`); a bare
    // `ImageAttachmentRef` — what `browser_screenshot` passes — is used as it stands.
    const attachment = entry.attachment ?? entry
    blocks.push({ type: 'image', attachment })
  }
  return blocks
}

/**
 * The images one gated result carries, in the order the card paints them.
 *
 * `approvalImage` is the screen captured BEFORE the ask and `image` is the state after the action,
 * so a grant shows a two-frame timeline ("before the action" above "after the action") inside the
 * call's own row. A refusal ran nothing: its single frame *is* the approval-time screen, so it is
 * reported once, as the before frame.
 *
 * @param {object} value - the canonical execution value.
 * @returns {object[]} frame records in presentation order.
 */
function gatedFrames(value) {
  const frames = []
  if (value.granted === false) {
    if (value.image !== undefined) frames.push({ role: 'before', attachment: value.image })
    return frames
  }
  if (value.approvalImage !== undefined) frames.push({ role: 'before', attachment: value.approvalImage })
  if (value.image !== undefined) frames.push({ role: 'after', attachment: value.image })
  return frames
}

/**
 * Project the card facts for one approval-gated action.
 *
 * `output.presentationMeta` is persisted by the core on `tool/result` as `result.meta`, transported
 * by the session log, and read back by a Client toolview from `ToolResultNode.meta`
 * (`docs/cookbook/adding-a-tool.md`: "Project durable card data with `presentationMeta`"; "UI-only
 * formatting stays out of the model result"). It tells the card *what* to render and how to caption
 * it, and it survives replay.
 *
 * `frames` names the role of every image the result carries, in order, so the card does not have to
 * guess a caption from `granted` alone: `['before', 'after']` for a granted action, `['before']` for
 * a refusal or for a grant whose post-action capture failed. The role — not the position — is what
 * the caption is built from, because a missing after-frame must not shift the before-frame's label.
 *
 * Readability is a separate matter, and `meta` cannot grant it: the Host authorizes an attachment
 * read by scanning the Session log for a known event whose content carries that reference
 * (`dsh-api-session-controller`'s `referencedImage`). That is why both frames are references inside
 * the `tool/result` content rather than metadata (see `approval-broker.js` for why no plugin-owned
 * event may be appended instead).
 *
 * @param {object} value - the canonical execution value.
 * @returns {object} plain, JSON-safe card facts.
 */
function gatedPresentationMeta(value) {
  return {
    decision: value.decision,
    ...(typeof value.granted === 'boolean' ? { granted: value.granted } : {}),
    screenshotPath: value.screenshotPath,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.approvalScreenshotPath === undefined
      ? {}
      : { approvedPath: value.approvalScreenshotPath }),
    frames: gatedFrames(value).map((frame) => frame.role),
  }
}

/**
 * Persist the approval-time frame so a gated result can carry it.
 *
 * The bytes are the broker's own capture; a frame-less ask (blank screen, capture failure) and a
 * failed save both yield null rather than an image the Host would refuse to serve.
 *
 * @param ctx - plugin context carrying the optional attachment store.
 * @param outcome - the broker result.
 * @param logger - optional logger.
 * @returns {Promise<object|null>} the serialized `ImageAttachmentRef`, or null.
 */
async function saveApprovalFrame(ctx, outcome, logger) {
  const shot = outcome?.screenshot
  if (shot === null || shot === undefined || shot.data === undefined) return null
  return saveScreenshotAttachment(ctx, shot, logger)
}

/**
 * Register the browser tools on a context.
 *
 * @param {object} ctx - plugin context carrying `ctx.tools`.
 * @param {object} deps
 * @param {import('./browser.js').BrowserController} deps.browser - browser control layer.
 * @param {import('./approval-broker.js').CuaApprovalBroker} deps.broker - approval broker.
 * @param {object} [deps.logger] - logger.
 */
export function registerBrowserTools(ctx, { browser, broker, logger }) {
  // ---- Read-only tools: no approval ------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description:
      'Open a URL in the plugin browser and return the resulting page title and URL. ' +
      'Navigation is an approval-gated action: the user is asked before the page is opened. ' +
      'If the result says the user rejected (or cancelled) the request, the navigation did not ' +
      'happen: that is a decision by the user, not a failure — do not retry the same navigation, ' +
      'stop and ask the user what to change or what to do next. ' +
      'The returned screenshot shows the page AFTER navigation, so it is the result. ' +
      'A granted navigation returns two images in order: first the screen the user was shown when ' +
      'they approved it (the card captions that one "before the action"), then the frame after ' +
      'navigation. A first navigation from a blank tab has no approval-time screen and returns one ' +
      'image; a refusal returns the approval-time screen alone.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          granted: { type: 'boolean', required: true },
          decision: { type: 'string', required: true },
          screenshotPath: { type: 'string', required: true },
          approvalScreenshotPath: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
          approvalImage: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageContent(
        value.granted
          ? [
              `navigate -> ${value.url}`,
              `title: ${value.title}`,
              `approval: ${value.decision}`,
              // A blank-screen approval carries no frame, so it names no path either.
              ...(value.approvalScreenshotPath === undefined
                ? []
                : [`screenshot (state at approval time): ${value.approvalScreenshotPath}`]),
              ...(value.screenshotPath === '' ? [] : [`screenshot (after navigation): ${value.screenshotPath}`]),
            ].join('\n')
          : [
              // The notice leads, so the first thing the model reads is that a human said no.
              refusalNotice({
                toolName: 'browser_navigate',
                decision: value.decision,
                language: approvalLanguageOf(ctx),
              }),
              '',
              `request: navigate -> ${value.url}`,
              `approval: ${value.decision} (granted: false)`,
              // On a refusal the frame is the screen the user was looking at, and it is the honest
              // current state: nothing changed it.
              ...(value.screenshotPath === ''
                ? []
                : [`screenshot (state at approval time; no navigation ran): ${value.screenshotPath}`]),
            ].join('\n'),
        gatedFrames(value),
      ),
      presentationMeta: (_args, value) => gatedPresentationMeta(value),
    },
    async execute(args, exec) {
      const outcome = await runGated(broker, browser, {
        toolName: 'browser_navigate',
        action: 'navigate',
        description: describeAction({
          action: 'navigate',
          url: args.url,
          language: approvalLanguageOf(ctx),
        }),
        agent: exec.agent,
        callId: exec.callId,
        signal: exec.signal,
      })
      // The held approval-time frame is dropped once this call's own result exists: from that moment
      // the result carries the same picture, and the live route should have nothing left to serve.
      try {
        if (!outcome.granted) return refusedNavigate(ctx, browser, outcome, logger)
        const result = await browser.navigate(args.url, exec.signal)
        const after = await captureResult(ctx, browser, broker, logger, 'navigate')
        const before = await saveApprovalFrame(ctx, outcome, logger)
        return {
          url: result.url,
          title: result.title,
          granted: true,
          decision: outcome.decision,
          screenshotPath: after.path,
          ...(outcome.screenshot?.path === undefined ? {} : { approvalScreenshotPath: outcome.screenshot.path }),
          ...(after.attachment === null ? {} : { image: after.attachment }),
          ...(before === null ? {} : { approvalImage: before }),
        }
      } finally {
        broker.forgetPendingFrame(exec.callId)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description:
      'Read the plugin browser\'s current URL, title, and visible text. Read-only: it never ' +
      'changes the page and therefore never raises an approval request.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.url}\n${value.title}\n\n${value.text}` }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      exec.signal?.throwIfAborted()
      return browser.snapshot()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description:
      'Render the plugin browser\'s current screen to a PNG and return the image. Read-only: ' +
      'it never changes the page and therefore never raises an approval request.',
    parameters: {
      name: { type: 'string', description: 'Optional file name for the PNG; defaults to a timestamped name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          byteLength: { type: 'integer', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageContent(
        `screenshot -> ${value.path} (${value.byteLength} bytes)`,
        value.image,
      ),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal?.throwIfAborted()
      const baseName = args.name ?? `screen-${Date.now()}`
      const shot = await browser.screenshotToFile({
        directory: broker.artifactsDir,
        name: baseName.endsWith('.png') ? baseName : `${baseName}.png`,
      })
      const attachment = await saveScreenshotAttachment(ctx, shot, logger)
      return {
        path: shot.path,
        byteLength: shot.byteLength,
        ...(attachment === null ? {} : { image: attachment }),
      }
    },
  }))

  // ---- Gated tool: click / fill / submit all raise an approval ---------------------------

  ctx.tools.register(defineTool({
    name: 'browser_act',
    description:
      'Perform a side-effecting action on the plugin browser page. The user is asked to approve ' +
      'the action first. Fails closed: anything other than an explicit one-shot approval performs ' +
      'no action. If the result says the user rejected (or cancelled) the request, nothing ran and ' +
      'that is a decision by the user, not a failure — do not retry the same action or an ' +
      'equivalent one, stop and ask the user what to change or what to do next. ' +
      'Actions: `click` (activate a control), `fill` (replace a field\'s contents; it ' +
      'clears the field first rather than appending), `submit` (submit a form). ' +
      'This result carries up to two images, in this order: the screen the user was shown when ' +
      'they approved the action (the card captions that one "before the action" — it is the frame ' +
      'they reviewed, and it is NOT the action\'s effect), then the screen AFTER the action ran. ' +
      'That second frame is normally the action\'s effect, so no follow-up screenshot is needed to ' +
      'confirm it. A refusal returns the approval-time frame alone. Each frame\'s file ' +
      'path is reported in the result text for audit.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'fill', 'submit'],
        description: 'The side-effecting action to perform',
      },
      selector: {
        type: 'string',
        required: true,
        description: 'CSS selector of the target control (or of a field inside the form for `submit`)',
      },
      value: {
        type: 'string',
        description: 'Text to enter; required for `fill` and rejected for the other actions',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          selector: { type: 'string', required: true },
          granted: { type: 'boolean', required: true },
          decision: { type: 'string', required: true },
          url: { type: 'string', required: true },
          screenshotPath: { type: 'string', required: true },
          approvalScreenshotPath: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
          approvalImage: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageContent(
        value.granted
          ? [
              `${value.action} ${value.selector}`,
              `approval: ${value.decision} (granted: true)`,
              `page: ${value.url}`,
              // A blank-screen approval carries no frame, so it names no path either.
              ...(value.approvalScreenshotPath === undefined
                ? []
                : [`screenshot (state at approval time): ${value.approvalScreenshotPath}`]),
              ...(value.screenshotPath === '' ? [] : [`screenshot (state AFTER the action): ${value.screenshotPath}`]),
            ].join('\n')
          : [
              // The notice leads, so the first thing the model reads is that a human said no.
              refusalNotice({
                toolName: 'browser_act',
                decision: value.decision,
                language: approvalLanguageOf(ctx),
              }),
              '',
              `request: ${value.action} ${value.selector}`,
              `approval: ${value.decision} (granted: false)`,
              `page: ${value.url}`,
              // The frame is the screen the user was looking at, and it is still the honest current
              // state: no action ran.
              ...(value.screenshotPath === ''
                ? []
                : [`screenshot (state at approval time; no action ran): ${value.screenshotPath}`]),
            ].join('\n'),
        gatedFrames(value),
      ),
      presentationMeta: (_args, value) => gatedPresentationMeta(value),
    },
    async execute(args, exec) {
      if (args.action === 'fill' && (args.value === undefined || args.value === '')) {
        throw new Error('`value` is required when action is "fill"')
      }
      if (args.action !== 'fill' && args.value !== undefined) {
        throw new Error(`\`value\` is only valid for action "fill", not "${args.action}"`)
      }

      const target = await browser.describe(args.selector)
      const description = describeAction({
        action: args.action,
        selector: args.selector,
        value: args.value,
        target,
        language: approvalLanguageOf(ctx),
      })

      const outcome = await runGated(broker, browser, {
        toolName: 'browser_act',
        action: args.action,
        description,
        agent: exec.agent,
        callId: exec.callId,
        signal: exec.signal,
      })

      // Fail closed: only an explicit one-shot grant reaches the page. A refusal has no
      // post-action state to show, so it reports the approval-time frame instead.
      //
      // The `finally` drops the held approval-time frame once this call's own result exists: from
      // that moment the result carries the same picture, so the live route should serve nothing.
      try {
        if (!outcome.granted) {
          const state = await browser.snapshot()
          const before = await saveApprovalFrame(ctx, outcome, logger)
          return {
            action: args.action,
            selector: args.selector,
            granted: false,
            decision: outcome.decision,
            url: state.url,
            screenshotPath: outcome.screenshot?.path ?? '',
            ...(before === null ? {} : { image: before }),
          }
        }

        if (args.action === 'click') await browser.click(args.selector, exec.signal)
        else if (args.action === 'fill') await browser.fill(args.selector, args.value, exec.signal)
        else await browser.submit(args.selector, exec.signal)

        const state = await browser.snapshot()
        const after = await captureResult(ctx, browser, broker, logger, args.action)
        const before = await saveApprovalFrame(ctx, outcome, logger)
        return {
          action: args.action,
          selector: args.selector,
          granted: true,
          decision: outcome.decision,
          url: state.url,
          screenshotPath: after.path,
          ...(outcome.screenshot?.path === undefined ? {} : { approvalScreenshotPath: outcome.screenshot.path }),
          ...(after.attachment === null ? {} : { image: after.attachment }),
          ...(before === null ? {} : { approvalImage: before }),
        }
      } finally {
        broker.forgetPendingFrame(exec.callId)
      }
    },
  }))
}

/**
 * Capture the screen AFTER an action and persist it.
 *
 * The image a model receives has to be the action's RESULT. An approval-time capture shows the
 * pre-action frame, which for a navigation is literally a blank tab — a real conversation showed a
 * model reading that as "the click failed" and re-verifying with an extra screenshot. The approval
 * frame is still taken (by the broker) and still written to disk for audit; it is simply not what
 * the tool returns as `image`.
 *
 * A capture failure is non-fatal: the action already happened, so the tool reports it without an
 * image rather than turning a successful action into an error.
 *
 * @param ctx - plugin context carrying the optional attachment store.
 * @param browser - the browser control layer.
 * @param broker - the approval broker (supplies the artifacts directory).
 * @param logger - optional logger.
 * @param label - action name used in the file name.
 * @returns {Promise<{path: string, attachment: object|null}>}
 */
async function captureResult(ctx, browser, broker, logger, label) {
  try {
    const shot = await browser.screenshotToFile({
      directory: broker.artifactsDir,
      name: `after-${label}-${Date.now()}.png`,
    })
    return { path: shot.path, attachment: await saveScreenshotAttachment(ctx, shot, logger) }
  } catch (error) {
    logger?.warn?.(
      `[dsh-cua-preview] post-action screenshot failed; the action itself succeeded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return { path: '', attachment: null }
  }
}

/**
 * Resolve the approval sentence's language for this call.
 *
 * Read from the documented user-settings service at call time rather than cached: the user may
 * switch the GUI language between two approvals, and the sentence is built per call anyway. An
 * absent or throwing service resolves to English (`action-text.js` owns that rule).
 *
 * @param ctx - plugin context.
 * @returns {'en'|'zh'} the language for the approval sentence.
 */
function approvalLanguageOf(ctx) {
  let settings
  try {
    settings = ctx.get('settings')
  } catch {
    settings = undefined
  }
  return approvalLanguage(settings)
}

/**
 * Run one gated action through the approval broker, capturing the screen for review.
 *
 * @returns {Promise<object>} the broker result.
 */
async function runGated(broker, browser, input) {
  return broker.requestActionApproval({
    ...input,
    // The probe runs first so a blank tab produces no frame at all, rather than a white one.
    probeScreen: () => browser.screenState(),
    capture: () => browser.screenshotToFile({
      directory: broker.artifactsDir,
      name: `approval-${input.action}-${Date.now()}.png`,
    }),
  })
}

/** Persist a screenshot through the attachment service when one is mounted. */
async function saveScreenshotAttachment(ctx, shot, logger) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return null
  try {
    const ref = await attachments.saveImage({
      data: shot.data,
      mediaType: 'image/png',
      name: 'cua-screenshot.png',
    })
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  } catch (error) {
    logger?.warn?.(
      `[dsh-cua-preview] could not persist screenshot as an attachment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

/**
 * Shape a refusal into the navigate tool's output.
 *
 * The page is untouched on a refusal, so the honest result is the *current* page state — not a
 * fabricated URL.
 *
 * @param ctx - plugin context carrying the optional attachment store.
 * @param browser - the browser control layer.
 * @param outcome - the broker result.
 * @param logger - optional logger.
 * @returns {Promise<object>} the tool result value.
 */
async function refusedNavigate(ctx, browser, outcome, logger) {
  const state = await browser.snapshot()
  const before = await saveApprovalFrame(ctx, outcome, logger)
  return {
    url: state.url,
    // The honest title of the page that is still open. It used to carry "navigate was not approved
    // (rejected)" — the refusal is now stated by the notice in `render`, so this field stays a fact
    // about the page rather than a second, partial copy of the outcome.
    title: state.title,
    granted: false,
    decision: outcome.decision,
    // No navigation happened, so there is no post-action frame; the approval-time frame is the
    // honest state to report. It may legitimately be absent (blank screen, capture failure),
    // which is why the schema declares both image fields optional.
    screenshotPath: outcome.screenshot?.path ?? '',
    ...(before === null ? {} : { image: before }),
  }
}