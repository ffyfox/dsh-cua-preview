/**
 * dsh-cua-preview — a DSH plugin for browser automation with approval-gated actions and
 * screenshot preview.
 *
 * Plugin shape is the documented one (`docs/user/develop/basic/index.md`): a module exporting
 * `name` and an `apply(ctx)` function, plus an `inject` array naming the services it consumes.
 * Cordis calls a function plugin as `(ctx, config)`, which is how this plugin reads its options.
 * Everything registered here is torn down automatically when the plugin unloads.
 *
 * The approval architecture follows ZCode's `cua-permission-broker` as a design borrowing (no source
 * is copied). `approval-broker.js` names the four borrowed rules and where each came from.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserController } from './browser.js'
import { CuaApprovalBroker } from './approval-broker.js'
import { registerBrowserTools } from './tools.js'
import { PendingFrames } from './pending-frames.js'
import { registerFrameRoute } from './frame-route.js'

export const name = 'dsh-cua-preview'

/**
 * Required services.
 *
 * `tools` is required to register anything. `approval` is required because an unapproved plugin
 * must fail to load rather than load in a state where it could act without a gate — matching the
 * fail-closed stance of both the DSH approval seam and ZCode's broker.
 *
 * `attachments` is deliberately **not** injected: the official `read_image` tool pattern gates its
 * registration on an attachment store being present, and the plugin must still work without one
 * (the PNG stays on disk). `ctx.get('attachments')` is consulted at call time instead.
 */
export const inject = ['tools', 'approval']

/** Live plugin instances. See {@link cuaPreviewOf}. */
const liveInstances = []

export function apply(ctx, config = {}) {
  const artifactsDir = config.artifactsDir
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cua-preview', 'artifacts')

  const browser = new BrowserController({
    ...(config.chromePath === undefined ? {} : { executablePath: config.chromePath }),
    headless: config.headless ?? true,
  })

  // The approval-time frame is held here for as long as an approval is pending, so the operator's
  // own browser can put the screen in front of the person making the decision. `frame-route.js`
  // serves it; the two gated tools drop it again the moment their result exists.
  const frames = new PendingFrames()

  const broker = new CuaApprovalBroker({
    ctx,
    artifactsDir,
    logger: ctx.logger,
    frames,
  })

  registerBrowserTools(ctx, { browser, broker, logger: ctx.logger })
  // Reported, not asserted: a Host without an exact-Fetch registry is a normal state (an in-process
  // tree, a headless profile), and the operator's browser then simply shows no live screen while an
  // approval is open. The object is a live record — `connection` is not a declared dependency, so the
  // route attaches through `ctx.inject` whenever that service appears, which can be after this line.
  // `frameRoute.registered` is on the instance so a host or probe can tell the two situations apart
  // instead of guessing from the absence of a log line.
  const frameRoute = registerFrameRoute(ctx, frames, ctx.logger)

  // Test/host introspection only. This is deliberately NOT a Cordis service: publishing one
  // would add a public surface the task did not ask for, and `ctx.set` requires a declared
  // `provide`. Note the plugin receives its own derived context, so instances are tracked in a
  // list rather than keyed by a context identity the caller cannot reconstruct.
  const instance = { browser, broker, artifactsDir, frames, frameRoute }
  liveInstances.push(instance)

  // Explicit cleanup: the browser is an external process, so it needs a disposer rather than
  // relying on the automatic event/tool teardown (`docs/user/develop/framework/index.md`). The held
  // frames go with it: they are pictures of the operator's screen and must not outlive the instance
  // that took them. (The route itself is withdrawn by the effect `registerFrameRoute` owns.)
  ctx.effect(() => () => {
    const index = liveInstances.indexOf(instance)
    if (index >= 0) liveInstances.splice(index, 1)
    frames.clear()
    return browser.close()
  }, 'dsh-cua-preview: close browser')

  ctx.logger?.info?.(`[dsh-cua-preview] loaded; screenshot artifacts -> ${artifactsDir}`)
}

/**
 * The live plugin instance whose artifacts directory matches, or the most recent one.
 *
 * Read by the acceptance harness and available to a host that wants to inspect broker decisions.
 *
 * @param {object} [filter]
 * @param {string} [filter.artifactsDir] - select the instance writing to this directory.
 * @returns {{browser: object, broker: object, artifactsDir: string, frames: object,
 *   frameRoute: {registered: boolean, path: string, reason: string|null}}|undefined}
 */
export function cuaPreviewOf(filter = {}) {
  if (filter.artifactsDir !== undefined) {
    return liveInstances.find((instance) => instance.artifactsDir === filter.artifactsDir)
  }
  return liveInstances.at(-1)
}