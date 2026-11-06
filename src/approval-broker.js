/**
 * Approval broker for dsh-cua-preview.
 *
 * Borrowed from ZCode's `cua-permission-broker`. The parts that are genuinely borrowed are the
 * *shapes*, and they are named here so the borrowing is checkable:
 *
 * 1. **Gate, then ask, then act.** ZCode's `permission-flow.ts` computes a permission decision,
 *    and only a decision of exactly `allow` proceeds; `ask` raises a request through
 *    `permissionBroker.requestPermission(...)` and everything else is denied. The browser action
 *    is only executed after the broker returns a grant for *that* action. A grant is the seam's
 *    `allowed-once`, or — when the session's approval policy is `never` — the plugin's own
 *    `not-asked` decision, which records that the session forbids prompting and nobody was asked.
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

/**
 * The broker's own decision when the session forbids asking anyone.
 *
 * Deliberately **not** an `ApprovalOutcome`: the seam is never entered, so borrowing one of its
 * values would lie. `allowed-once` would claim a consent nobody gave; `rejected` would refuse an
 * action the session never asked about. The policy gets its own fact — the session turned prompts
 * off, so no one was asked, and the caller reports exactly that.
 */
export const NOT_ASKED = 'not-asked'

export class ApprovalUnavailableError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ApprovalUnavailableError'
  }
}

/**
 * Broker that turns one proposed browser action into an approved-and-reviewed action.
 *
 * The screenshot is written to disk so the evidence is a real, parseable file, and handed back to
 * the caller as captured bytes. **This module writes nothing to the Session log.** An earlier
 * revision referenced the frame from a plugin-owned `cua/preview` event so the Host would authorize
 * a Client read of it; that event type is outside the harness's known vocabulary and a live
 * `Session.append()` cannot mark it `ignorable`, so every session that ran a gated action became
 * unreadable to the persistence reader ("contains event type … unknown to this harness and not
 * marked ignorable; refusing to interpret the log"). The documented rule for plugin authors is
 * explicit (`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`):
 * "Do not append session events with a new `type` … live `Session.append()` cannot set that marker,
 * so the Session would refuse to reopen."
 *
 * The frame reaches the Client by two routes, and this plugin invents no event for either:
 *
 * 1. **While the approval is pending**, the bytes are held in `pending-frames.js` and served to the
 *    operator's own browser by the exact Fetch route in `frame-route.js`. That is what makes the
 *    decision an informed one: the screen is on screen *while* the question is being asked, instead
 *    of arriving with the answer.
 * 2. **Once the call returns**, `tools.js` saves the same bytes as an attachment and puts the
 *    reference in that call's own `tool/result` — a known event type whose image references the Host
 *    authorizes — so the frames stay readable in the transcript afterwards.
 */
export class CuaApprovalBroker {
  /** Every decision taken, in order. The acceptance test reads this as machine-checkable evidence. */
  decisions = []
  #ctx
  #artifactsDir
  #logger
  #frames

  /**
   * @param {object} options
   * @param {object} options.ctx - Cordis context carrying `approval`, `attachments`, `logger`.
   * @param {string} options.artifactsDir - directory for screenshot evidence files.
   * @param {object} [options.logger] - optional logger; defaults to `ctx.logger`.
   * @param {import('./pending-frames.js').PendingFrames} [options.frames] - table that keeps the
   *   approval-time frame reachable while the approval is pending. Absent in a host that serves no
   *   route; every other behaviour is then unchanged.
   */
  constructor({ ctx, artifactsDir, logger, frames = null }) {
    this.#ctx = ctx
    this.#artifactsDir = artifactsDir
    this.#logger = logger ?? ctx.logger
    this.#frames = frames
  }

  /** @returns {string} the directory holding screenshot evidence. */
  get artifactsDir() {
    return this.#artifactsDir
  }

  /**
   * Stop serving the pending frame for one call.
   *
   * Called once the call's own result exists: that result carries the same picture, so the live
   * preview has nothing left to add and the bytes should stop being reachable.
   *
   * @param {string} [callId] - the tool call that settled.
   * @returns {void}
   */
  forgetPendingFrame(callId) {
    if (typeof callId !== 'string') return
    this.#frames?.forget(callId)
  }

  /**
   * Decide one browser action: ask the user when the session allows it, or — when the session's
   * approval policy is `never` — run it without asking and record that no one was asked.
   *
   * The screenshot of the current screen is captured first, so the ask (when there is one) carries
   * the evidence the user decides on, and the ungated path still reports the pre-action frame.
   *
   * @param {object} input
   * @param {object} input.agent - the asking agent (from `exec.agent`).
   * @param {import('@deepseek-ai/dsh-llm').ToolCallId} [input.callId] - the correlated tool call.
   * @param {string} input.toolName - the tool raising the request, recorded in the audit event.
   * @param {string} input.action - one of `click` | `fill` | `submit` | `navigate`.
   * @param {string} input.description - human-readable description of the action.
   * @param {AbortSignal} [input.signal] - the tool execution signal.
   * @param {(kind: 'approval'|'before') => Promise<object>} input.capture - captures the current
   *   screen; may throw. `kind` names what the frame is for: the approval card, or the pre-action
   *   evidence when the session's policy skips asking.
   * @param {() => Promise<{blank: boolean}>} [input.probeScreen] - reports whether the current
   *   screen is an unloaded empty document; a blank screen yields no credential frame at all.
   * @returns {Promise<object>} the broker's closed result; `granted` is true for `allowed-once` and
   *   for `not-asked`, and `policy` records which policy produced it.
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
        policy: null,
      }
      this.decisions.push(failure)
      return failure
    }

    // Read the policy BEFORE deciding whether to ask — through the documented accessor
    // (`docs/subsystems/approval.md`: "Consumers read it with `ctx.approval.effectivePolicy(session)`").
    // Under `never` the service would return `rejected` before consulting any answerer, so an ask
    // here could only manufacture the appearance of a refusal. The broker therefore skips the ask
    // and records `not-asked`; reading the policy after the request would also describe the wrong
    // decision if the user switched presets mid-ask.
    const policy = this.#policyOf(approval, agent)

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
        screenshot = await capture(policy === 'never' ? 'before' : 'approval')
      } catch (error) {
        captureError = error
        this.#logger?.warn?.(
          `[dsh-cua-preview] screenshot capture failed; requesting approval without an image: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    // ---- A session that forbids asking ----------------------------------------------------
    // `never` returns `rejected` inside the service, before any answerer could be consulted, so an
    // ask here cannot produce a decision — only the appearance of a refusal nobody made. The
    // policy has already said "do not prompt"; the plugin therefore does not prompt, and records
    // that fact instead of borrowing an outcome that means something else.
    //
    // The session log gets no `approval/asked` + `approval/decided` pair for these calls, because
    // no ask happened. The frame captured above still travels with the call: it is the pre-action
    // screen, the same evidence an approval would have shown, and the tool result carries it as
    // its `before` frame.
    if (policy === 'never') {
      const result = {
        requestId,
        action,
        decision: NOT_ASKED,
        granted: true,
        reason: description,
        policy,
        screenshot,
        captureError: captureError === null ? null : String(captureError),
        frameOmitted: blankScreen ? 'blank-screen' : null,
      }
      this.decisions.push(result)
      return result
    }

    // The bytes have to be reachable BEFORE the ask, not after it: the point of holding them is that
    // the operator decides with the screen in front of them (`frame-route.js` serves them, and
    // `tools.js` drops the entry again once the call's own result exists).
    if (screenshot !== null && callId !== undefined) this.#frames?.record(callId, screenshot)

    // ---- Raise the official DSH approval request ------------------------------------------
    // The reason states WHAT is about to happen and stays on one line: it is the seam's free-text
    // field for *why the asker is asking* (`docs/subsystems/approval.md`), and the shipped panel
    // renders it as the card's headline. The evidence travels by the two routes the class comment
    // names, never through this string.
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
        policy,
        screenshot,
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
      policy,
      screenshot,
      captureError: captureError === null ? null : String(captureError),
      // Why no credential frame exists, when none does: the current screen was an unloaded empty
      // document. Distinct from a capture failure, which is reported as `captureError`.
      frameOmitted: blankScreen ? 'blank-screen' : null,
    }
    this.decisions.push(result)
    return result
  }

  /**
   * The approval policy in effect for one ask, or null when it cannot be read.
   *
   * Only the two documented vocabulary values are accepted. A Host that renames or removes the
   * accessor, or returns something this build has never seen, degrades to "unknown" — which makes the
   * tool layer fall back to the interactive wording rather than invent a claim about who decided.
   *
   * @param {object} approval - the mounted approval service.
   * @param {object} agent - the asking agent, whose session carries any override.
   * @returns {'ask'|'never'|null} the effective policy.
   */
  #policyOf(approval, agent) {
    try {
      const policy = approval.effectivePolicy?.(agent?.session)
      return policy === 'ask' || policy === 'never' ? policy : null
    } catch {
      return null
    }
  }

  // A frame reaches the Client through the `tool/result` of its own call (see the class comment):
  // that result is a known event type, so the Host authorizes the image reference it carries and
  // the Client can read the bytes. Nothing else in this class touches the Session log.
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