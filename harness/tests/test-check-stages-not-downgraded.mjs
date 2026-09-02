// Cost tiering must never reach the stages that ARE the checks.
//
// Verify, audit and refute are the three agents whose job is to disagree with the implementer. A
// cheaper model there does not fail loudly; it agrees more readily. A downgraded refuter confirms
// findings it should have disproved, and a downgraded auditor passes a diff that missed its contract
// — both of which look exactly like a clean run.
//
// Spec 004 §5.2 listed this as a correctness property with no test. This is that test, and the first
// version of it was VACUOUS: it dispatched no refuter (so never inspected one) and treated `null`
// — meaning "inherit the orchestrator\'s model" — as acceptable, which it is. Mutating the workflow
// to `refute: \'haiku\'` did not turn it red. It does now; that mutation is the check on the check.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

let fails = 0
const t = async (n, fn) => { try { await fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } }

const CHEAP = new Set(['haiku', 'fable'])
const base = { task: 'ABC-99 do a thing', cwd: '/tmp' }
const bug = { file: 'b.ts', line: 2, severity: 'blocking', title: 'null deref', description: 'crashes on empty input' }

await t('verify, audit and refute are never routed to a cheap model', async () => {
  const { models } = await run({
    args: base,
    responder: makeResponder({
      auditDirty: [false], verifyGreen: [true], reviewApproved: [true],
      lensFindings: { bugs: [[bug]] },   // one blocking finding, so a refuter actually runs
    }),
  })

  // Each of the three must have RUN. Without this the assertion below is vacuous for any stage the
  // scenario failed to reach — which is exactly how the first version of this test passed against a
  // deliberately downgraded refuter.
  for (const stage of ['verify', 'audit', 'refute']) {
    const labels = Object.keys(models).filter((l) => l.startsWith(stage))
    assert.ok(labels.length > 0,
      `no ${stage} stage ran, so this test proves nothing about it. Saw: ${Object.keys(models).join(', ')}`)
    for (const l of labels) {
      // null means "inherit the orchestrator\'s model", which is the strongest option available.
      assert.ok(models[l] === null || !CHEAP.has(models[l]),
        `${l} was routed to "${models[l]}" — a check must not be cheaper than what it checks`)
    }
  }
})

await t('mechanical stages ARE routed to a cheap model', async () => {
  // The other direction. Without it, a workflow that stopped tiering anything at all would pass the
  // case above while quietly costing several times more per run.
  const { models } = await run({
    args: base,
    responder: makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }),
  })
  const mechanical = Object.keys(models).filter((l) => /^(branch|commit|pr|cleanup|followups)/.test(l))
  assert.ok(mechanical.length > 0, `no mechanical stage ran: ${Object.keys(models)}`)
  assert.ok(mechanical.some((l) => CHEAP.has(models[l])),
    `no mechanical stage was tiered down: ${mechanical.map((l) => `${l}=${models[l]}`).join(', ')}`)
})

process.exit(fails ? 1 : 0)
