/**
 * Real-product load check for dsh-cua-preview.
 *
 * The in-process harness (`run-acceptance.mjs`) proves the plugin loads through the real DSH
 * Loader and registers its tools. This script proves the same thing against the **shipped `dsh`
 * binary**: it boots the real `web` profile with the plugin patched in, plus a small probe plugin
 * that reads the live `ctx.tools` registry from inside that process and reports a verdict.
 *
 * A temporary profile port is used and the process is stopped afterwards, so the user's running
 * Web UI is never touched.
 *
 * Two things are pinned on purpose so the verdict describes the **plugin** rather than whichever
 * preset this machine happens to run: the approval policy is forced to `ask` (a `danger-full-access`
 * default preset is `approval: never`, under which `ApprovalService.decide()` rejects before the
 * probe's answerer is ever consulted), and the approval sentence's expected language comes from the
 * locale the profile's own `cordis.patch.yml` declares rather than from the Host channel the plugin
 * itself reads.
 *
 * Usage:  node examples/run-real-dsh-load.mjs
 * Exit code 0 = the real product loaded the plugin and listed all four tools.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const EXPECTED = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_act']
const PROFILE = 'web'

/**
 * Read the locale the profile itself declares.
 *
 * This is the one locale fact the plugin cannot move: it is a line in the operator's
 * `cordis.patch.yml`, not a value read back out of the live Host, so it stays put when the Host
 * stops exposing that locale to plugins. The probe's own derived comparison reads the same channel
 * the plugin reads and therefore went green through exactly that failure; the harness compares
 * against this instead.
 *
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns the declared preference id, or null when the profile does not declare one (a fresh CI
 *   profile has no patch file at all).
 */
async function declaredLocaleOf(patchPath) {
  let text
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    return null
  }
  let inLocaleRow = false
  for (const line of text.split('\n')) {
    const row = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (row !== null) {
      inLocaleRow = row[1] === 'locale'
      continue
    }
    if (!inLocaleRow) continue
    const preference = /^\s*preference:\s*(\S+)\s*$/.exec(line)
    if (preference !== null) return preference[1].replace(/^["']|["']$/g, '')
  }
  return null
}

/**
 * Ask the OS for a free port.
 *
 * A hard-coded port is a real hazard here: this check boots a second `dsh` beside whatever the
 * user already has running, and a collision makes the whole profile fail to boot — which would
 * look like the plugin failed to load when the cause was an occupied port. Binding :0 and reading
 * the assignment avoids it. (There is an unavoidable race between closing this probe socket and
 * `dsh` binding, but it is far narrower than a fixed number.)
 *
 * @returns {Promise<number>} a port that was free a moment ago.
 */
async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolvePort(port))
    })
  })
}

const PROBE_PORT = await findFreePort()

const workDir = await mkdtemp(join(tmpdir(), 'dsh-cua-real-'))
const verdictPath = join(workDir, 'verdict.json')
const overlayPath = join(workDir, 'cordis.patch.yml')
const logPath = join(workDir, 'boot.log')

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const declaredLocale = await declaredLocaleOf(join(dshHome, 'profiles', PROFILE, 'cordis.patch.yml'))

const probeConfig = [
  `        resultPath: '${verdictPath}'`,
  '        timeoutMs: 45000',
  '        exitAfter: true',
]
if (declaredLocale !== null) probeConfig.push(`        declaredLocale: '${declaredLocale}'`)

// The two patched rows above `insert` override the operator's permission settings for this
// verification boot only, and they are load-bearing rather than cosmetic: the shipped `approval` row
// derives its policy from `DSH_PERMISSION_MODE`, and a `web` profile that switches the default preset
// to `danger-full-access` gets `approval: never`. Under `never`, `ApprovalService.decide()` returns
// "rejected" *before* the `approval/request` waterfall, so the probe's own answerer is never called
// and the gated action can never be approved. Pinning the policy to `ask` keeps this check about the
// plugin rather than about whichever preset the operator happens to run.
const overlay = `# Temporary overlay: the plugin under test plus a probe that reports the live tool registry.
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: ask
    defaultPreset: workspace-write
- insert:
    - id: cua-preview
      name: '${join(root, 'src/index.js')}'
      config:
        artifactsDir: '${join(workDir, 'artifacts')}'
        headless: true
    - id: cua-preview-load-probe
      name: '${join(root, 'examples/load-probe.plugin.mjs')}'
      config:
${probeConfig.join('\n')}
`
await writeFile(overlayPath, overlay)

console.log('booting the real dsh web profile with the plugin patched in...')
console.log(`  overlay:        ${overlayPath}`)
console.log(`  port:           ${PROBE_PORT} (OS-assigned; the user's GUI is untouched)`)
console.log(`  declared locale: ${declaredLocale ?? '(none declared in this profile)'}\n`)

const child = spawn(
  'dsh',
  ['--profile', PROFILE, '--patch', overlayPath, '--port', String(PROBE_PORT), '--no-open'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)

let output = ''
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

const exitCode = await new Promise((resolveExit) => {
  const timer = setTimeout(() => {
    child.kill('SIGTERM')
    resolveExit('timeout')
  }, 90_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolveExit(code)
  })
})

await writeFile(logPath, output)

// Always make sure the temporary server is gone before reporting.
child.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 500))

let verdict = null
try {
  verdict = JSON.parse(await readFile(verdictPath, 'utf8'))
} catch (error) {
  console.error(`FAIL  the probe wrote no verdict: ${String(error)}`)
  console.error(`\n--- boot log ---\n${output}`)
  process.exit(1)
}

const checks = [
  ['the real dsh process exited 0', exitCode === 0, `exit=${exitCode}`],
  ['the probe reported ok', verdict.ok === true, JSON.stringify(verdict.toolsRegistered)],
  ['all four browser tools are registered in the real product',
    EXPECTED.every((t) => verdict.toolsRegistered.includes(t)),
    verdict.toolsRegistered.join(', ')],
  ['the approval service is mounted in the real web profile',
    verdict.approvalServicePresent === true, String(verdict.approvalServicePresent)],
  ['the attachment service is mounted in the real web profile',
    verdict.attachmentsServicePresent === true, String(verdict.attachmentsServicePresent)],
  // The frames below are read off the real Session log the product wrote. The enforcement point
  // (`sessionController.attachment`, reached by the browser's image loader) lives in the API
  // gateway's isolation scope and cannot be called from a root-level patch row — so this asserts the
  // shape that authorization needs: both frames referenced from a content array of a committed
  // event, and the log holding no event type this harness does not know.
  ['a real gated click was approved and ran',
    verdict.actionGranted === true, `decision=${String(verdict.approvalDecision)}`],
  ['a real blank first navigation carries no credential frame',
    verdict.blankNavigationOmittedFrame === true, 'no approvalImage / approvalScreenshotPath'],
  ['the approval reason is a single line and carries no path',
    typeof verdict.approvalReason === 'string' &&
      !verdict.approvalReason.includes('\n') && !verdict.approvalReason.includes('.png'),
    JSON.stringify(verdict.approvalReason)],
  ['the granted result carries both frames, the approved one first',
    verdict.frameCount === 2 && verdict.framesAreDistinct === true,
    `frames=${verdict.frameCount} distinct=${verdict.framesAreDistinct}`],
  // The frames have to be image blocks, because that is the block the agent loop persists and the
  // block `imageInEvent` scans for. `ctx.tools.execute` validates and materializes the result but
  // does not log `tool/result` itself, so the persisted-log half of this property is pinned by the
  // in-process acceptance harness; this half is pinned here against the shipped pipeline.
  ['both frames are image blocks carrying real durable references',
    verdict.framesAreImageBlocks === true, 'type:"image" with ImageAttachmentRef attachments'],
  // The defect this replaced: a plugin-owned `cua/preview` event made every session that ran a gated
  // action unreadable ("unknown to this harness and not marked ignorable"). Both halves are checked
  // in the real product, because a green plugin-side test could not see the log at all.
  ['the plugin writes no event type outside the harness vocabulary',
    Array.isArray(verdict.unknownEventTypes) && verdict.unknownEventTypes.length === 0,
    `unknown=${JSON.stringify(verdict.unknownEventTypes)}`],
  ['the plugin appends nothing of its own to the Session log',
    verdict.pluginAppendedNoEvent === true,
    `events=${JSON.stringify(verdict.sessionEventTypes)}`],
  ['an unreferenced attachment is not referenced (the control)',
    verdict.unreferencedRefused === true, 'bogus id absent from the log'],
  // The refusal path, in the real product and through the real pipeline. A direct `execute()` call
  // returns the raw value and never runs the output-schema validation that a rejection used to die
  // in (`missing required property "value.approvalImage"`), so this one dispatches the way the agent
  // loop does and asserts the text the model would actually receive.
  ['the compiled output schema makes both image fields optional',
    verdict.imageFieldsAreOptional === true, 'image / approvalImage absent from `required`'],
  ['a refused action dispatched through the real pipeline is not an error',
    verdict.refusalIsNotAnError === true, 'isError must be false: an error is what invited the retry'],
  ['the refusal reaches the model in the shipped product\'s words',
    verdict.refusalCarriesTheShippedSentence === true, JSON.stringify(verdict.refusalText)],
  ['the refusal tells the model to stop retrying and ask the user',
    verdict.refusalDirectsTheModelToStop === true, JSON.stringify(verdict.refusalText)],
  ['the refusal still carries the approval-time frame to the model',
    verdict.refusalCarriesTheApprovalFrame === true, 'an image block survives the refusal'],
]

// --- the approval sentence's language, asserted against something the plugin cannot move ---------
//
// `verdict.approvalReasonMatchesExpectedWording` is deliberately NOT used below: it compares two
// readings of the same Host channel, so when DSH 0.2.0-rc.2 removed that channel the plugin and the
// probe fell to English together and the comparison stayed true. The expectation here is
// `declaredLocale`, parsed out of the profile's own `cordis.patch.yml` — a fact the plugin never sees.

const channelReadable = verdict.localeChannelReadable === true
const reasonLanguage = verdict.approvalReasonLanguage === 'zh' ? 'zh' : 'en'
const declaredLanguage = verdict.declaredLocaleLanguage ?? null

checks.push(
  ['the approval sentence is one of the two known exact wordings, not a half-localised string',
    verdict.approvalReasonWordingIsExact === true, JSON.stringify(verdict.approvalReason)],
  ['the sentence\'s language is the language the Host actually exposes',
    verdict.approvalReasonLanguageMatchesTheHostChannel === true,
    `localePreference=${JSON.stringify(verdict.localePreference)} sentence=${reasonLanguage}`],
)

if (declaredLanguage === null) {
  checks.push(
    ['no profile locale is declared here, so the live channel is the only constraint on the sentence',
      reasonLanguage === (channelReadable ? reasonLanguage : 'en'),
      `channelReadable=${channelReadable} — a fresh CI profile has no cordis.patch.yml`],
  )
} else if (channelReadable) {
  checks.push(
    [`the profile declares ${verdict.declaredLocale}, the Host exposes it, so the sentence is ${declaredLanguage}`,
      reasonLanguage === declaredLanguage, `sentence=${reasonLanguage}`],
  )
} else {
  checks.push(
    [`the profile declares ${verdict.declaredLocale} but this DSH no longer exposes a Host locale `
      + 'channel, so the sentence is English by design and not half-localised',
      reasonLanguage === 'en' && verdict.approvalReasonLanguageMatchesDeclaredLocale === false,
      `sentence=${reasonLanguage} — if this FAILS because the channel came back, restore the `
      + 'localised expectation and drop this known limitation from the docs'],
  )
}

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

console.log(`\nprobe verdict: ${verdictPath}`)
console.log(`boot log:      ${logPath}`)
console.log(`\n=== ${failed === 0 ? 'REAL-PRODUCT LOAD VERIFIED' : `${failed} CHECK(S) FAILED`} ===`)

// Keep the work dir only on failure so a passing run leaves no litter.
if (failed === 0) await rm(workDir, { recursive: true, force: true })

process.exit(failed === 0 ? 0 : 1)