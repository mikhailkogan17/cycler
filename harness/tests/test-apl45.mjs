// APL-45 — parallel-safe runs: worktree isolation, the shared-tree lock, and the refuter that used to
// read the wrong tree. Every assertion here is about a failure that is SILENT if it regresses: a run
// working in the wrong directory, a lock nobody released, a finding dropped because a path was wrong.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const REPO = '/repo'
const base = { task: 'APL-99 do a thing', cwd: REPO, issueId: 'APL-99' }
const WT = `${REPO}/.claude/worktrees/claude-APL-99`
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

// Capture every prompt so we can assert which directory each stage was pointed at.
function recordingResponder(plan = {}) {
  const inner = makeResponder(plan)
  const prompts = {}
  const responder = async (label, prompt, opts, calls) => {
    prompts[label] = prompt
    return inner(label, prompt, opts, calls)
  }
  return { responder, prompts }
}

const clean = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }

// ---------- criterion 1: stages run in the worktree, not the repo root ----------

await t('worktree mode points every repo-reading stage at the worktree, not the repo root', async () => {
  const { responder, prompts } = recordingResponder(clean)
  const { result } = await run({ args: { ...base, worktree: true }, responder })
  assert.strictEqual(result.status, 'done', result.blockedReason || result.stage)
  // The stages that actually read and change code must all name the worktree.
  for (const label of ['implementer', 'verify-gate', 'committer:initial', 'pr-opener']) {
    const p = prompts[label]
    assert.ok(p, `no prompt captured for ${label}`)
    assert.ok(p.includes(WT), `${label} was not pointed at the worktree`)
  }
})

await t('the branch manager itself still operates on the main checkout', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/APL-99']
  // It must drive git against the repo root (that is where the worktree registry lives) and must be
  // told never to switch there — switching is what would corrupt a concurrent run.
  // The prompt binds the repo root to a shell var ($P) and drives git through it, so assert the
  // binding plus a -C usage rather than the literal `git -C /repo` spelling.
  assert.ok(p.includes(`P=${REPO}`), 'branch manager does not bind the main checkout path')
  assert.ok(/git -C \$P/.test(p), 'branch manager does not drive git against the main checkout')
  assert.ok(/[Nn]ever 'git switch' in/.test(p), 'branch manager is not forbidden from switching the main checkout')
  assert.ok(p.includes('worktree add'), 'branch manager does not create a worktree')
})

await t('shared-tree mode leaves every stage on the repo root', async () => {
  const { responder, prompts } = recordingResponder(clean)
  const { result } = await run({ args: base, responder })
  assert.strictEqual(result.status, 'done', result.blockedReason || result.stage)
  assert.ok(prompts['implementer'].includes(REPO))
  assert.ok(!prompts['implementer'].includes('.claude/worktrees/'), 'shared-tree run leaked a worktree path')
  assert.strictEqual(result.worktree, null)
})

// ---------- criterion 3: the refuter reads the run's tree ----------

await t('the refuter is told which tree to read (the APL-45 silent-drop bug)', async () => {
  const { responder, prompts } = recordingResponder({
    ...clean,
    findings: [{ file: 'a.ts', title: 'x', severity: 'blocking', detail: 'd' }],
    reviewApproved: [true],
  })
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['refute:a.ts']
  assert.ok(p, 'refuter never ran')
  assert.ok(p.includes(WT), 'refuter was not told the run working dir — it would read the unmodified main tree')
})

await t('the refuter must not report isReal:false merely because it cannot find the file', async () => {
  const { responder, prompts } = recordingResponder({
    ...clean,
    findings: [{ file: 'a.ts', title: 'x', severity: 'blocking', detail: 'd' }],
  })
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['refute:a.ts']
  // Without this instruction, "wrong tree" and "refuted" are the same answer, and real findings vanish.
  assert.ok(/do NOT return isReal:false/i.test(p), 'refuter may still silently drop a finding on a path miss')
})

// ---------- criterion 2: the shared-tree lock ----------

await t('a shared-tree run takes the lock and releases it on a clean finish', async () => {
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({ ...clean, lockTaken: true }),
  })
  assert.strictEqual(result.status, 'done', result.blockedReason || result.stage)
  assert.ok(calls.includes('cleanup'), 'cleanup never ran — the lock would be left held')
  assert.strictEqual(result.lockHeld, false, 'lock still reported as held after a clean run')
})

await t('the lock is released even when the run blocks', async () => {
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({ lockTaken: true, auditDirty: [true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.ok(calls.includes('cleanup'), 'a blocked run left the shared tree locked forever')
  assert.strictEqual(result.lockHeld, false)
})

await t('a lock taken by a branch stage that then failed is still released', async () => {
  // The nastiest ordering: lock acquired at step 0, failure at step 6. If lockHeld were only recorded
  // on success, this lock would outlive the process and block every later run.
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({
      branch: { ok: false, branch: 'main', lockTaken: true, error: 'HEAD is still on main' },
    }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'branch')
  assert.ok(calls.includes('cleanup'), 'lock leaked from a failed branch stage')
})

await t('a run refused because another holds the lock blocks, and says how to run in parallel', async () => {
  const { result, calls } = await run({
    args: base,
    responder: makeResponder({
      branch: { ok: false, branch: 'main', error: 'lock held by claude/APL-41 since 2026-08-21T10:00:00Z' },
    }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.stage, 'branch')
  assert.ok(result.fatal, 'a refused-for-lock run must be fatal, not a fixable gate failure')
  assert.ok(/APL-41/.test(result.blockedReason), 'the holder is not named in the block reason')
  // It did not take the lock, so it must not have run cleanup and stolen the holder's lock.
  assert.ok(!calls.includes('cleanup'), 'a refused run cleaned up a lock it did not own')
})

await t('the lock instruction uses mkdir, the atomic test-and-set', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: base, responder })
  const p = prompts['branch:claude/APL-99']
  assert.ok(/mkdir "/.test(p), 'lock is not acquired with mkdir')
  assert.ok(/do NOT substitute/i.test(p), 'nothing warns against the racy check-then-create rewrite')
  assert.ok(/stale/i.test(p), 'no staleness handling — one crashed run would block the repo forever')
})

// ---------- criterion 5: worktree kept on failure, removed on success ----------

await t('a clean worktree run removes its worktree', async () => {
  const { result, calls } = await run({
    args: { ...base, worktree: true },
    responder: makeResponder(clean),
  })
  assert.strictEqual(result.status, 'done')
  assert.ok(calls.includes('cleanup'))
  assert.strictEqual(result.worktree, null, 'worktree should be gone after a clean run')
})

await t('a blocked worktree run KEEPS the worktree and reports where it is', async () => {
  const { result, calls } = await run({
    args: { ...base, worktree: true },
    responder: makeResponder({ auditDirty: [true, true, true], verifyGreen: [true] }),
  })
  assert.strictEqual(result.status, 'blocked')
  assert.strictEqual(result.worktree, WT, 'the evidence directory was thrown away')
  assert.ok(!calls.includes('cleanup'), 'a blocked run should not run the removal step')
  assert.ok(/worktree KEPT/.test(result.cleanupNote), 'nothing told the caller the worktree survived')
  assert.ok(result.cleanupNote.includes('worktree remove'), 'no instruction for removing it by hand')
})

// ---------- criterion 7: nothing is silent ----------

await t('a cleanup agent that dies is reported, not read as released', async () => {
  // APL-7 discipline applied to cleanup: a null result means the rm never ran. Reporting the lock as
  // released would strand the repo — the next run refuses, and nobody knows why.
  const { result, logs } = await run({
    args: base,
    responder: makeResponder({ ...clean, lockTaken: true, cleanup: null }),
  })
  assert.strictEqual(result.lockHeld, true, 'a dead cleanup agent was read as a successful release')
  assert.ok(/may STILL BE HELD/.test(result.cleanupNote), 'the uncertain lock state was not surfaced')
  assert.ok(logs.some((l) => /may STILL BE HELD/.test(l)), 'nothing was logged about the stranded lock')
})

await t('a cleanup that reports failure leaves lockHeld true and logs it', async () => {
  const { result, logs } = await run({
    args: base,
    responder: makeResponder({
      ...clean,
      lockTaken: true,
      cleanup: { lockReleased: false, worktreeRemoved: false, note: 'permission denied' },
    }),
  })
  assert.strictEqual(result.lockHeld, true)
  assert.ok(logs.some((l) => /NOT released/.test(l)), 'a failed release was silent')
})

await t('a worktree that fails to be removed is not reported as gone', async () => {
  const { result, logs } = await run({
    args: { ...base, worktree: true },
    responder: makeResponder({
      ...clean,
      cleanup: { lockReleased: true, worktreeRemoved: false, note: 'directory busy' },
    }),
  })
  assert.strictEqual(result.worktree, WT, 'a worktree that survived was reported as removed')
  assert.ok(logs.some((l) => /was not removed/.test(l)))
})

await t('both modes announce which one is in effect', async () => {
  const iso = await run({ args: { ...base, worktree: true }, responder: makeResponder(clean) })
  assert.ok(iso.logs.some((l) => /isolated run/.test(l)), 'worktree mode did not announce itself')
  const shared = await run({ args: base, responder: makeResponder(clean) })
  assert.ok(shared.logs.some((l) => /shared-tree run/.test(l) && /worktree: true/.test(l)),
    'shared-tree mode did not announce the lock or point at the parallel option')
})

// ---------- criterion 4: the gate can actually run inside a worktree ----------

await t('the worktree is given a node_modules, or the gate fails on missing modules', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/APL-99']
  assert.ok(/node_modules/.test(p), 'nothing makes node_modules reachable — every eslint/vitest check would fail')
  assert.ok(/ln -s/.test(p), 'node_modules is not linked into the worktree')
})

// ---------- the branch is the lock, in worktree mode ----------

await t('worktree mode refuses --force when the branch is checked out elsewhere', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/APL-99']
  assert.ok(/ALREADY CHECKED OUT/.test(p), 'nothing handles a second run on the same branch')
  assert.ok(/Do NOT use --force/.test(p), '--force would put two runs on one branch')
})

// (The APL-47 Linear breaker was removed with the agent-based round-trip: the workflow no longer
// spends anything on Linear writes, so there is no spending to break the circuit on. See
// test-apl36.mjs for the plan the caller performs instead.)

await t('the contract author is told to resolve observable questions instead of asking', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: base, responder })
  const p = prompts.contract
  assert.ok(/OBSERVABLE/.test(p), 'nothing distinguishes observable questions from preferences')
  assert.ok(/PREFERENCE/.test(p), 'nothing defines what is actually worth blocking on')
  assert.ok(/read the code/i.test(p), 'not told to answer structural questions by reading')
  assert.ok(/screenshot|computer-use|RUN THE APP/i.test(p),
    'not told it can run the app and look — the whole point of the change')
})

await t('only preference questions may block the run', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: base, responder })
  const p = prompts.contract
  assert.ok(/ONLY unresolved PREFERENCE questions in\s+openQuestions/.test(p),
    'the filter on what reaches openQuestions is not stated')
  // A resolved-by-looking decision must stay auditable, or this trades blocking for silent guessing.
  assert.ok(/Risks & assumptions/.test(p), 'resolved observations are not recorded anywhere reviewable')
})

await t('the cost of a needless question is stated, not just the rule', async () => {
  const { responder, prompts } = recordingResponder(clean)
  await run({ args: base, responder })
  assert.ok(/round-trip/.test(prompts.contract), 'the prompt does not say why an extra question is expensive')
})

process.exit(fails ? 1 : 0)
