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
| Approval-time (pre-action) | `approval-*.png` | the user's card, and `approvalScreenshotPath` for audit |
| Result (post-action) | `after-*.png` | the model-facing `output.render` image block |

The tool descriptions state this, so the rule is in the system prompt rather than being tribal
knowledge. On a **refusal** there is no post-action state to show, so the single returned frame *is*
the approval-time frame, captioned `at approval time (no action ran)`.

## Where an image can travel, and where it cannot

`ApprovalRequest` carries `agent`, `toolName`, `callId`, `reason` and `signal` — **there is no image
field**, and none is invented. The documented channels that do carry an image are:

| Channel | Mechanism | Used for |
|---|---|---|
| Model-facing result | `output.render` → an `{ type: 'image', attachment }` block | the post-action frame |
| Result-time card data | `output.presentationMeta(args, value)` → persisted on `tool/result` as `result.meta` | audit pointer (`granted`, `decision`, `approvedFrame`, `approvedPath`) |
| A plugin-owned session event | `session.append('cua/preview', …)` | the approval-time frame, so the Client can read it |

### `result.meta` describes an image but does not make it readable

The Host proves reachability **before** serving attachment bytes: `dsh-api-session-controller`'s
`attachment()` looks the reference up through `referencedImage` → `imageInEvent`, which scans exactly
`data.content`, `data.message.content`, `data.inserted[].content` and assistant-stream chunks. A
reference carried only in `result.meta` is in none of those positions, so a card told about the
credential by `meta` alone renders its caption and then *"screenshot could not be loaded"*.

The fix uses the mechanism DSH provides for this: a **log-only** plugin event (a declaration-merged
`SessionEventMap` type that is not a `SurfaceEventType`, and therefore contributes nothing to derived
history). Its payload puts the reference where the authorizer scans:

```js
session.append('cua/preview', {
  content: [{ type: 'image', attachment: ref }],
  callId, action, toolName,          // the client joins on callId
})
```

Two properties come out of this at once: the Client can read the frame, and the model still never
sees it.

### `result.meta` is also not what the row paints

The tool row paints the **audit pointer never**, and reads `content` and `meta` only once the call has
settled (`"kind" in block`), because neither exists while it runs and DSH exposes no tool-progress
API. So a credential painted by the row alone could only ever appear *after* the user had already
answered — the opposite of the point. That is why the credential is read out of the plugin's own
event instead (below), and the row is left showing exactly its own result.

## Getting the credential on screen while the approval is pending

The shipped approval panel declares `conversation.approval.detail` and renders it inside the card
above the decision buttons — an ideal place for the credential. It is **not available to a plugin**:
it is a `single` slot, and `@deepseek-ai/dsh-client-ui-chat` already registers `ApprovalCommand` into
it at priority 0. `SlotCore.register` throws when a second entry claims the same priority, and the
throw lands in whichever plugin registers second — which was the shipped `ui-chat`, failing the whole
client plugin set:

```text
Failed to load plugins
@deepseek-ai/dsh-client-ui-chat
single slot "conversation.approval.detail" already has a registration at priority 0
(registered by Ba) — register at a different priority to shadow it (lowest renders)
```

Registering at a lower priority would *shadow* the shipped occupant, deleting the pending call's
command preview from the approval card for every tool — a global regression traded for a plugin-local
feature. So the region is left alone, and the plugin's own Conversation node is the channel.

### The carrier node

`src/client/browser.js` registers a Definition for the `cua/preview` event that publishes a
`{ kind: 'cua-preview', target: 'chat' }` node anchored on the event's `seq`. Two platform facts make
this work, both read out of shipped code:

| Question | Answer |
|---|---|
| Is a hidden node still materialized? | Yes — `ChatSnapshot.nodes` is a `ChatNodeStore` documented as "current Node, **when visible or hidden**", filled from every upsert; only `orderedVisibleChatNodes` filters on `visibility === 'visible'` |
| Does a `tool.call.toolview` row get a snapshot hook? | Yes — `useChat` is a session-standard hook provided by `dsh-client-ui-chat`, and `dsh-client-ui-tool` declares the child slot `scope: 'session'`; a session slot rendered without its sources **throws** rather than silently losing the hook |

**The node is published `visibility: 'hidden'`** because of the chat's row ordering: rows sort by
`anchorSeq` (`orderedVisibleChatNodes`), a tool row anchors on its `tool/call` event, and the Host
appends `tool/call` *before* it asks for approval — so the plugin's `cua/preview` event always has the
larger seq and any **visible** node built from it sorts *below* the row the user is looking at. A
visible carrier therefore showed `after the action` above `before the action`. Fabricating a smaller
`anchorSeq` is not an option: the field is required to come from durable ordering evidence.

So the carrier stays in Client state but out of the visible flow, and the one row that owns the call
paints both frames in the order they happened: `before the action` / image, then `after the action` /
image. Ordering *inside* a row is the plugin's to guarantee; ordering *between* rows is not.

### The one trap

`useChat` is `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel)` — no custom
comparator, so selections are compared with `Object.is`. The row therefore returns
`node.data.attachment`, the object held in the Definition's State; building a fresh object inside the
selector would re-render forever. The verifier asserts this stability directly, because a reader of
the code cannot see the comparator.

Because the carrier is hidden, the plugin registers **no `conversation.chat.node` renderer at all** —
a hidden kind never reaches that seat, so such a renderer would be dead code.

## What the plugin claims, and what it deliberately leaves alone

The Client half's entire footprint is:

- one registered Definition (the hidden carrier),
- three keyed `tool.call.toolview` seats — for `browser_act`, `browser_navigate` and
  `browser_screenshot`, the three tools that carry an image. `browser_snapshot` returns text only, so
  it needs no row.

It registers into **no `single` slot**, in particular not
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
