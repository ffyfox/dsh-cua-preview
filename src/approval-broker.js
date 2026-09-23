/**
 * Approval broker for dsh-cua-preview.
 *
 * Borrowed from ZCode's `cua-permission-broker`. The parts that are genuinely borrowed are the
 * *shapes*, and they are named here so the borrowing is checkable:
 *
 * 1. **Gate, then ask, then act.** ZCode's `permission-flow.ts` computes a permission decision,
 *    and only a decision of exactly `allow` proceeds; `ask` raises a request through
 *    `permissionBroker.requestPermission(...)` and everything else is denied. The browser action
 *    is only executed after the broker returns a grant for *that* action.
 *
 * 2. **Fail closed, always.** ZCode's broker returns typed errors
 *    (`notAuthorized`, `unavailable`, `actionUnavailable`) and never treats a missing responder
 *    as permission. DSH's approval seam is explicit about the same rule: only `allowed-once` is a
 *    grant, and a missing/throwing/non-conforming answerer becomes `unavailable`
 *    (`docs/subsystems/approval.md`, "Identity and outcome"). This module grants on
 *    `allowed-once` and on nothing else.
 *
 * 3. **A preview failure must never decide whether the user is asked.** ZCode's approval-gate.ts
 *    logs a preview failure and *still asks*, because failing open would silently run an
 *    unapproved action. Reproduced verbatim in spirit below: if the screenshot cannot be taken,
 *    the ask still happens, without an image.
 *
 * 4. **The request carries a requestId and correlates to a tool call.** ZCode's
 *    `PermissionBrokerRequest` carries `requestId` + `toolCallId`; DSH's `ApprovalRequest` carries
 *    `callId` for exactly this correlation. Both are populated.
 *
 * The approval prompt itself is the **official** one (`@deepseek-ai/dsh-client-ui-approval`, mounted
 * by the shipped web profile), reached through the documented `approval/request` waterfall.
 * Nothing here bypasses or re-implements that path, and nothing here styles it: the only fields
 * this module controls are `toolName`, `callId` and a one-line `reason`.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The only outcome DSH defines as a grant (`docs/subsystems/approval.md`). */
export const GRANTING_OUTCOME = 'allowed-once'

/** Every outcome the DSH approval seam can return. */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

export class ApprovalUnavailableError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ApprovalUnavailableError'
  }
}

/**
 * Broker that turns one proposed browser action into an approved-and-reviewed action.
 *
 * The screenshot is persisted through `ctx.attachments.saveImage()` — the documented durable
 * image channel (`docs/subsystems/attachment.md`) — additionally written to disk so the evidence is
 * a real, parseable file, and **referenced from the Session log** so the Host will authorize a
 * Client read of it (see the frame-admission step below).
 */
export class CuaApprovalBroker {
  /** Every decision taken, in order. The acceptance test reads this as machine-checkable evidence. */
  decisions = []
  #ctx
  #artifactsDir
  #logger

  /**
   * @param {object} options
   * @param {object} options.ctx - Cordis context carrying `approval`, `attachments`, `logger`.
   * @param {string} options.artifactsDir - directory for screenshot evidence files.
   * @param {object} [options.logger] - optional logger; defaults to `ctx.logger`.
   */
  constructor({ ctx, artifactsDir, logger }) {
    this.#ctx = ctx
    this.#artifactsDir = artifactsDir
    this.#logger = logger ?? ctx.logger
  }

  /** @returns {string} the directory holding screenshot evidence. */
  get artifactsDir() {
    return this.#artifactsDir
  }

  /**
   * Ask the user to approve one browser action, attaching a rendered screenshot of the current
   * screen to the review material.
   *
   * @param {object} input
   * @param {object} input.agent - the asking agent (from `exec.agent`).
   * @param {import('@deepseek-ai/dsh-llm').ToolCallId} [input.callId] - the correlated tool call.
   * @param {string} input.toolName - the tool raising the request, recorded in the audit event.
   * @param {string} input.action - one of `click` | `fill` | `submit` | `navigate`.
   * @param {string} input.description - human-readable description of the action.
   * @param {AbortSignal} [input.signal] - the tool execution signal.
   * @param {() => Promise<object>} input.capture - captures the current screen; may throw.
   * @param {() => Promise<{blank: boolean}>} [input.probeScreen] - reports whether the current
   *   screen is an unloaded empty document; a blank screen yields no credential frame at all.
   * @returns {Promise<object>} the broker's closed result.
   */
  async requestActionApproval({ agent, callId, toolName, action, description, signal, capture, probeScreen }) {
    const requestId = `cua_${randomUUID()}`
    const approval = this.#ctx.get('approval')

    if (approval === undefined) {
      // Fail closed: no approval seam means no grant.
      const failure = {
        requestId,
        action,
        decision: 'unavailable',
        granted: false,
        reason: 'no approval service is mounted; failing closed',
      }
      this.decisions.push(failure)
      return failure
    }

    // ---- Is there a screen worth showing? --------------------------------------------------
    // The credential frame answers "what does the screen look like right now". Before the first
    // navigation there is no screen: the tab is `about:blank` and every capture of it is the same
    // pure-white PNG. The user's decision was to emit no frame at all in that case rather than a
    // white rectangle (and, on their instruction, with no explanatory text either) — so the probe
    // gates the capture instead of the capture gating itself.
    let blankScreen = false
    if (probeScreen !== undefined) {
      try {
        blankScreen = (await probeScreen())?.blank === true
      } catch (error) {
        // A failed probe must not suppress a real frame: fall through and capture.
        this.#logger?.warn?.(
          `[dsh-cua-preview] could not read the screen state; capturing anyway: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    // ---- Capture before asking ------------------------------------------------------------
    // Borrowed rule (ZCode approval-gate.ts): the preview must never decide whether the user is
    // asked. A capture failure is logged and the ask proceeds without an image.
    let screenshot = null
    let captureError = null
    if (!blankScreen) {
      try {
        screenshot = await capture()
      } catch (error) {
        captureError = error
        this.#logger?.warn?.(
          `[dsh-cua-preview] screenshot capture failed; requesting approval without an image: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    // ---- Persist the screenshot through the documented attachment channel ------------------
    let attachmentRef = null
    if (screenshot !== null) {
      try {
        attachmentRef = await this.#persistImage(screenshot)
      } catch (error) {
        this.#logger?.warn?.(
          `[dsh-cua-preview] attachment persistence failed; the PNG file is still on disk: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    // ---- Reference the frame from the Session log so a Client may read it back -------------
    // `callId` rides in the event so the Client can correlate this screen with the tool call the
    // approval names: the shipped approval panel's `conversation.approval.detail` receives the
    // callId and nothing else, and that is the join key.
    const facts = {
      ...(callId === undefined ? {} : { callId }),
      action,
      toolName,
    }
    const frameAdmitted = attachmentRef === null ? false : this.#admitFrame(agent, attachmentRef, facts)

    // ---- Raise the official DSH approval request ------------------------------------------
    // The reason states WHAT is about to happen and stays on one line. `reason` is the seam's
    // free-text field for *why the asker is asking* (`docs/subsystems/approval.md`), not a place
    // for evidence metadata: an earlier revision folded the screenshot path and byte size into it
    // and every renderer mishandled it — the shipped panel grew a three-line headline carrying a
    // path the user cannot open (measured: a 129 px card becomes 177 px), and the third-party
    // desktop bubble on the operator's machine truncates it to three CSS-clamped lines. The
    // screenshot facts remain in the tool result text and on disk.
    const reason = description

    const request = {
      agent,
      toolName,
      reason,
      ...(callId === undefined ? {} : { callId }),
      ...(signal === undefined ? {} : { signal }),
    }

    let outcome
    try {
      outcome = await approval.request(request)
    } catch (error) {
      const failure = {
        requestId,
        action,
        decision: 'unavailable',
        granted: false,
        reason: `approval.request threw: ${error instanceof Error ? error.message : String(error)}`,
        screenshot,
        attachmentRef,
        frameAdmitted,
        frameOmitted: blankScreen ? 'blank-screen' : null,
      }
      this.decisions.push(failure)
      return failure
    }

    // A rogue/non-vocabulary return is normalized to unavailable, matching the seam's own rule.
    const decision = APPROVAL_OUTCOMES.includes(outcome) ? outcome : 'unavailable'
    const result = {
      requestId,
      action,
      decision,
      granted: decision === GRANTING_OUTCOME,
      reason,
      screenshot,
      attachmentRef,
      frameAdmitted,
      captureError: captureError === null ? null : String(captureError),
      // Why no credential frame exists, when none does: the current screen was an unloaded empty
      // document. Distinct from a capture failure, which is reported as `captureError`.
      frameOmitted: blankScreen ? 'blank-screen' : null,
    }
    this.decisions.push(result)
    return result
  }

  /**
   * Reference one persisted frame from the Session log, so the Host will serve it to a Client.
   *
   * This is not optional bookkeeping — it is the read authorization. `dsh-api-session-controller`'s
   * `attachment()` proves reachability before returning any bytes:
   *
   * ```js
   * const ref = referencedImage(source.events, String(request.attachmentId))
   * if (ref === void 0) throw new RemoteError('session/attachment-invalid',
   *   'Image is not referenced by this session.', { reason: 'ATTACHMENT_NOT_REFERENCED' })
   * ```
   *
   * and `imageInEvent` scans only `data.content`, `data.message.content`, `data.inserted[].content`
   * and assistant stream chunks. A reference carried solely by `result.meta` is persisted and
   * replayable but **not readable** — which is exactly how the approved frame reached the card as
   * "screenshot could not be loaded" while the model-facing frame rendered fine.
   *
   * So the reference is also recorded on a plugin-owned **log-only** event.
   * `docs/subsystems/session.md` states that a plugin may merge extra `SessionEventMap` types and
   * that these are log-only — not `SurfaceEventType`s, contributing nothing to derived history — so
   * the model never sees this frame while the authorizer does.
   *
   * The same event is the Client's source for the two places the frame is shown *while the user is
   * deciding*: `docs/subsystems/conversation.md` documents registering a `ConversationNodeDefinition`
   * over a plugin-owned event plus a keyed `conversation.chat.node` renderer, and the shipped approval
   * panel declares a `conversation.approval.detail` region whose only owner prop is `callId` — which
   * is why the call id is recorded here.
   *
   * @param {object} agent - the asking agent; its `session` receives the event.
   * @param {object} ref - the serialized `ImageAttachmentRef` to reference.
   * @param {object} [facts] - correlation facts recorded beside the reference.
   * @param {string} [facts.callId] - the correlated tool call, when the asker supplied one.
   * @param {string} [facts.action] - the gated action (`click` | `fill` | `submit` | `navigate`).
   * @param {string} [facts.toolName] - the tool raising the request.
   * @returns {boolean} whether the frame is now readable by a Client.
   */
  #admitFrame(agent, ref, facts = {}) {
    const session = agent?.session
    if (session === undefined || typeof session.append !== 'function') {
      this.#logger?.warn?.(
        '[dsh-cua-preview] cannot reference the approved frame: the agent has no Session log; ' +
          'the card will not show it',
      )
      return false
    }
    try {
      // `content` is the position the Host authorizer scans. The event type is plugin-owned and
      // log-only, and it carries no surface metadata.
      session.append('cua/preview', {
        content: [{ type: 'image', attachment: ref }],
        ...facts,
      })
      return true
    } catch (error) {
      // Failing to reference the frame must not fail the approval: the user is still asked, and
      // the result reports that the credential cannot be displayed instead of the card trying to
      // load an image the Host will refuse.
      this.#logger?.warn?.(
        `[dsh-cua-preview] could not reference the approved frame from the Session log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return false
    }
  }

  /**
   * Persist one captured frame via the documented attachment service, falling back to the file
   * already written to disk.
   *
   * @param {object} screenshot - the object returned by `BrowserController.screenshotToFile`.
   * @returns {Promise<object|null>} an `ImageAttachmentRef`-shaped value, or null.
   */
  async #persistImage(screenshot) {
    const attachments = this.#ctx.get('attachments')
    if (attachments === undefined) return null
    const ref = await attachments.saveImage({
      data: screenshot.data,
      mediaType: 'image/png',
      name: 'cua-preview.png',
    })
    // Serialize the ref to a plain value; the tool's output schema must stay lossless JSON.
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  }
}

/**
 * Write one captured frame to disk without the attachment service.
 *
 * Used by the standalone harness (acceptance criterion 3), which runs the same broker logic
 * without a live DSH process.
 *
 * @param {string} directory - target directory.
 * @param {string} name - file name.
 * @param {Buffer} data - PNG bytes.
 * @returns {Promise<string>} the written path.
 */
export async function writeScreenshotFile(directory, name, data) {
  const path = join(directory, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path, data)
  return path
}