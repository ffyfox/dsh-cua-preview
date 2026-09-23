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
 * Usage:  node examples/run-real-dsh-load.mjs
 * Exit code 0 = the real product loaded the plugin and listed all four tools.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const EXPECTED = ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_act']

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

const overlay = `# Temporary overlay: the plugin under test plus a probe that reports the live tool registry.
- insert:
    - id: cua-preview
      name: '${join(root, 'src/index.js')}'
      config:
        artifactsDir: '${join(workDir, 'artifacts')}'
        headless: true
    - id: cua-preview-load-probe
      name: '${join(root, 'examples/load-probe.plugin.mjs')}'
      config:
        resultPath: '${verdictPath}'
        timeoutMs: 45000
        exitAfter: true
`
await writeFile(overlayPath, overlay)

console.log('booting the real dsh web profile with the plugin patched in...')
console.log(`  overlay: ${overlayPath}`)
console.log(`  port:    ${PROBE_PORT} (OS-assigned; the user's GUI is untouched)\n`)

const child = spawn(
  'dsh',
  ['--profile', 'web', '--patch', overlayPath, '--port', String(PROBE_PORT), '--no-open'],
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
  // The frame below is read off the real Session log the product wrote. The enforcement point
  // (`sessionController.attachment`, reached by the browser's image loader) lives in the API
  // gateway's isolation scope and cannot be called from a root-level patch row — so this asserts the
  // plugin-owned half: the event exists, it is log-only, and it carries the reference in the exact
  // position that authorization scans.
  ['a real gated click was approved and ran',
    verdict.actionGranted === true, `decision=${verdict.approvalDecision}`],
  ['a real blank first navigation carries no credential frame',
    verdict.blankNavigationOmittedFrame === true, 'no approvalImage / approvalScreenshotPath'],
  ['the approval reason is a single line and carries no path',
    typeof verdict.approvalReason === 'string' &&
      !verdict.approvalReason.includes('\n') && !verdict.approvalReason.includes('.png'),
    JSON.stringify(verdict.approvalReason)],
  ['the real Session log references the approved frame',
    verdict.credentialReferenced === true, `attachment=${verdict.credentialAttachmentId}`],
  ['that reference sits in the position the Host authorizer scans',
    verdict.referenceIsInScannedPosition === true, 'data.content[0]'],
  ['the plugin wrote exactly one cua/preview event, and it is log-only',
    verdict.previewEventsInSessionLog === 1 && verdict.previewEventIsLogOnly === true,
    `cua/preview events=${verdict.previewEventsInSessionLog} logOnly=${verdict.previewEventIsLogOnly}`],
  ['that event carries the call id the approval panel joins on',
    verdict.previewEventCallId === 'cua-preview-probe-call' && verdict.previewEventAction === 'click',
    `callId=${String(verdict.previewEventCallId)} action=${String(verdict.previewEventAction)}`],
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