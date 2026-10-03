# dsh-cua-preview

English | [中文](README.zh.md)

A [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that drives a browser, with
every navigating or acting call gated by a DSH approval — and with the current screen captured as a
screenshot **the user reviews before the action runs**.

The approval architecture follows ZCode's `cua-permission-broker` as a design borrowing; no ZCode source
is copied.

## What it does

| Tool | Approval | Returns |
|---|---|---|
| `browser_navigate` | yes | the loaded page, after navigation |
| `browser_act` (`click` / `fill` / `submit`) | yes | the page after the action |
| `browser_snapshot` | no | the current URL, title and visible text |
| `browser_screenshot` | no | the current screen as an image |

The read-only pair never raises an approval, because neither can change the page. "After navigation"
and "after the action" mean after the page has been given a bounded chance to react — see
[Waiting for the page to react](#waiting-for-the-page-to-react). The gated pair asks
first, in one line of the UI's own language wherever the Host still exposes that preference, and does
nothing at all unless the answer is "allow once".

**That line is always English on DSH `0.2.0-rc.2`**, which removed the Host-side locale read a plugin
could consult; on `0.1.5-rc.2`/`rc.3` it is localised. [docs/design.md](docs/design.md) has the
mechanism, and this repository's real-process check asserts the limitation rather than hiding it.

## Install

Requirements: **Node ≥ 22.12** (this is what `puppeteer-core` requires) and a Chrome or Chromium
executable. Nothing is downloaded at install time — the plugin drives the Chrome you already have, and
reports an actionable error instead of silently fetching one.

Developed and verified against DSH `0.2.0-rc.2` (`@deepseek-ai/dsh-tools` `0.2.0-rc.2`,
`@deepseek-ai/cordis` `4.0.4`), and still supported back to `0.1.5-rc.2`.

A DSH plugin is installed into a **profile** with `dsh plugin`, which forwards its arguments to the
package manager in that profile's directory:

```sh
# By name
dsh plugin --profile demo add dsh-cua-preview

# From a checkout
dsh plugin --profile demo add ./dsh-cua-preview

dsh --profile demo --dump-config   # the layer appears as "# == dsh-cua-preview"
dsh --profile demo                 # boot
```

The package is a DSH **bundle** — it ships a configuration layer, and a profile is what boots it. To
attach it to an existing profile without a reinstall, use an overlay instead, which is also what the
tests do:

```yaml
- insert:
    - id: cua-preview
      name: 'dsh-cua-preview'
      config:
        artifactsDir: '/tmp/cua-artifacts'   # optional
        headless: true                       # optional, default true
        chromePath: '/usr/bin/google-chrome-stable'  # optional, auto-detected
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `artifactsDir` | `$DSH_HOME/cua-preview/artifacts` | where screenshot evidence PNGs are written |
| `headless` | `true` | run Chrome headless |
| `chromePath` | auto-detected | explicit Chrome/Chromium executable |
| `settle` | `{graceMs: 250, idleMs: 400, capMs: 3000}` | how long to wait for the page to finish reacting before the post-action screenshot |

Chrome is looked up through `$DSH_CUA_CHROME_PATH` and the usual Linux install paths
(`/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/usr/bin/chromium`,
`/usr/bin/chromium-browser`, `/snap/bin/chromium`), and is launched with the standard
container-safe flags.

`settle` accepts `false` (no wait at all — the result then reports no `settled` field, because the
plugin will not claim a property it never verified), a number (the total budget in milliseconds), or
an object overriding any of `graceMs` (how long before the page is believed to have started
reacting), `idleMs` (how long each condition must hold) and `capMs` (the total budget). Any other
value is logged and ignored in favour of the defaults, so a misconfigured timer cannot stop the
plugin from loading.

## The browser library choice: Puppeteer

The task allowed Puppeteer or Playwright. Puppeteer was chosen, and specifically `puppeteer-core`:

- `puppeteer-core` **downloads nothing** — no ~150 MB browser fetch at install time, and no version
  guess about which Chromium to pair with which library release.
- It drives the Chrome that is already on the machine, so what the user reviews is the same browser
  they could open themselves.
- The plugin's whole dependency on it is one module, `src/browser.js`; swapping to another library
  would change that file and nothing else.

## The screenshot model, in one paragraph

The approval happens **before** the action, so two frames exist and each is named for what it is. The
**post-action** frame is what the model receives as its result image, because a model that reads a
pre-action frame as "the result" concludes the action failed. The **approval-time** frame — the screen
the user was asked to approve — is returned in the same result, first, captioned `before the action`, so
the call's row reads as a timeline. Both ride in the call's own `tool/result` content, which is what makes
them readable: the Host authorizes an attachment read only when a known event's content carries the
reference, and `presentationMeta.frames` names each one's role. A plugin-owned session event cannot be
used for this at all (it would make the session unopenable — see `docs/design.md`). On a refusal no action
ran, so the one image returned *is* the approval-time frame, captioned `at approval time (no action ran)`.
A screen that is genuinely blank (an unloaded, empty tab) emits no frame at all rather than a useless
white rectangle.

**A frame's box is reserved before its bytes arrive.** Each image is painted at the `aspect-ratio` its own
durable reference records (`ImageAttachmentRef.width`/`height` are required fields), and the loading paint
is the same element with the same geometry as the loaded one. That is not cosmetic. A row that grows again
after the fact makes the conversation's own follow-the-tail logic lose the tail: its growth observer starts
one smooth scroll, the next growth lands while that scroll is still outstanding and is skipped, and the
landing is then short of the taller floor — which the shipped controller reads as the reader having moved,
so it stops following (`dsh-client-ui-chat`, `ScrollFollow`). Two frames that each grew twice would leave
the second one below the fold after an approval; reserving the box leaves exactly one growth to follow, so
the app's own logic lands on the true bottom and the `after the action` frame is fully visible.

**While you are deciding, the screen is already on screen.** The call's row paints the current screen from
the moment the approval appears, and it is a *live* read: at that point nothing has been logged, so the
frame comes from the Host's own copy of it — the bytes captured an instant before the question was asked,
served on the exact Fetch route the Connection documents for a browser-native response. The route stops
answering as soon as the call settles, because the result then carries the same picture as
`before the action`. [docs/design.md](docs/design.md) has both routes, the reason a plugin may not append
a session event of its own, and why the shipped single-occupancy slot inside the approval card is left
alone.

## Waiting for the page to react

A frame is only the action's result if the page has finished reacting to it. `page.click()` returns
the moment the input is dispatched, and `goto` with `domcontentloaded` returns before a JS-rendered
page has rendered anything, so a capture taken the instant the action returns is the state the action
*started* from. Measured on a page whose own reaction takes 900 ms, that frame was written 64 ms after
the action and still read `PENDING` — useless to the person deciding whether it worked.

Every gated action therefore waits before its screenshot: a **grace** period (250 ms) during which the
page is not believed to have started reacting, then for the **network to go quiet** (400 ms with no
request still awaiting a response), then for the **DOM to stop changing** (400 ms with an identical
fingerprint — URL, title, element count and a hash of the body text), all bounded by a **budget**
(3 s). A page that never goes quiet costs the budget once.

The wait is a heuristic with a budget, so it cannot promise a frame is final. What it can promise is
that it never *claims* more than it verified: when the budget runs out the result carries
`settled: false`, `networkBusy` names which condition never held, and the model-facing text says the
frame may be mid-update.

## What the model is told when the user says no

A refusal is a **successful** tool result, not an error — an error reads as "the call failed, try
again", and an error is exactly what once caused a model to retry an action the user had just rejected.
The notice leads with the shipped gating path's own sentence, quoted verbatim in both languages, and
adds what that sentence does not say: that this is a human decision rather than a failure, and that the
expected next move is to stop and ask.

```text
browser_act 未执行：用户在审批中拒绝了这次操作。
the user rejected tool "browser_act" —— 这是人的决定，不是调用失败、页面问题，也不是本插件故障。
操作没有执行，页面保持原样。不要重试这个动作或等价动作；请停下来询问用户要改什么、或者下一步做什么。
```

The three non-granting outcomes are worded differently, so the model can tell a human "no" from an
absent channel: `rejected` and `cancelled` are described as the user's decision, while `unavailable`
states explicitly that it was **not**. The same rule is in the gated tools' descriptions, so it reaches
the model before it acts rather than only afterwards.

Repeat prompting is **not** suppressed: the plugin does not police the model's retries, and a user who
changes their mind can still approve a later attempt. Suppressing an identical repeat would end the
popup loop mechanically, but it can also block a user who has since said "go ahead", and a tool
execution carries no turn identity with which to scope the suppression to one model turn.

## Tests

From a source checkout (the test entries are development-only and are not part of the published
package, so they are absent after `npm install dsh-cua-preview`):

```sh
npm install
npm test
```

Three entries, aimed at three different layers:

| Entry | Layer | Needs | Checks |
|---|---|---|---|
| `npm run test:client` | the Client half, in isolation | Node only | 79 |
| `npm run test:acceptance` | the Host half, against the real DSH services | Chrome | 107 |
| `npm run test:real-load` | both halves, inside a real `dsh` process | a `dsh` CLI + Chrome | 18 |

That is **204 checks, 0 failures** — all three entries need `npm install` first. The last entry boots the
shipped `dsh` binary with the plugin patched in on an OS-assigned free port — so it cannot collide with
any profile you have running — and runs a probe plugin inside that process which reads the live
registries. It reports clearly and exits non-zero if no `dsh` CLI is available. It pins the approval
policy to `ask` for that boot, so a profile whose default preset is `danger-full-access` cannot turn the
run into a verdict about the preset instead of about the plugin.

CI runs the Client-bundle verifier and the packaging check on every push, because both are reproducible
without a browser. The browser suites are not part of that gate — they need a Chrome executable and,
for the last entry, a `dsh` CLI — so they are exposed as a manually triggered job instead.

### Local test page

`examples/test-page/` is a small page with a field, a button and a form, used by the acceptance checks
and handy for trying the plugin by hand:

```sh
node examples/test-page/serve.mjs --port 3097 --host 127.0.0.1
```

[`slow.html`](examples/test-page/slow.html) in the same directory is the fixture behind the settle
checks: its banner changes colour 900 ms after the document loads and 900 ms after its button is
clicked, so a frame taken the moment an action returns is visibly the *previous* state. Open it in the
same server (`http://127.0.0.1:3097/slow.html`) to watch the difference by hand.

## Documentation

| Document | Contents |
|---|---|
| [docs/design.md](docs/design.md) | how it works and why: the two frames, the image channels, why no plugin-owned session event may carry one, the slots this plugin refuses to touch, the locale and refusal rules |
| [CHANGELOG.md](CHANGELOG.md) | what changed |

## License

[MIT](LICENSE). This is an **unofficial community work**, not affiliated with, authorized, sponsored or
endorsed by Z.AI Co., Ltd or DeepSeek. "ZCode" and "DeepSeek Harness" are the trademarks of their
respective owners and are used here only to describe where a design came from and what this plugin
runs on.
