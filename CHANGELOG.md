# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A gated action made its own session unopenable, and the plugin no longer writes to the Session log at
  all.** The approval-time frame used to be referenced from a plugin-owned `cua/preview` session event.
  That type is outside the harness's `KNOWN_SESSION_EVENT_TYPES`, and the envelope's `ignorable: true`
  marker — the one mechanism that makes an out-of-repo event safely skippable — cannot be set by a live
  writer: `Session.append(type, data, opts)` copies only `sourceEventSeqs` and `surfaceOp` out of `opts`.
  Every session that had run a gated action therefore landed on disk with an unknown, *required* event,
  and the persistence reader refused it from then on: *"contains event type \"cua/preview\" (seq 9403)
  unknown to this harness and not marked ignorable; refusing to interpret the log"*. The visible effect
  was a conversation whose history would not load after a harness restart, while the host kept appending
  to the same log. The plugin now appends nothing; the frame reaches the Client through the call's own
  `tool/result` content, which is a known event type the Host authorizes. Also present in `0.1.0`.
- **The suite now fails if this reappears.** `scripts/verify-client-bundle.mjs` rejects any `.append(` in
  `src/` (comments stripped, so documentation that names the API is not mistaken for a call to it) and
  any dependency on the Conversation event service; the acceptance harness asserts that every event in
  the live log is inside `KNOWN_SESSION_EVENT_TYPES` and that only the harness's own types appear; and the
  real-product probe reports the same two facts from a log the shipped `dsh` binary wrote. The defect
  survived a release because nothing had ever looked at the log the plugin produced.

### Added

- **The screen is on screen while the approval is being decided.** The call's row now paints the current
  screen from the moment the card appears, read *live* from the Host rather than from the log: the frame
  captured an instant before the ask is held under the call id (`src/pending-frames.js`) and served to the
  operator's own browser on an exact Fetch route, `GET`/`HEAD` `/api/cua-preview.frame`
  (`src/frame-route.js`). That route is the shape the documents name for a browser-native response
  (`docs/api-gateway.md`: *"A feature that needs a streamed or browser-native response registers an exact
  Connection Fetch route instead of defining a Remote method"*; `docs/subsystems/web-client.md`:
  *"feature-owned downloads register exact Fetch routes"*), admitted only through the browser-session trust
  boundary, marked `no-store`, and withdrawn with the plugin. The Client half reads it through a resource
  of its own, `dsh-resource://cua/frame/<callId>`, retrying on `404` with a bounded backoff — the row is
  mounted when the call is dispatched, a moment before the capture exists. The route stops serving a call
  the instant its own result exists (the result carries the same picture), and it is skipped entirely on a
  Host that mounts no such registry: the tools load and every gated action works either way. `connection`
  is deliberately **not** a declared dependency, so the route attaches through `ctx.inject` when that
  service appears — a one-shot `ctx.get('connection')` inside `apply` was measured to lose that race in the
  real web profile, which would have silently disabled the preview in the only profile that has one.
- **The post-action screenshot now waits for the page to react.** `page.click()` returns the moment the
  input is dispatched, and `goto` with `domcontentloaded` returns before a JS-rendered page has rendered
  anything, so the frame used to be the state the action *started* from: measured against a page whose
  own reaction takes 900 ms, it was written 64 ms in and still read `PENDING`. Every gated action now
  waits for a grace period, then for the network to go quiet, then for the DOM to stop changing, all
  bounded by a budget (250/400/3000 ms by default). New `settle` config: `false` skips the wait, a
  number is the total budget, an object overrides any of the three values; anything else is logged and
  ignored rather than failing the load.
- `settled` / `settleMs` / `networkBusy` on a granted `browser_navigate` / `browser_act` result, and a
  line in the model-facing text when the budget ran out. A heuristic cannot promise a frame is final, so
  the result says so instead of the plugin claiming more than it verified; with `settle: false` the
  fields are absent entirely.

### Changed

- **A granted action now returns both frames, and the row captions each by role.** The approval-time
  frame is no longer a separate session event (see `Fixed`): it is the *first* image block of the
  granted result, followed by the post-action frame, and `presentationMeta` gained `frames`
  (`['before','after']`, `['before']` on a refusal or when the post-action capture failed) so the Client
  never has to infer a caption from an image's position or from `granted` alone. The row therefore paints
  `before the action` above `after the action`, and a legacy result without `frames` still captions its
  single frame the way the build that wrote it did. Nothing the plugin shows is carried by a session event
  of its own any more: while the approval is open the row paints the live screen (see Added), and once the
  call returns it paints the frames from the call's own result.
- **Adapted to DSH `0.2.0-rc.2`.** The development dependencies now track that release train
  (`@deepseek-ai/dsh-*` `0.2.0-rc.2`, `@deepseek-ai/cordis` `4.0.4`, `@deepseek-ai/cordis-plugin-loader`
  `1.0.5`, `@deepseek-ai/schemastery` `3.18.4`), and the obsolete `@deepseek-ai/dsh-code-runtime` dev
  dependency is gone: `0.2.0-rc.2`'s `dsh-tools` peers on `dsh-ptc-runtime` instead, and the old pin
  made `npm install` fail with `ERESOLVE` (it peers `cordis@4.0.2`, which that graph rejects).
- The Client tool row now reads the explicit `phase` discriminant (`preparing` / `start` / `result`)
  that `0.2.0-rc.2` passes beside a stage-specific `block`, and paints only the tool's name while a call
  is still preparing, because a `preparing` block carries no arguments yet. The older shape — where the
  stage had to be inferred from the result node's `kind` — is still accepted, so hosts on
  `0.1.5-rc.2`/`rc.3` keep working, and a stage this build has never heard of degrades to "still
  running" rather than to a result.
- The real-process check pins the approval policy to `ask`. A `web` profile whose default preset is
  `danger-full-access` gets `approval: never`, under which `ApprovalService.decide()` returns
  "rejected" *before* the `approval/request` waterfall — so the probe's own answerer was unreachable and
  the run described the operator's preset rather than the plugin.

### Notes

- **Known limitation on DSH `0.2.0-rc.2`: the approval reason is always English.** `dsh-settings` was
  replaced by `SettingsForms`, a configuration-form projection with no value-read API, and
  `@deepseek-ai/dsh-client-locale` stopped registering a `locale` settings namespace — so there is no
  Host-side channel left for a plugin to read the interface language from, and
  `Click the button "Go" (#go)` is produced even where the profile declares `preference: zh`. The plugin
  degrades to English rather than failing, and the real-process check now asserts this against the
  profile's own declared locale instead of deriving its expectation from the same dead channel (which
  is how the regression stayed invisible before). On `0.1.5-rc.2`/`rc.3` hosts the Chinese sentence still
  appears.

## [0.1.0]

First release. Everything below shipped together, so the entries describe the initial state of the
project rather than a sequence of published versions — including the defects that real use found and
the checks that now pin them.

### Added

- `browser_navigate`, `browser_act` (`click` / `fill` / `submit`), `browser_snapshot` and
  `browser_screenshot` tools, registered into the DSH tool registry. The read-only pair never raises an
  approval, because neither can change the page.
- An approval gate in front of every navigating or acting call. The action is described in one line in
  the UI language, and the screen is captured at ask time so the user reviews what they are approving.
- Both frames are kept and returned through separate documented channels: the post-action frame as the
  model-facing result image, the approval-time frame as a log-only `cua/preview` session event that the
  Client reads and paints.
- A Client half whose entire footprint is one hidden Conversation node and three keyed tool seats. It
  registers into no shipped single-occupancy slot.
- A refusal notice that names the shipped gating path's own sentence verbatim in both languages, states
  that the refusal is a human decision rather than a failure, and tells the model to stop and ask the
  user instead of retrying.
- Three test entries: a Client-bundle verifier, an acceptance harness against the real DSH services, and
  a probe that boots the shipped `dsh` binary with the plugin patched in.
- `examples/test-page/` — a local page with a field, a button and a form, used by the acceptance checks.
- An MIT license and a `docs/design.md` design record, plus a Chinese README (`README.zh.md`).

### Fixed

- **The approval-time frame was reported to the model as the action's result.** For a navigation that
  frame is always the pre-action tab, so a model could read it as a failed action. Both frames are now
  kept and named.
- **The approved frame was described but not readable**, rendering "screenshot could not be loaded":
  the Host authorizes an attachment read by scanning specific event positions, and `result.meta` is not
  one of them. The frame is now referenced from the plugin's own log-only event.
- **The credential could only be painted after the user had already decided**, because a tool row is
  settled-only. It now reaches the Client through the hidden carrier node while the approval is pending.
- **The two frames rendered in the wrong order.** The carrier is now hidden, and the single row that
  owns the call paints both frames in the order they happened.
- **`fill` appended instead of replacing**: triple-click does not reliably select on a plain text input.
  The field is now cleared explicitly before typing.
- **A `single` slot collision failed a shipped Client package** and broke the whole client plugin load.
  The plugin now registers only into slots it owns, and the verifier asserts coexistence with the
  shipped occupant.
- **A first navigation's credential frame was a pure-white blank tab.** A blank screen now emits no
  frame at all, recorded as a distinct state from a capture failure.
- **A refusal never reached the model.** A `required: true` annotation on a shared schema node made two
  optional image fields mandatory, so a refusal failed output validation and the model received a
  schema error instead of the refusal — which is what invited a retry against a user who had just said
  no. The annotation is removed, the fields are genuinely optional, and the refusal path is now
  dispatched through the tool pipeline in every harness.
- The Client row crashed on a `null` block during replay; it now renders without throwing.

### Changed

- The tool descriptions state the screenshot timing, and the gated tools state the stop-and-ask rule, so
  both are in the system prompt before the model acts rather than only in a result afterwards.
- The approval `reason` carries only the action description: no file path, dimensions or byte count. The
  shipped panel renders that string as the card's headline, so it stays one line.
- Target naming follows the page's own accessible name instead of the CSS selector alone, and
  `input.value` is excluded from that chain except for submit-style inputs.
- Tests depend on the published DSH packages as dev dependencies, so the suite is reproducible on any
  machine instead of relying on one local install.

### Notes

- The plugin is a DSH **bundle**: it ships a configuration layer, and a profile is what boots it.
- This is an unofficial community work, not affiliated with, authorized, sponsored or endorsed by
  Z.AI Co., Ltd or DeepSeek. The approval architecture follows ZCode's `cua-permission-broker` as a
  design borrowing; no ZCode source is copied.
