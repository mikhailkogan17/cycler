// The Follow-ups stage — the step that turns "the implementer noticed it" into "something tracks it".
//
// Contracts are gitignored, so a follow-up that is only written down is lost. The review's contract
// lens treats a confirmed-but-unfiled defect as BLOCKING, which made the process unsatisfiable by
// construction until something in the run actually filed them (APL-54 ended by asking a human to).
//
// The failure mode these guard is not "it did not file" — it is "it did not file AND the run still
// read as clean".
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

const green = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }
const approvedBody = (r) => (r.linearWrites.find((w) => w.kind === 'approved') || {}).body || ''

await t('the stage runs once on a clean run, on haiku', async () => {
  const { result, calls, models } = await run({ args: base, responder: makeResponder({ ...green }) })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(calls.filter((c) => c === 'followups').length, 1, 'exactly one follow-ups agent')
  assert.strictEqual(models.followups, 'haiku', 'the triager must not cost a big model')
})

await t('filed follow-ups reach the Linear comment, not just the tool result', async () => {
  const plan = { ...green, followups: { kept: ['dead escapeHtml()'], dropped: [], filed: ['FILED APL-120: dead escapeHtml()'], failed: [] } }
  const { result } = await run({ args: base, responder: makeResponder(plan) })
  assert.ok(result.followups.filed.length === 1, 'the result carries what was filed')
  assert.ok(approvedBody(result).includes('APL-120'),
    'a filed follow-up must appear on the issue — a human does not read the tool result')
})

await t('a follow-up that could NOT be filed is surfaced, never rounded down to a clean run', async () => {
  const plan = { ...green, followups: { kept: ['x'], dropped: [], filed: [], failed: ['FAIL could not file: rr-render swallows tsc failures'] } }
  const { result } = await run({ args: base, responder: makeResponder(plan) })
  assert.strictEqual(result.status, 'done', 'Linear must never fail the task')
  assert.ok(result.followups.failed.length === 1, 'the failure survives into the result')
  assert.ok(approvedBody(result).includes('could NOT be filed'),
    'the issue comment must say a real defect is untracked; silence here is the loss the stage prevents')
})

await t('noCommit skips it — there is no PR for a follow-up to hang off', async () => {
  const { result, calls } = await run({ args: { ...base, noCommit: true }, responder: makeResponder({ auditDirty: [false], verifyGreen: [true] }) })
  assert.ok(!calls.includes('followups'), 'no follow-ups agent on a noCommit run')
  assert.strictEqual(result.followups, null)
})

process.exit(fails ? 1 : 0)
