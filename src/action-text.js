/**
 * The one-line sentence the user reads in the approval prompt.
 *
 * `ctx.approval.request()` accepts exactly one free-text field — `reason`, "a human-readable
 * explanation" of the ask (`docs/subsystems/approval.md`) — and the shipped approval panel renders
 * it as the card's headline and nothing else when the asked tool has no `command` argument to
 * preview. So this string is the whole consent text for a browser action, and it is written for a
 * reader, not for a log:
 *
 * - The target is named the way the PAGE names it (its label / aria-label / placeholder / visible
 *   text, resolved by `BrowserController.describe`), not the way the DOM stores it.
 * - The CSS selector stays in parentheses. It is not decoration: the approval is consent for one
 *   exact element, and the selector is the identity the tool actually acts on.
 * - A `fill` states the text about to be written, because "type into #name-input" does not tell the
 *   user what they are approving. It is truncated, and whitespace is collapsed so the sentence
 *   stays one line.
 *
 * Language: the sentence follows the DSH *user-settings* locale (`locale.preference`, the value the
 * web GUI's Settings → General → Language writes), read from the Host through the documented
 * settings service. The field's absence — no explicit selection yet, so the browser derives the
 * language, or no settings provider is mounted — resolves to English, which is the conservative
 * choice: it is the shipped default and the language every other string this plugin writes uses.
 * Only `zh*` selects Chinese; any other explicit locale (`en`, `ja`, …) gets English, because
 * inventing wording for languages this plugin cannot verify would be worse than a known language.
 */

/** Namespace and field owned by `@deepseek-ai/dsh-client-locale`'s Host half. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** The languages this module can write. */
export const APPROVAL_LANGUAGES = ['en', 'zh']

/** Longest visible-text excerpt kept for a target's label. */
export const LABEL_LIMIT = 60

/** Longest excerpt of a `fill` value quoted back in the prompt. */
export const VALUE_LIMIT = 40

/**
 * Collapse whitespace so the result is one line, then cut to `limit` characters.
 *
 * @param {unknown} text - candidate text.
 * @param {number} limit - maximum characters to keep.
 * @returns {string} the normalized excerpt, with an ellipsis when it was cut.
 */
export function excerpt(text, limit) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/**
 * Resolve the language of the approval sentence from the user-settings locale.
 *
 * `ctx.settings.get(ns)` is the documented read for a registered namespace and returns `undefined`
 * while `locale` is unregistered (`@deepseek-ai/dsh-settings` README, "Reading and observing
 * values"); an absent settings service, an absent namespace, an absent field and a throwing
 * provider all mean the same thing here — no explicit user choice — and all fall back to English.
 *
 * @param {object} [settings] - the settings service (`ctx.get('settings')`), when mounted.
 * @returns {'en'|'zh'} the language for the approval sentence.
 */
export function approvalLanguage(settings) {
  let preference
  try {
    preference = settings?.get?.(LOCALE_SETTINGS_NAMESPACE)?.[LOCALE_PREFERENCE_FIELD]
  } catch {
    // A provider that fails to read is not a reason to fail the approval, or to guess a language.
    return 'en'
  }
  if (typeof preference !== 'string') return 'en'
  return preference.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** Nouns for the element, per language. */
const ROLE_NOUNS = {
  en: { button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio button', select: 'dropdown', field: 'field', form: 'form' },
  zh: { button: '按钮', link: '链接', checkbox: '复选框', radio: '单选框', select: '下拉框', field: '输入框', form: '表单' },
}

/**
 * Classify an element into the noun a person would use for it.
 *
 * @param {object} target - `BrowserController.describe` facts.
 * @returns {string} one of the {@link ROLE_NOUNS} keys, or the raw tag when nothing fits.
 */
function roleOf(target) {
  const tag = typeof target?.tag === 'string' ? target.tag : ''
  const type = (typeof target?.type === 'string' ? target.type : '').toLowerCase()
  if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset'].includes(type))) return 'button'
  if (tag === 'a') return 'link'
  if (tag === 'input' && type === 'checkbox') return 'checkbox'
  if (tag === 'input' && type === 'radio') return 'radio'
  if (tag === 'select') return 'select'
  if (tag === 'input' || tag === 'textarea') return 'field'
  if (tag === 'form') return 'form'
  return tag
}

/** The DOM-shaped fallback used when the page gives the element no name at all. */
function domName(target) {
  const tag = typeof target?.tag === 'string' && target.tag !== '' ? target.tag : 'element'
  const type = typeof target?.type === 'string' && target.type !== '' ? ` type="${target.type}"` : ''
  return `<${tag}${type}>`
}

/**
 * Name the element in English, or fall back to its DOM shape.
 *
 * @param {object} target - element facts, or null when nothing matched the selector.
 * @param {string} selector - the selector the tool will act on.
 * @returns {string} a noun phrase such as `the field "在这里输入一个名字" (#name-input)`.
 */
function targetEn(target, selector) {
  if (target === null || target === undefined) return `${selector} (no element currently matches)`
  const label = excerpt(target.label, LABEL_LIMIT)
  if (label === '') return `${selector} (a ${domName(target)})`
  const role = roleOf(target)
  const noun = ROLE_NOUNS.en[role] ?? `\`${role}\` element`
  return `the ${noun} "${label}" (${selector})`
}

/**
 * Name the element in Chinese, or fall back to its DOM shape.
 *
 * @param {object} target - element facts, or null when nothing matched the selector.
 * @param {string} selector - the selector the tool will act on.
 * @returns {string} a noun phrase such as `输入框「在这里输入一个名字」（#name-input）`.
 */
function targetZh(target, selector) {
  if (target === null || target === undefined) return `${selector}（当前没有元素匹配）`
  const label = excerpt(target.label, LABEL_LIMIT)
  if (label === '') return `${selector}（一个 ${domName(target)}）`
  const role = roleOf(target)
  const noun = ROLE_NOUNS.zh[role] ?? `${role} 元素`
  return `${noun}「${label}」（${selector}）`
}

/** Name the enclosing form, or fall back to the field the caller named. */
function formName(target, selector, language) {
  const id = typeof target?.form?.id === 'string' && target.form.id !== '' ? `#${target.form.id}` : null
  const name = typeof target?.form?.name === 'string' && target.form.name !== '' ? target.form.name : null
  const form = id ?? name
  if (form === null) {
    return language === 'zh'
      ? `提交包含 ${selector} 的表单`
      : `Submit the form containing ${selector}`
  }
  return language === 'zh'
    ? `提交表单 ${form}（其中包含 ${selector}）`
    : `Submit the form ${form} (containing ${selector})`
}

/**
 * Build the approval sentence for one gated action.
 *
 * @param {object} input
 * @param {string} input.action - `navigate` | `click` | `fill` | `submit`.
 * @param {string} input.selector - the selector the action targets.
 * @param {string} [input.value] - text a `fill` will write.
 * @param {string} [input.url] - destination of a `navigate`.
 * @param {object|null} [input.target] - element facts from `describe()`, when it was read.
 * @param {'en'|'zh'} [input.language] - sentence language; defaults to English.
 * @returns {string} the one-line `reason` handed to `ctx.approval.request()`.
 */
export function describeAction({ action, selector, value, url, target = null, language = 'en' }) {
  const zh = language === 'zh'
  switch (action) {
    case 'navigate':
      return zh ? `在浏览器中打开 ${url}` : `Open ${url} in the browser`
    case 'click':
      return zh
        ? `点击${targetZh(target, selector)}`
        : `Click ${targetEn(target, selector)}`
    case 'fill': {
      const text = excerpt(value, VALUE_LIMIT)
      return zh
        ? `在${targetZh(target, selector)}中输入 "${text}"`
        : `Type "${text}" into ${targetEn(target, selector)}`
    }
    case 'submit':
      return formName(target, selector, zh ? 'zh' : 'en')
    default:
      return `${action} ${selector}`
  }
}

/**
 * The refusal notice: what the model is told when the user did NOT grant the action.
 *
 * Why this exists at all: without it the model is left to interpret an unexplained non-execution,
 * and the observable failure mode is a retry loop — the user declines, the model calls the same
 * action again, the user is asked again. The wording therefore does three jobs, in this order:
 *
 * 1. **Name the outcome as a human decision.** `the user rejected tool "X"` is the sentence the
 *    shipped gating path produces for its own tools (`dsh-tools`' `serviceAsk`), so it is quoted
 *    verbatim here, in both languages, as the canonical and machine-checkable line.
 * 2. **Separate "not allowed" from "did not work".** A refusal is not a schema error, not a page
 *    problem and not a plugin fault — the distinction that was missing when an output-validation
 *    bug made a refusal arrive as `missing required property "value.approvalImage"`, which read as
 *    transient and invited exactly the retry the user was trying to stop.
 * 3. **State the expected next move.** Do not retry this action or an equivalent one; stop and ask
 *    the user. The user's own words are the only thing that can unblock the work, so the notice also
 *    tells the model to wait for them — that is the whole of the "tell the model why" mechanism
 *    (the approval seam is a closed four-value outcome with no payload for the answerer, so a reason
 *    box on the card cannot exist without changing DSH itself).
 *
 * `cancelled` and `unavailable` get their own sentences because they are different facts — the
 * shipped path distinguishes them too — and because "the user said no" is simply false for
 * `unavailable` (no approval channel was mounted). Language follows the same rule as the approval
 * sentence: only `zh*` selects Chinese, everything else is English.
 *
 * **`rejected` has two sources, and only one of them involves a human.** Under the `ask` policy it
 * means an answerer said no. Under the `never` policy `ApprovalService.decide()` returns `rejected`
 * *before* the `approval/request` waterfall, so no answerer ever sees the request and the user is
 * never asked (`docs/subsystems/approval.md`: "`never` deterministically returns `rejected` without
 * dispatching any answerer"). Telling the model "the user rejected it" in that case is a false
 * attribution, and a costly one: the model is told to stop and ask a user who has already answered
 * — by turning prompts off. The distinction comes from `ctx.approval.effectivePolicy(session)`, the
 * documented read (same doc line: "Consumers read it with `ctx.approval.effectivePolicy(session)`"),
 * and it is passed in as `promptsDisabled`. When it is absent — an older or unknown Host — the
 * wording stays the interactive one, because that is the only case the plugin can prove.
 */

/** The non-granting outcomes, each with distinct wording. */
const REFUSAL_LINES = {
  rejected: {
    en: (toolName) => [
      `${toolName} was NOT performed: the user rejected the approval request.`,
      `the user rejected tool "${toolName}" — a human decision, not a failure of the call, the page, or this plugin.`,
      'Nothing ran and the page is unchanged. Do not retry this action or an equivalent one; stop and ask the user what to change, or what to do next.',
    ],
    zh: (toolName) => [
      `${toolName} 未执行：用户在审批中拒绝了这次操作。`,
      `the user rejected tool "${toolName}" —— 这是人的决定，不是调用失败、页面问题，也不是本插件故障。`,
      '操作没有执行，页面保持原样。不要重试这个动作或等价动作；请停下来询问用户要改什么、或者下一步做什么。',
    ],
  },
  cancelled: {
    en: (toolName) => [
      `${toolName} was NOT performed: the approval request was cancelled before the user answered.`,
      `approval for tool "${toolName}" was cancelled — a human decision, not a failure of the call, the page, or this plugin.`,
      'Nothing ran and the page is unchanged. Do not retry this action or an equivalent one; stop and ask the user how to proceed.',
    ],
    zh: (toolName) => [
      `${toolName} 未执行：用户在作答前取消了这次审批。`,
      `approval for tool "${toolName}" was cancelled —— 这是人的决定，不是调用失败、页面问题，也不是本插件故障。`,
      '操作没有执行，页面保持原样。不要重试这个动作或等价动作；请停下来询问用户如何进行。',
    ],
  },
  unavailable: {
    en: (toolName) => [
      `${toolName} was NOT performed: no approval channel is available, so this action could not be authorised.`,
      `tool "${toolName}" requires approval, but no approval channel is available.`,
      'Nothing ran and the page is unchanged. This was not a decision by the user: the approval channel is missing. Do not retry this action or an equivalent one; tell the user and ask how to proceed.',
    ],
    zh: (toolName) => [
      `${toolName} 未执行：没有可用的审批通道，这次操作无法被授权。`,
      `tool "${toolName}" requires approval, but no approval channel is available.`,
      '操作没有执行，页面保持原样。这不是用户的决定：审批通道缺失。不要重试这个动作或等价动作；请告诉用户并询问如何进行。',
    ],
  },
}

/**
 * Why no decision was taken, per outcome, when the session policy is `never`.
 *
 * Only `rejected` is reachable through the policy itself; `cancelled` is what an already-aborted
 * call gets (the service checks the signal before the policy), and `unavailable` remains possible
 * from a missing channel. All three are stated without attributing anything to a human.
 */
const PROMPTS_OFF_CAUSE = {
  en: {
    rejected: 'this session\'s approval policy is "never", so DSH rejected it automatically, before any answerer could be asked',
    cancelled: 'the call was aborted before any approval decision could be taken',
    unavailable: 'no approval channel is available',
  },
  zh: {
    rejected: '本次会话的审批策略是 "never"，DSH 在任何应答者被询问之前就自动拒绝了它',
    cancelled: '这次调用在任何审批决定作出之前就被中止了',
    unavailable: '没有可用的审批通道',
  },
}

/**
 * The notice for a refusal produced by the `never` policy rather than by a person.
 *
 * The shipped sentence for this situation is not "the user rejected tool X" — it is the deterministic
 * policy sentence DSH itself puts in the model's runtime context, quoted verbatim here so the model
 * can connect the two. The next step is different from an interactive refusal as well: there is no
 * decision to wait for, so the unblocking action is named — `/permission`, and a preset whose
 * approval policy is `ask`.
 */
const PROMPTS_OFF_LINES = {
  en: (toolName, decision) => [
    `${toolName} was NOT performed: ${PROMPTS_OFF_CAUSE.en[decision] ?? PROMPTS_OFF_CAUSE.en.unavailable}.`,
    `the user did NOT reject tool "${toolName}" — under the "never" policy no approval prompt exists and no answerer is asked, so no human took this decision. Nothing ran and the page is unchanged.`,
    'DSH states the session\'s policy to the model as: "Approval prompts are disabled in this session: actions that require approval are rejected automatically."',
    'Do not retry this action or an equivalent one. Tell the user what was refused, and ask them to run /permission and switch to a preset whose approval policy is "ask" — a preset can keep full file access and still ask (the shipped "danger-full-access" preset pairs full file access with no prompts, which is what disables this).',
  ],
  zh: (toolName, decision) => [
    `${toolName} 未执行：${PROMPTS_OFF_CAUSE.zh[decision] ?? PROMPTS_OFF_CAUSE.zh.unavailable}。`,
    `这不是用户拒绝了 tool "${toolName}"——在 "never" 策略下不存在审批弹窗、也不会询问任何应答者，因此没有任何人做过这个决定。操作没有执行，页面保持原样。`,
    'DSH 把本次会话的策略这样告诉模型："Approval prompts are disabled in this session: actions that require approval are rejected automatically."',
    '不要重试这个动作或等价动作。请告诉用户被拒绝的是什么，并请他们用 /permission 切换到一个审批策略为 "ask" 的预设——预设可以既保留完整文件权限、又保留询问（官方 "danger-full-access" 预设把完整文件权限和"不询问"绑在了一起，正是它关掉了询问）。',
  ],
}

/**
 * The notice prepended to a non-granted tool result.
 *
 * @param {object} input - the refusal.
 * @param {string} input.toolName - the tool that was not allowed to act.
 * @param {string} input.decision - the `ApprovalOutcome` that came back.
 * @param {'en'|'zh'} [input.language] - notice language; defaults to English.
 * @param {boolean} [input.promptsDisabled] - whether the session's policy was `never`, i.e. nobody
 *   was asked. Defaults to false, which keeps the interactive wording.
 * @returns {string} the notice, as the lines the model reads (newline separated).
 */
export function refusalNotice({ toolName, decision, language = 'en', promptsDisabled = false }) {
  const lang = language === 'zh' ? 'zh' : 'en'
  if (promptsDisabled === true) return PROMPTS_OFF_LINES[lang](toolName, decision).join('\n')
  const entry = REFUSAL_LINES[decision] ?? REFUSAL_LINES.unavailable
  return entry[lang](toolName).join('\n')
}
