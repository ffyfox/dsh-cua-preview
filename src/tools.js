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

/** Build the model-facing content for a result that carries an optional durable image. */
function imageContent(text, image) {
  const blocks = [{ type: 'text', text }]
  if (image !== null && image !== undefined) {
    blocks.push({ type: 'image', attachment: image })
  }
  return blocks
}

/**
 * Project the card facts for one approval-gated action.
 *
 * Two documented channels carry result-time facts, and they do different jobs here:
 *
 * - `output.presentationMeta` (this function) is persisted by the core on `tool/result` as
 *   `result.meta`, transported by the session log, and read back by a Client toolview from
 *   `ToolResultNode.meta` (`docs/cookbook/adding-a-tool.md`: "Project durable card data with
 *   `presentationMeta`"; "UI-only formatting stays out of the model result"). It tells the card
 *   *what* to render and how to caption it, and it survives replay.
 * - The approved frame's **readability** is a separate matter, and `meta` cannot grant it: the Host
 *   authorizes an attachment read by scanning the Session log for an event whose content carries
 *   that reference (`dsh-api-session-controller`'s `referencedImage`), and it scans only
 *   `data.content`, `data.message.content`, `data.inserted[].content` and assistant stream chunks.
 *   The broker therefore references the frame from a plugin-owned log-only event as well — see
 *   `approval-broker.js`. `meta` alone produced a card that said "could not be loaded".
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
    // The approved frame's durable reference, present only when (a) a distinct post-action frame is
    // the model-facing one — on a refusal the single frame already IS the approval-time state — and
    // (b) the Session log really references it, so the card never asks for bytes the Host refuses.
    ...(value.approvalImage === undefined ? {} : { approvedFrame: value.approvalImage }),
  }
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
      'The returned screenshot shows the page AFTER navigation, so it is the result. The screen ' +
      'seen at approval time is shown to the user in the conversation, not returned here (and a ' +
      'first navigation from a blank tab has no such screen).',
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
        value.image,
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
      if (!outcome.granted) return refusedNavigate(browser, outcome)
      const result = await browser.navigate(args.url, exec.signal)
      const after = await captureResult(ctx, browser, broker, logger, 'navigate')
      return {
        url: result.url,
        title: result.title,
        granted: true,
        decision: outcome.decision,
        screenshotPath: after.path,
        ...(outcome.screenshot?.path === undefined ? {} : { approvalScreenshotPath: outcome.screenshot.path }),
        ...(after.attachment === null ? {} : { image: after.attachment }),
        ...(outcome.frameAdmitted === true && outcome.attachmentRef !== null
          && outcome.attachmentRef !== undefined
          ? { approvalImage: outcome.attachmentRef }
          : {}),
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
      'The image in this result is the screen AFTER the action ran, so it shows the action\'s ' +
      'effect — no follow-up screenshot is needed to confirm it. The screen the user approved is ' +
      'shown to them in the conversation while they decide and is NOT part of this result; its ' +
      'file path, when there is one, is reported as `approvalScreenshotPath` for audit.',
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
        value.image,
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
      if (!outcome.granted) {
        const state = await browser.snapshot()
        return {
          action: args.action,
          selector: args.selector,
          granted: false,
          decision: outcome.decision,
          url: state.url,
          screenshotPath: outcome.screenshot?.path ?? '',
          ...(outcome.attachmentRef === null ? {} : { image: outcome.attachmentRef }),
        }
      }

      if (args.action === 'click') await browser.click(args.selector, exec.signal)
      else if (args.action === 'fill') await browser.fill(args.selector, args.value, exec.signal)
      else await browser.submit(args.selector, exec.signal)

      const state = await browser.snapshot()
      const after = await captureResult(ctx, browser, broker, logger, args.action)
      return {
        action: args.action,
        selector: args.selector,
        granted: true,
        decision: outcome.decision,
        url: state.url,
        screenshotPath: after.path,
        ...(outcome.screenshot?.path === undefined ? {} : { approvalScreenshotPath: outcome.screenshot.path }),
        ...(after.attachment === null ? {} : { image: after.attachment }),
        ...(outcome.frameAdmitted === true && outcome.attachmentRef !== null
          && outcome.attachmentRef !== undefined
          ? { approvalImage: outcome.attachmentRef }
          : {}),
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
 */
async function refusedNavigate(browser, outcome) {
  const state = await browser.snapshot()
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
    ...(outcome.attachmentRef === null || outcome.attachmentRef === undefined
      ? {}
      : { image: outcome.attachmentRef }),
  }
}