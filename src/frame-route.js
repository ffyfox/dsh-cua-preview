/**
 * The Host-side Fetch route that serves the frame of an approval that is still pending.
 *
 * ## Why a Fetch route, and not a Remote method
 *
 * The operator has to see the screen *before* deciding, and at that instant the call has produced no
 * result — so there is no logged event to reference the image, and the client-side image loader only
 * resolves references a known event carries (`dsh-api-session-controller`: `referencedImage` →
 * `ATTACHMENT_NOT_REFERENCED`). The bytes are the Host's own, taken a moment earlier, and this route
 * hands them to the operator's browser as a plain image response. The documents name this shape for
 * exactly this case:
 *
 * > A feature that needs a streamed or browser-native response registers an exact Connection Fetch
 * > route instead of defining a Remote method.
 * > — `docs/api-gateway.md`, "API layers"
 *
 * The physical contract is the Connection package's own reference
 * (`@deepseek-ai/dsh-client-connection/README.md`): the Host half always provides the
 * carrier-neutral exact `GET`/`HEAD`/`POST` route registries; each route declares buffered or
 * streaming request-body handling *before* the bridge reads any bytes; feature packages register
 * non-JSON responses such as session-log downloads and raw file uploads. Every request on this route
 * passes the browser-session trust boundary first (the operator's signed cookie, plus the Host/Origin
 * checks), so only the operator's own browser can read the frame, and the answer is marked
 * `cache-control: no-store` because the same call id must never be served a stale picture.
 *
 * ## Failing soft is the point
 *
 * The preview is an aid to the decision, never a precondition for it. A Host without a connection
 * service (an in-process test tree, a headless profile) registers no route, and every gated action
 * still runs and still returns its frames through the call's own result. Nothing here can fail an
 * approval, and nothing here decides whether the user is asked.
 */

/** The exact route path. One dotted segment, following the shipped `present.host` convention. */
export const FRAME_ROUTE = '/api/cua-preview.frame'

/** The query parameter carrying the tool call the frame belongs to. */
export const FRAME_CALL_ID = 'callId'

/**
 * Answer one request on the frame route.
 *
 * Three outcomes, and each is a different fact:
 *
 * - `200` — a frame is pending for that call id; the body is the PNG.
 * - `404` — nothing is pending (not captured yet, already replaced by the result, blank screen, or a
 *   capture failure). The Client treats this as "ask again", which is why it is not an error.
 * - `400` — the request names no call id at all. A Client this plugin ships cannot produce that, so
 *   it is reported as a malformed request rather than silently read as "nothing yet".
 *
 * @param {Request} request - the routed request.
 * @param {import('./pending-frames.js').PendingFrames} frames - the pending-frame table.
 * @returns {Response} the response to send.
 */
export function frameResponseFor(request, frames) {
  const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET'
  const headers = { 'cache-control': 'no-store' }

  let callId = null
  try {
    callId = new URL(request.url).searchParams.get(FRAME_CALL_ID)
  } catch {
    callId = null
  }

  if (callId === null || callId === '') {
    return new Response(method === 'HEAD' ? null : `"${FRAME_CALL_ID}" is required\n`, {
      status: 400,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const frame = frames.peek(callId)
  if (frame === null) {
    return new Response(method === 'HEAD' ? null : 'no approval frame is pending for that call\n', {
      status: 404,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(method === 'HEAD' ? null : frame.data, {
    status: 200,
    headers: { ...headers, 'content-type': frame.mimeType },
  })
}

/**
 * Register the frame route on the Host, when the Host has an exact-Fetch registry.
 *
 * ## Why this waits for the service instead of reading it once
 *
 * `connection` is deliberately **not** a dependency this plugin requires: a Host without it is a
 * normal state (an in-process tree, a headless profile), and the tools must load regardless. But it
 * is also a service that can be mounted *after* this plugin's own dependencies are ready — measured
 * against the real `web` profile, where reading `ctx.get('connection')` once inside `apply` found
 * nothing while the same read from a row that starts later found the registry. A one-shot read is
 * therefore a race, and losing it would silently disable the live preview in exactly the profile that
 * has one.
 *
 * `ctx.inject(deps, callback)` is the documented answer: it starts a child fiber that runs when the
 * service appears and is undone when the service goes away, so the route's lifetime follows the
 * registry's. The `ctx.inject`-less path below exists only for a Host whose context is not a Cordis
 * context at all.
 *
 * @param {object} ctx - the plugin context.
 * @param {import('./pending-frames.js').PendingFrames} frames - the pending-frame table to serve from.
 * @param {object} [logger] - optional logger.
 * @param {{registered: boolean, path: string, reason: string|null}} [report] - live record of what
 *   happened, updated in place (the registration can complete long after this call returns).
 * @returns {{registered: boolean, path: string, reason: string|null}} the same report object.
 */
export function registerFrameRoute(
  ctx,
  frames,
  logger,
  report = { registered: false, path: FRAME_ROUTE, reason: null },
) {
  const settle = (registered, reason) => {
    report.registered = registered
    report.reason = reason
    return report
  }

  /** Attach to one scope that should carry the Connection service. */
  const attach = (scope) => {
    const registry = (scope?.connection ?? scope?.get?.('connection'))?.fetch
    const register = registry?.register
    if (typeof register !== 'function') {
      logger?.info?.(
        '[dsh-cua-preview] no exact-Fetch registry is mounted; the pending-approval preview is ' +
          'unavailable and gated actions keep working without it',
      )
      return settle(false, 'no exact-Fetch registry is mounted')
    }
    try {
      scope.effect(
        () =>
          register.call(registry, {
            path: FRAME_ROUTE,
            // HEAD lets a client ask "is it there yet" without pulling the bytes twice.
            methods: ['GET', 'HEAD'],
            requestBody: 'buffered',
            fetch: (request) => frameResponseFor(request, frames),
          }),
        'dsh-cua-preview: pending-approval frame route',
      )
      return settle(true, null)
    } catch (error) {
      // A conflicting route (another instance already claimed the path, say) must not stop the plugin
      // from loading: the tools are the product, the live preview is an aid to one decision.
      const reason = error instanceof Error ? error.message : String(error)
      logger?.warn?.(
        `[dsh-cua-preview] could not register ${FRAME_ROUTE}; the pending-approval preview is ` +
          `unavailable: ${reason}`,
      )
      return settle(false, reason)
    }
  }

  if (typeof ctx.inject !== 'function') return attach(ctx)
  settle(false, 'waiting for the connection service')
  ctx.inject(['connection'], (connectionCtx) => {
    attach(connectionCtx)
  })
  return report
}
