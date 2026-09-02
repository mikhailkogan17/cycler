// The gate is a SCRIPT, not a plan.
//
// Verify used to PLAN the gate every round — read HARNESS.md, decide which checks applied, consolidate
// them to "<= 6, never more than 10". That reasoning was re-paid on every gate round of every task to
// reach nearly the same answer each time, and it got the answer wrong in expensive ways: APL-24 and
// APL-41 each burned BOTH fix rounds on a lint invocation the implementer was forbidden to fix.
//
// sim.mjs cannot run a shell, so these assert what the agent is TOLD to do — which is the layer the
// bug lived at. The failure was an instruction, not code.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

const base = { task: 'APL-99 do a thing', cwd: '/tmp' }
let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }

const green = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }

function recorder(plan) {
  const inner = makeResponder(plan)
  const prompts = {}
  return {
    prompts,
    responder: async (label, prompt, opts, calls) => {
      prompts[label] = prompt
      return inner(label, prompt, opts, calls)
    },
  }
}

await t('verify runs gate.sh instead of planning a gate', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: base, responder })
  const p = prompts['verify-gate']
  assert.ok(p, 'verify-gate agent must run')
  assert.ok(/gate\.sh/.test(p), 'must invoke harness/gate.sh')
  assert.ok(/CONTRACT_PATH=/.test(p), 'danger silently disables its contract check without CONTRACT_PATH')
  assert.ok(/--base/.test(p), 'the gate must be told the PR base, not left to guess')
})

await t('verify no longer asks the model to plan and consolidate checks', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: base, responder })
  const p = prompts['verify-gate']
  // The exact planning language whose per-round cost this change removes.
  assert.ok(!/CONSOLIDATE/.test(p), 'check consolidation is the script\'s job now')
  assert.ok(!/never more than 10/.test(p), 'the check-count heuristic is gone')
  assert.ok(!/plan the checks/i.test(p), 'verify must not re-plan the gate every round')
})

await t('verify still owns what a fixed script cannot know', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: base, responder })
  const p = prompts['verify-gate']
  assert.ok(/Acceptance checks/.test(p), 'the contract\'s task-specific commands still need running')
  assert.ok(/xcodebuild/.test(p), 'Swift build/test is excluded from gate.sh, so the agent must cover it')
  assert.ok(/only-testing:ApplygentTests\//.test(p), 'the no-ApplygentTests-scheme trap must survive')
})

process.exit(fails ? 1 : 0)
