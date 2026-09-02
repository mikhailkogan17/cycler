// APL-36 — Linear round-trip: status transitions, PR attachment, blocked-reason comments.
//
// The transitions are unchanged. What changed is WHO performs them: the workflow used to spawn a
// cheap agent per write (3-4 per run at ~39k tokens each, for zero code value, against an MCP a
// subagent could not authenticate to — see APL-46). It now PLANS the writes into
// `result.linearWrites` and the ORCHESTRATOR performs them with its working connector.
//
// So these assert the plan, and that no agent is spent producing it.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

const green = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }
const kinds = (r) => r.linearWrites.filter((w) => !w.skipped).map((w) => w.kind)
const noLinearAgents = (calls) =>
  assert.ok(!calls.some((c) => c.startsWith('linear:')), 'no agent may be spent on a Linear write')

await t('happy path plans started -> pr-opened -> approved, with no agent', async () => {
  const { result, calls } = await run({ args: base, responder: makeResponder({ ...green }) })
  assert.strictEqual(result.status, 'done')
  assert.deepStrictEqual(kinds(result), ['started', 'pr-opened', 'approved'])
  noLinearAgents(calls)
})

await t('a blocked run plans a comment with the stage and reason', async () => {
  const plan = { auditDirty: [true, true, true, true], verifyGreen: [true] }
  const { result, calls } = await run({ args: base, responder: makeResponder(plan) })
  assert.strictEqual(result.status, 'blocked')
  assert.deepStrictEqual(kinds(result), ['started', 'blocked-audit'])
  const w = result.linearWrites.find((x) => x.kind === 'blocked-audit')
  assert.ok(w.body && w.body.includes('audit'), 'the blocked comment must name the failing stage')
  noLinearAgents(calls)
})

await t('a fatal stage still reaches the plan (the path that matters most)', async () => {
  const inner = makeResponder({ auditDirty: [false] })
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => (l === 'verify-gate' ? null : inner(l, p, o, c)),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'verify')
  assert.strictEqual(result.fatal, true)
  assert.ok(kinds(result).includes('blocked-verify'))
})

await t('open questions stop the run before any code is written', async () => {
  const plan = { ...green, contract: { contractPath: '/tmp/c.md', openQuestions: ['which API?'] } }
  const { result, calls } = await run({ args: base, responder: makeResponder(plan) })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'contract')
  assert.deepStrictEqual(result.openQuestions, ['which API?'])
  assert.ok(!calls.some((c) => c.startsWith('implementer')), 'must not implement a guess')
  assert.ok(!calls.includes('pr-opener'))
  assert.deepStrictEqual(kinds(result), ['started', 'open-questions', 'blocked-contract'])
})

await t('stopOnOpenQuestions:false posts the questions and continues', async () => {
  const plan = { ...green, contract: { contractPath: '/tmp/c.md', openQuestions: ['which API?'] } }
  const { result, calls } = await run({ args: { ...base, stopOnOpenQuestions: false }, responder: makeResponder(plan) })
  assert.strictEqual(result.status, 'done')
  assert.ok(calls.includes('pr-opener'))
  assert.ok(kinds(result).includes('open-questions'))
})

await t('every planned write carries an idempotency marker', async () => {
  const { result } = await run({ args: base, responder: makeResponder({ ...green }) })
  for (const w of result.linearWrites.filter((x) => !x.skipped)) {
    assert.ok(w.marker && w.marker.includes('APL-99') && w.marker.includes(w.kind),
      `write "${w.kind}" needs a marker the caller can check before posting, got ${w.marker}`)
    if (w.body) assert.ok(w.body.startsWith(w.marker), 'the marker must lead the body so it matches verbatim')
  }
})

await t('no PR URL means no PR is claimed on the board', async () => {
  const { result, logs } = await run({ args: base, responder: makeResponder({ ...green, pr: null }) })
  assert.strictEqual(result.status, 'done')
  assert.ok(!kinds(result).includes('pr-opened'))
  assert.ok(logs.some((l) => l.includes('APL-36')))
})

await t('linear:false plans nothing but records why', async () => {
  const { result } = await run({ args: { ...base, linear: false }, responder: makeResponder({ ...green }) })
  assert.strictEqual(result.status, 'done')
  assert.deepStrictEqual(kinds(result), [])
  assert.ok(result.linearWrites.every((w) => w.skipped && /args\.linear/.test(w.note)),
    'a disabled round-trip must not look like "no transitions happened"')
})

await t('a task with no Linear key plans nothing, and says so', async () => {
  const { result } = await run({ args: { task: 'do a thing with no issue key', cwd: '/tmp' }, responder: makeResponder({ ...green }) })
  assert.strictEqual(result.status, 'done')
  assert.deepStrictEqual(kinds(result), [])
  assert.ok(result.linearWrites.every((w) => w.skipped && /no Linear issue key/.test(w.note)))
})

await t('noCommit runs plan no PR or approval write', async () => {
  const { result } = await run({ args: { ...base, noCommit: true }, responder: makeResponder({ ...green }) })
  assert.strictEqual(result.status, 'done')
  assert.deepStrictEqual(kinds(result), ['started'])
})

process.exit(fails ? 1 : 0)
