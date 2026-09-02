import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

// The APL-9 bug: gate burns both rounds, then passes; PR opens; review then has
// zero rounds and blocks on its first iteration.
await t('gate uses both rounds, review still gets its own full budget', async () => {
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({
      auditDirty: [true, true, false, false],       // 2 gate fix rounds
      verifyGreen: [true],
      findings: [{ file: 'a.ts', title: 'x', severity: 'blocking', detail: 'd' }],
      reviewApproved: [false, true],                // 1 review fix round, then approved
    }),
  })
  assert.strictEqual(result.status, 'done', 'expected done, got ' + result.status + ' ' + (result.blockedReason || result.stage))
  assert.strictEqual(result.fixLog.filter((e) => e.stage === 'review').length, 1)
  assert.ok(calls.includes('pr-opener'))
})

await t('review budget is enforced independently (2 rounds max)', async () => {
  const { result } = await run({
    args: base,
    responder: makeResponder({
      auditDirty: [false],
      verifyGreen: [true],
      findings: [{ file: 'a.ts', title: 'x', severity: 'blocking', detail: 'd' }],
      reviewApproved: [false, false, false, false],
    }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'review')
  assert.strictEqual(result.roundsExhausted, true)
  assert.strictEqual(result.reviewFixMax, 2)
  assert.strictEqual(result.fixLog.filter((e) => e.stage === 'review').length, 2)
})

await t('gate budget is still enforced (blocks before commit/PR)', async () => {
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({ auditDirty: [true, true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'audit')
  assert.strictEqual(result.roundsExhausted, true)
  assert.ok(!calls.includes('pr-opener'), 'must not open a PR when the gate never passed')
  assert.strictEqual(result.fixLog.length, 2)
})

await t('explicit gateFixMax / reviewFixMax override independently', async () => {
  const { result } = await run({
    args: { ...base, gateFixMax: 1, reviewFixMax: 3 },
    responder: makeResponder({
      auditDirty: [false], verifyGreen: [true],
      findings: [{ file: 'a.ts', title: 'x', severity: 'blocking', detail: 'd' }],
      reviewApproved: [false, false, false, true],
    }),
  })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(result.fixLog.filter((e) => e.stage === 'review').length, 3)
})

process.exit(fails ? 1 : 0)
