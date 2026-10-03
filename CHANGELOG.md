# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
- The approval `reason` carries only the action description — no file path, dimensions or byte count,
  which had grown the card and been clamped by one renderer.
- Target naming follows the page's own accessible name instead of the CSS selector alone, and
  `input.value` is excluded from that chain except for submit-style inputs.
- Tests depend on the published DSH packages as dev dependencies, so the suite is reproducible on any
  machine instead of relying on one local install.

### Notes

- The plugin is a DSH **bundle**: it ships a configuration layer, and a profile is what boots it.
- This is an unofficial community work, not affiliated with, authorized, sponsored or endorsed by
  Z.AI Co., Ltd or DeepSeek. The approval architecture follows ZCode's `cua-permission-broker` as a
  design borrowing; no ZCode source is copied.
