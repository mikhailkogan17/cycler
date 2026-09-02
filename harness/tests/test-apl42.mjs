// APL-42 — review fix rounds re-run only the live lenses, over the fix diff, and say what they skipped.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }
const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
const finding = (file = 'a.ts') => ({ file, line: 1, title: 'x', description: 'd', severity: 'blocking' })
const clean = { auditDirty: [false], verifyGreen: [true] }

async function reviewRun(plan, args = {}) {
  const prompts = {}
  const responder = makeResponder(plan)
  const { result, calls, logs } = await run({
    args: { ...base, ...args },
    responder: async (l, p, o, c) => { prompts[l] = (prompts[l] || []).concat(p); return responder(l, p, o, c) },
  })
  return { result, calls, logs, prompts, lensCalls: calls.filter((c) => c.startsWith('review:')) }
}

await t('round 1 runs all four lenses over the full branch diff', async () => {
  const { result, lensCalls, prompts } = await reviewRun({ ...clean, reviewApproved: [true] })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(lensCalls.length, 4)
  assert.strictEqual(result.reviewCoverage.length, 1)
  assert.deepStrictEqual(result.reviewCoverage[0].lensesSkipped, [])
  assert.match(prompts['review:bugs'][0], /git diff main\.\.\.HEAD/)
})

await t('a fix round re-runs only the live lenses plus the always-run pair', async () => {
  const { result, lensCalls } = await reviewRun({
    ...clean,
    // Only scope-creep is clean in round 1; test-gaps had a finding, so it stays live.
    lensFindings: { bugs: [[finding()]], 'test-gaps': [[finding('b.ts')]], contract: [[]], 'scope-creep': [[]] },
    reviewApproved: [false, true],
  })
  assert.strictEqual(result.status, 'done')
  // 4 in round 1, then bugs + contract (always) + test-gaps (live) = 3
  assert.strictEqual(lensCalls.length, 7)
  const r2 = result.reviewCoverage[1]
  assert.deepStrictEqual(r2.lensesRun.sort(), ['bugs', 'contract', 'test-gaps'])
  assert.deepStrictEqual(r2.lensesSkipped, ['scope-creep'])
})

await t('when every lens was clean, a fix round still re-runs bugs + contract', async () => {
  const { result, lensCalls } = await reviewRun({ ...clean, reviewApproved: [false, true] })
  assert.strictEqual(lensCalls.length, 6, 'expected 4 + 2, got ' + lensCalls.length)
  assert.deepStrictEqual(result.reviewCoverage[1].lensesRun, ['bugs', 'contract'])
  assert.deepStrictEqual(result.reviewCoverage[1].lensesSkipped.sort(), ['scope-creep', 'test-gaps'])
})

await t('lens agents scale sub-linearly: 3 rounds cost 8, not 12', async () => {
  const { result, lensCalls } = await reviewRun(
    { ...clean, reviewApproved: [false, false, true] },
    { fixMax: 3 }
  )
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(lensCalls.length, 8)
  assert.strictEqual(result.reviewCoverage.length, 3)
})

await t('a fix round is scoped to the fix diff, not the whole branch', async () => {
  const { result, prompts } = await reviewRun({ ...clean, reviewApproved: [false, true] })
  const round2 = prompts['review:bugs'][1]
  assert.match(round2, /git diff commit10000000\.\.HEAD/, 'round 2 should diff from the previously reviewed commit')
  assert.match(round2, /regression\s+the fix introduces is exactly what this round exists to catch/)
  assert.match(round2, /OPEN IT and check the interaction/, 'narrowing must not become a wall')
  assert.match(result.reviewCoverage[1].diffScope, /fix diff only/)
})

await t('the contract lens picks up scope + coverage duty when those lenses are skipped', async () => {
  const { prompts } = await reviewRun({ ...clean, reviewApproved: [false, true] })
  const contractRound2 = prompts['review:contract'][1]
  assert.match(contractRound2, /outside the contract's Allowed paths/)
  assert.match(contractRound2, /nothing tests/)
})

await t('a regression introduced by a fix round is still caught', async () => {
  const { result } = await reviewRun({
    ...clean,
    // Round 1: only test-gaps complains. Round 2: the FIX introduces a bug, found by the always-run lens.
    lensFindings: { 'test-gaps': [[finding()]], bugs: [[], [finding('regression.ts')]] },
    reviewApproved: [false, false, false],
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'review')
  assert.ok(result.reviewCoverage[1].lensesRun.includes('bugs'))
})

await t('nothing skipped is silent — log, notes and reviewCoverage all say so', async () => {
  const { result, logs } = await reviewRun({ ...clean, reviewApproved: [false, true] })
  assert.ok(logs.some((l) => l.includes('APL-42') && l.includes('NOT re-run')), 'expected an APL-42 log line')
  assert.match(result.notes, /APL-42 narrowing/)
  assert.match(result.notes, /scope-creep/)
  assert.ok(result.reviewCoverage.every((c) => c.reason))
})

await t('the synthesizer is told what was not re-examined', async () => {
  const { prompts } = await reviewRun({ ...clean, reviewApproved: [false, true] })
  assert.match(prompts.synthesis[1], /NOT re-run this round/)
  assert.match(prompts.synthesis[1], /nobody reads this verdict as a fresh four-lens review/)
})

await t('a missing commit hash falls back to the full branch diff and says so', async () => {
  const responder = makeResponder({ ...clean, reviewApproved: [false, true] })
  const prompts = {}
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => {
      prompts[l] = (prompts[l] || []).concat(p)
      const r = await responder(l, p, o, c)
      // A committer that pushes but reports no hash: we must not invent a diff range.
      return l.startsWith('committer:') ? { ...r, commitHash: '' } : r
    },
  })
  assert.strictEqual(result.status, 'done')
  assert.match(result.reviewCoverage[1].diffScope, /full branch diff/)
  assert.match(prompts['review:bugs'][1], /git diff main\.\.\.HEAD/)
})

await t('a dead lens on a fix round is still fatal, not a silent pass', async () => {
  const responder = makeResponder({ ...clean, reviewApproved: [false, true] })
  let round = 0
  const { result } = await run({
    args: base,
    responder: async (l, p, o, c) => {
      if (l === 'review:bugs' && ++round === 2) return null
      return responder(l, p, o, c)
    },
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.fatal, true)
  assert.match(result.blockedReason, /UNREVIEWED/)
})

process.exit(fails ? 1 : 0)
