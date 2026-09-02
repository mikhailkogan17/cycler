// Only BLOCKING findings are worth an adversarial refuter.
//
// Refutation exists to stop a plausible-but-wrong finding from sending the implementer to fix nothing.
// That risk is carried entirely by findings that can block. A non-blocking nit costs an agent (~39k
// tokens) to verify and then changes no verdict either way — on the APL-48 review, all 5 findings were
// non-blocking and 5 refuters ran to confirm 4 of them, with no effect on the outcome.
//
// The thing that must NOT regress: non-blocking findings are still REPORTED. Cheaper must not mean
// quieter, and an unrefuted claim must never be presented as adversarially verified.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

const nit = { file: 'a.ts', line: 1, severity: 'non-blocking', title: 'dead code', description: 'unused helper' }
const bug = { file: 'b.ts', line: 2, severity: 'blocking', title: 'null deref', description: 'crashes on empty input' }

// One lens returns findings; the rest are clean. Avoids 4x duplicates confusing the counts.
function oneLens(findings) {
  return { auditDirty: [false], verifyGreen: [true], reviewApproved: [true], lensFindings: { bugs: [findings] } }
}

await t('a review of only nits spawns no refuters at all (the APL-48 case)', async () => {
  const { calls } = await run({ args: base, responder: makeResponder(oneLens([nit, nit, nit])) })
  const refuters = calls.filter((c) => c.startsWith('refute:'))
  assert.strictEqual(refuters.length, 0, `expected 0 refuters for non-blocking findings, got ${refuters.length}`)
})

await t('blocking findings are still refuted', async () => {
  const { calls } = await run({ args: base, responder: makeResponder(oneLens([bug, bug])) })
  const refuters = calls.filter((c) => c.startsWith('refute:'))
  assert.strictEqual(refuters.length, 2, `expected one refuter per blocking finding, got ${refuters.length}`)
})

await t('a mixed review refutes only the blocking half', async () => {
  const { calls } = await run({ args: base, responder: makeResponder(oneLens([bug, nit, nit, bug, nit])) })
  const refuters = calls.filter((c) => c.startsWith('refute:'))
  assert.strictEqual(refuters.length, 2, `expected 2 refuters (blocking only), got ${refuters.length}`)
  assert.ok(refuters.every((c) => c.includes('b.ts')), 'only the blocking file should be refuted')
})

await t('nits are still reported, and marked UNREFUTED to the synthesizer', async () => {
  const plan = oneLens([nit, bug])
  const inner = makeResponder(plan)
  let synthPrompt = ''
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => { if (l === 'synthesis') synthPrompt = p; return inner(l, p, o, c) },
  })
  assert.ok(/UNREFUTED/.test(synthPrompt), 'the synthesizer must be told which findings were not verified')
  assert.ok(/dead code/.test(synthPrompt), 'the nit must still reach the synthesizer — cheaper, not quieter')
  assert.ok(/null deref/.test(synthPrompt), 'the blocking finding must be there too')
  assert.ok(result.confirmed.some((f) => f.title === 'dead code' && f.unrefuted === true),
    'the nit must be carried in confirmed[], flagged as unrefuted')
  assert.ok(result.confirmed.some((f) => f.title === 'null deref' && !f.unrefuted),
    'the refuted blocking finding must not be flagged unrefuted')
})

await t('an unrefuted nit can never become a blocker when the synthesizer dies', async () => {
  const plan = oneLens([nit, nit])
  const inner = makeResponder(plan)
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => (l === 'synthesis' ? null : inner(l, p, o, c)),
  })
  // The synth-null path falls back to deriving blockers from findings. Nits must not qualify:
  // blocking on an unverified nit sends the implementer to fix nothing, which is the exact cost
  // this change is removing.
  assert.strictEqual(result.stage, 'review')
  assert.deepStrictEqual(result.blockingIssues ?? [], [],
    'non-blocking findings must never be promoted to blockers by the fallback')
})

process.exit(fails ? 1 : 0)
