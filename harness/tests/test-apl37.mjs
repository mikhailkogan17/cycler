// APL-37 — unattended-run guarantees: no prompts, bounded cost, honest terminal state.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }
const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
const clean = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }

await t('unattended overrides stopAtContract — the run never stops for sign-off', async () => {
  const { result, logs, calls } = await run({
    args: { ...base, unattended: true, stopAtContract: true },
    responder: makeResponder(clean),
  })
  assert.strictEqual(result.status, 'done', 'expected a full run, got ' + result.status)
  assert.ok(calls.includes('pr-opener'))
  assert.ok(logs.some((l) => l.includes('APL-37') && l.includes('stopAtContract')))
})

await t('stopAtContract still works when NOT unattended', async () => {
  const { result } = await run({ args: { ...base, stopAtContract: true }, responder: makeResponder(clean) })
  assert.strictEqual(result.status, 'plan')
})

await t('unattended with no tracker key warns that a failure has nowhere to go', async () => {
  const { logs } = await run({
    args: { task: 'no issue key here', cwd: '/tmp', unattended: true },
    responder: makeResponder(clean),
  })
  assert.ok(logs.some((l) => l.includes('NOWHERE to be reported')))
})

await t('the pre-commit gate loop is budget-guarded, not just Review', async () => {
  const { result, logs, calls } = await run({
    args: base,
    budgetTotal: 12_000, // a handful of agents, then below the 60k floor
    responder: makeResponder({ auditDirty: [true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.budgetStopped, true)
  assert.strictEqual(result.roundsExhausted, false, 'budget and rounds are different failures')
  assert.ok(!calls.includes('pr-opener'), 'nothing may be published on a budget stop')
  assert.ok(logs.some((l) => l.includes('APL-37') && l.includes('NOT committed')))
})

await t('a budget stop is distinguishable from rounds running out', async () => {
  const { result } = await run({
    args: base,
    responder: makeResponder({ auditDirty: [true, true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.roundsExhausted, true)
  assert.strictEqual(result.budgetStopped, false)
})

await t('an unbudgeted run is never budget-stopped (budget.total null)', async () => {
  const { result } = await run({ args: base, responder: makeResponder(clean) })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(result.terminal, 'pr-opened')
})

await t('terminal state is stated, not inferred: pr-opened', async () => {
  const { result } = await run({ args: base, responder: makeResponder(clean) })
  assert.strictEqual(result.terminal, 'pr-opened')
})

await t('terminal state is stated, not inferred: no-pr when gh fails', async () => {
  const responder = makeResponder(clean)
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => (l === 'pr-opener' ? { prUrl: '' } : responder(l, p, o, c)),
  })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(result.terminal, 'no-pr', 'a done run with no PR must say so rather than look successful')
})

await t('noCommit is terminal no-pr', async () => {
  const { result } = await run({ args: { ...base, noCommit: true }, responder: makeResponder(clean) })
  assert.strictEqual(result.terminal, 'no-pr')
})

await t('a blocked pre-commit run is terminal no-pr', async () => {
  const { result } = await run({
    args: base,
    responder: makeResponder({ auditDirty: [true, true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.terminal, 'no-pr')
})

process.exit(fails ? 1 : 0)
