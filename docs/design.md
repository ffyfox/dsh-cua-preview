# Design

How `dsh-cua-preview` is put together, and why each piece is the way it is. Every claim here is either
read out of the shipped DSH implementation or verified by a check in `npm test`.

## Two halves

| Half | File | Loaded by |
|---|---|---|
| Host | `src/index.js` (+ `browser.js`, `approval-broker.js`, `tools.js`, `action-text.js`) | the DSH Loader, through the bundle's patch row |
| Client | `src/client/browser.js` | the Web Client's module loader, through `exports["./client"]` |

The Host half is what makes the browser move; the Client half is what makes a screenshot *visible*.
They are independently loadable, and the Client half is optional in the sense that the plugin works
without a browser attached — the model still gets its result image, it is simply not painted.

## The tools

Four tools are registered into `ctx.tools`:

| Tool | Approval-gated | Returns |
|---|---|---|
| `browser_navigate` | yes | the loaded page, post-navigation |
| `browser_act` (`click` / `fill` / `submit`) | yes | the page after the action |
| `browser_snapshot` | no | the current URL, title and visible text |
| `browser_screenshot` | no | the current screen as an image |

The gated pair raises the approval from inside `execute()`, using the `agent` the execution carries.
A tool execution is always inside an open turn, which is what `ctx.approval.request` requires.

## The two frames, and why there are two

The approval happens *before* the action, so the frame captured at ask time is the **pre-action**
state — the thing the user is being asked to approve. The frame the model needs is the **post-action**
state, because a model that reads a pre-action image as "the result" concludes the action failed.

Both are kept, each named for what it is:

| Frame | Written as | Where it goes |
|---|---|---|
| Approval-time (pre-action) | `approval-*.png` | the result's first image block, captioned `before the action`; also `approvalScreenshotPath` for audit |
| Result (post-action) | `after-*.png` | the result's second image block, captioned `after the action` |

The tool descriptions state this, so the rule is in the system prompt rather than being tribal
knowledge. On a **refusal** there is no post-action state to show, so the single returned frame *is*
the approval-time frame, captioned `at approval time (no action ran)`.

## Where an image can travel, and where it cannot

`ApprovalRequest` carries `agent`, `toolName`, `callId`, `reason` and `signal` — **there is no image
field**, and none is invented. The channels that carry an image are:

| Channel | Mechanism | Used for |
|---|---|---|
| Result content | `output.render` → `{ type: 'image', attachment }` blocks | both frames: the approval-time one first, then the post-action one |
| Result-time card data | `output.presentationMeta(args, value)` → persisted on `tool/result` as `result.meta` | which frame is which (`frames`), plus the audit pointers (`granted`, `decision`, `approvedPath`) |
| ~~A plugin-owned session event~~ | `session.append('<plugin type>', …)` | **not available** — see below |

### A plugin may not append its own session event type

The envelope's `ignorable?: true` marker exists precisely for out-of-repo plugin events
(`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`): the
persistence reader refuses to interpret a stored log containing an unknown type *unless that stored
record* carries the marker. A live writer cannot set it — `Session.append(type, data, opts)` copies only
`sourceEventSeqs` and `surfaceOp` out of `opts` into the envelope — so a plugin-owned event type lands on
disk unmarked, and every session that ever ran a gated action refuses to reopen:

```text
failed to observe session "…": session "…" contains event type "cua/preview" (seq 9403) unknown to this
harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer
harness
```

The plugin-author rule says the same thing
(`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`): "Do not append session
events with a new `type` … live `Session.append()` cannot set that marker, so the Session would refuse to
reopen. Derive state from existing events, or keep plugin-owned data in a storage service found through
inspection." Version 0.1.0 of this plugin appended one; removing it is the fix, and
`scripts/verify-client-bundle.mjs` now fails on any `.append(` that reappears under `src/`.

### `result.meta` describes an image but does not make it readable

The Host proves reachability **before** serving attachment bytes: `dsh-api-session-controller`'s
`attachment()` looks the reference up through `referencedImage` → `imageInEvent`, which scans exactly
`data.content`, `data.message.content`, `data.inserted[].content` and assistant-stream chunks. A
reference carried only in `result.meta` is in none of those positions, so a card told about the frame by
`meta` alone renders its caption and then *"screenshot could not be loaded"*. The frames therefore ride
in the call's own result content, and `meta.frames` says which is which.

## The frames on screen: one live frame while deciding, two frames afterwards

A gated action is reviewed in two stages, and each stage has its own picture.

**While the approval is open**, the row paints the screen as it is *right now*, so the decision is made
with the screen in front of it. Nothing has been logged at that moment — no result exists yet, and the
client-side image loader only resolves references that a known event carries — so these bytes cannot come
from the log. They come from the Host's own memory: the broker captures the frame an instant before it
asks, `pending-frames.js` holds it under the call id, and the operator's own browser reads it from the
exact Fetch route the Connection documents for a browser-native response:

> A feature that needs a streamed or browser-native response registers an exact Connection Fetch route
> instead of defining a Remote method. — `docs/api-gateway.md`

> The Connection owns … exact Fetch routes …; feature-owned downloads register exact Fetch routes.
> — `docs/subsystems/web-client.md`

An image is exactly that: a browser-native, non-JSON response, behind the same browser-session trust
boundary as every other `/api` request. The Client half reads it through a resource of its own,
`dsh-resource://cua/frame/<callId>` — the one seat that hands a component a live value synchronously —
and that provider has to ask more than once, because the row is mounted when the call is dispatched, a
moment *before* the Host takes the frame.

One seat looks like it should carry this and deliberately does not. **`conversation.approval.detail`** is
declared by the shipped panel and rendered inside the card above the decision buttons, which is exactly
where a frame belongs — but it is a `single` slot, and `@deepseek-ai/dsh-client-ui-chat` already registers
`ApprovalCommand` into it at priority 0. `SlotCore.register` throws on a second same-priority entry, and
the throw lands in whichever plugin registers second — which was the shipped `ui-chat`, failing the whole
client plugin set:

```text
Failed to load plugins
@deepseek-ai/dsh-client-ui-chat
single slot "conversation.approval.detail" already has a registration at priority 0
(registered by Ba) — register at a different priority to shadow it (lowest renders)
```

A lower priority would *shadow* the shipped occupant, deleting the pending call's command preview from the
approval card for every tool — a global regression traded for a plugin-local feature. The plugin therefore
paints the live frame in its own row instead.

**Once the call has settled**, the row paints the frames of the action in the order they happened:
`before the action` / image, then `after the action` / image. A refusal ran nothing: its single frame is
the approval-time state and is captioned `at approval time (no action ran)`. Roles come from
`presentationMeta.frames`, never from an image's position and never from `granted` alone — so a grant
whose post-action capture failed keeps `before the action` on its one frame.

**Every frame is painted into a box reserved from its own reference.** `ImageAttachmentRef` carries
`width` and `height` as required fields, filled by the attachment service's measurement of the bytes it
stored, so a frame's size is known before its bytes are; the loading paint is the same element with the
same geometry as the loaded one. The reason is the conversation's own scroll behaviour, not tidiness: a
row that grows again after the fact makes the shipped follow-the-tail controller drop the tail. Its growth
observer starts one smooth scroll on the first growth, the next growth arrives while that scroll is
outstanding and is skipped (`ScrollFollow.toBottom` returns while `this.target !== null`), and the landing
is then short of the taller floor — which `settle` reads as the reader having moved, releasing follow
intent for good. One growth leaves the app's own logic to land on the true bottom, which is what keeps the
`after the action` frame fully visible after an approval. A reference without usable dimensions reserves
nothing and keeps the plain-text placeholder rather than claiming a size it does not know.

What the live frame costs, stated rather than hidden:

- **It is a live read, not a record.** The route answers `404` the moment the call settles, because the
  result then carries the same picture, and the held entry expires on its own if a call dies mid-ask.
- **It is one more public surface.** A `GET`/`HEAD` route on the Host's `/api`, admitted only through the
  browser-session trust boundary, marked `no-store`, registered inside an effect so unloading withdraws
  it, and skipped entirely on a Host that mounts no such registry. The Host registers the absolute path;
  the Client fetches the document-relative one (`FRAME_ROUTE.slice(1)`), which is what every shipped
  Client does with its own route and the form that survives a document served under a path prefix.
- **The row has to ask again.** The first ask normally lands before the capture exists; the provider
  retries with a bounded backoff until the frame is there, the resource is released, or the window ends.

## What the plugin claims, and what it deliberately leaves alone

The Client half's entire footprint is three keyed `tool.call.toolview` seats — for `browser_act`,
`browser_navigate` and `browser_screenshot`, the three tools that carry an image. `browser_snapshot`
returns text only, so it needs no row. It registers no event definition, injects only `slots` and
`resources` (the two services its rows genuinely need: the keyed seats, and the resource seat that hands
every slot component `useResource`), and registers into **no `single` slot**, in particular not
`conversation.approval.detail` or `tool.call.images`. The rule this encodes: the only safe slots for a
third-party client plugin are ones it owns (keyed seats) or a `single` slot it has verified is free
against the *resolved* install — because a collision fails an unrelated shipped package, not the
plugin that caused it. `scripts/verify-client-bundle.mjs` enforces this with an allowlist, an
explicit "shipped single-occupancy slots untouched" check, a no-collision check over
`(name, key, priority)`, and a run of `apply` against the real `SlotCore` with the shipped occupant
already present — plus a control proving the registry really does reject a second same-priority
registration.

## Behaviour details worth stating

### `fill` replaces

`fill` clears the field (empty `value` plus a dispatched `input` event) before typing. It does **not**
rely on triple-click to establish a selection: that does not reliably select on a plain text input, so
the typed text was appended instead of replacing. The old code comment asserted the intent rather than
the behaviour, which made the bug harder to see; the current comment describes what happens, and a
check pins `"Alice"` then `"Bob"` → `"Bob"`.

### Waiting for the page to react

"After the action" used to mean "after `page.click()` returned", which is the wrong instant. Puppeteer's
`click` resolves once the input event is dispatched and does not wait for anything the page does with
it, and `goto` with `domcontentloaded` resolves before a JS-rendered page has rendered anything. The
consequence was measured against a fixture whose own reaction takes 900 ms: the frame the user was
asked to judge was written **64 ms** after the action and still read `PENDING`.

`BrowserController.settle` now runs between the action and the post-action capture:

1. **grace (250 ms)** — a reaction scheduled on a timer has not started when the action returns, so
   "nothing has changed yet" must not read as "already finished".
2. **network quiet (400 ms)** — `page.waitForNetworkIdle`. One detail matters and is easy to get wrong:
   puppeteer's inflight count decrements when a response's **headers** arrive, not only when the request
   finishes (`api/Page.js` subscribes to `requestfailed`, `requestfinished` **and** `response`). So this
   condition catches a request still *awaiting a response* — a slow server — and does **not** stay busy
   for a response body that is still streaming. A fixture built as an endless chunked stream therefore
   does not exercise it; the acceptance check uses an endpoint that never answers at all.
3. **DOM stable (400 ms)** — a fingerprint of `location.href`, `document.title`, the element count and an
   FNV-1a hash of `body.textContent`, sampled every 150 ms and required to repeat. `textContent` rather
   than `innerText` avoids forcing layout on every poll, and the hash is what catches an in-place change
   that keeps the same length.

The network condition is checked first and the DOM condition only once it holds: a page that is still
waiting for an answer is still working, so its DOM would not be settled anyway. Both conditions and the
whole wait are bounded by `capMs`, because a stream, a long-poll or an animation loop can keep a page
busy forever, and a tool call must not hang on one.

The budget is why `settled: false` exists. A heuristic cannot promise a frame is final, so the result
says which condition never held (`networkBusy`) and the model-facing text says the frame may be
mid-update. The alternative — silently returning a possibly-stale frame while the tool description
promises "the action's effect" — is a claim the plugin cannot support. Setting `settle: false` skips the
wait entirely and reports **no** `settled` field at all, for the same reason.

### A blank screen emits no frame

The credential frame of a *first* navigation is genuinely a blank tab — 1,280×800, 4,714 bytes, md5
`441d4a31…`, byte-identical across six separate runs — which is honest but useless. The plugin
therefore emits **no frame and no explanatory text** for a blank screen, recording the omission as
`frameOmitted: 'blank-screen'`, a state distinct from a capture failure (`captureError`).

The predicate is deliberately narrow: it requires **both** an unloaded URL (`about:blank` or the empty
string) **and** a document whose body has no child elements and no text. Pixel measurement was
rejected because it would misclassify a legitimately white page, an image-only page, or a canvas app,
and would suppress a real screen. A page set by `page.setContent()` on a fresh tab keeps `about:blank`
as its URL but has body children, so it is correctly *not* treated as blank.

### Target naming follows the page

`BrowserController.describe()` resolves an element's name through the accessible-name chain —
associated `<label>` (via `labels` / `aria-labelledby`) → `aria-label` → `placeholder` → `title` →
visible text — plus the enclosing form's id/name for a submit. The CSS selector is kept in
parentheses, because the approval is consent for one exact element.

**`input.value` deliberately does not join that chain** for an ordinary field: it is the field's
current contents, so an input holding `abc` would be announced as "the field abc". It participates
only for `<input type="submit|button|reset">`, whose visible name really does live there. An element
with no name at all falls back to its DOM shape (`#zh-bare (a <input type="text">)`) rather than to a
wrong label.

A `fill`'s text is quoted, whitespace-collapsed and truncated to 40 characters: "type into
#name-input" does not tell the user what they are approving.

### The sentence follows the UI language, where the Host still exposes one

The approval reason is one line, built per call. Its language is read from the Host's locale
preference the documented way: `ctx.get('settings').get('locale').preference`. Only `zh*` selects
Chinese; every other value, an absent field, an absent namespace, an absent service or a throwing
provider resolves to **English**, which is what every other string the plugin writes uses.

**DSH 0.2.0-rc.2 removed that channel, and this plugin degrades to English rather than pretending
otherwise.** In that release `dsh-settings` stopped being a document provider (`SettingsProvider`,
with `register` / `installSection` / `get` / `section`) and became `SettingsForms` — a
configuration-form projection whose only methods are `configure` / `describe` / `invalidate` /
`prepareDocument` / `schema` / `walk`, with **no way to read a namespace's value at all**.
`@deepseek-ai/dsh-client-locale` followed: `settings.register('locale', …)` became
`settings.configure({ auto: false }, …)`, and its own comment now says "Host preferences are consumed
through the configuration form projection". There is therefore no Host-side read left to make, and on
`0.2.0-rc.2` the reason is English even where the profile declares `preference: zh`. On
`0.1.5-rc.2`/`rc.3` hosts the preference is still readable and the Chinese sentence still appears.

Because the plugin and any harness that mirrors its read lose the channel *together*, a comparison
between them cannot detect this. The real-process check in `examples/run-real-dsh-load.mjs` therefore
takes its expectation from the locale the profile's own `cordis.patch.yml` declares — a fact the
plugin never sees — and asserts the fallback explicitly, so either a regression or the channel coming
back fails the run.

The reason carries **only the action description** — no path, no `.png`, no `%d x %d`, no byte count.
Those facts remain reachable through `approvalScreenshotPath` and the PNG on disk. The card's headline
is the only consent text a browser tool gets, because the shipped panel renders `pending.reason` as
the headline and the correlated call's `command` below it — and a browser tool has no `command`.

## What the model is told when the user says no

A refusal is a **successful** result (`isError: false`), not an error. An error reads as "the call
failed, try again" — and an error result would also discard the card's frame and caption. Worse, the
one thing that actually caused a retry loop in practice was an error.

The refusal text leads with the shipped gating path's own sentence, quoted verbatim in both languages,
and adds the two things that sentence does not say:

```text
browser_act was NOT performed: the user rejected the approval request.
the user rejected tool "browser_act" — a human decision, not a failure of the call, the page, or this plugin.
Nothing ran and the page is unchanged. Do not retry this action or an equivalent one; stop and ask the user what to change, or what to do next.
```

The three non-grant outcomes are worded differently, so the model can tell a human "no" from an absent
channel: `rejected` and `cancelled` are described as the user's decision, while `unavailable` states
explicitly that it **was not** a decision by the user. The same rule is written into the gated tools'
`description`, so it is in the system prompt *before* the model acts, not only in the result
afterwards.

The plugin does **not** police the model's retries: it makes the refusal legible and tells the model
what to do instead. Recording a refused action and silently skipping the prompt on an identical retry
would end the popup loop mechanically, but it can also block a user who has since changed their mind,
and `ToolExecution` carries no turn identity (only `callId`/`rootCallId`/`agent`/`arguments`) with
which to scope such suppression to one model turn. The refusal notice therefore invites the user to
say what to change, and tells the model to wait for that.

## Fail-closed rules

Both gates fail closed, and the fail-closed-ness is verified rather than asserted:

- Anything other than `allowed-once` is a refusal, and **no** side-effecting browser action runs. The
  plugin never proceeds "because a popup was probably shown".
- A **capture failure does not block the ask.** The preview must never decide whether the user is
  asked.
- If `ctx.approval.request` throws (no open turn), the plugin fails closed and reports it.
- A refusal leaves the page byte-for-byte unchanged.
