// A worktree must get a REAL node_modules, never a share of the main checkout's.
//
// The Branch stage used to run `ln -s "$P/node_modules" "$W/node_modules"` — the exact thing AGENTS.md
// forbids by name under "Worktree hazard: never symlink root node_modules". This repo is an npm
// workspace, so that makes a worktree compile its own src/ against the MAIN checkout's copy of every
// workspace package. APL-48, APL-50 and APL-53 EACH lost a fix round independently re-diagnosing it.
//
// sim.mjs cannot run a shell, so these assert what the agent is TOLD to do — the layer the bug lived at.
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

await t('the worktree gets a real node_modules, never a symlink to the main checkout', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/APL-99']
  assert.ok(p, 'branch agent must run')
  assert.ok(/link-workspace\.sh/.test(p), 'must delegate to the script')
  // The regression itself: sharing the main checkout's node_modules. The prompt is allowed to NAME
  // that command in order to forbid it — what must never happen is naming it as an instruction. So
  // every occurrence has to sit inside a negation, not just be absent.
  const re = /ln -s "\$P\/node_modules"/g
  let m
  while ((m = re.exec(p)) !== null) {
    const before = p.slice(Math.max(0, m.index - 80), m.index)
    assert.ok(/do not|don't|never|forbid/i.test(before),
      `"ln -s $P/node_modules" appears as an instruction, not a prohibition, near: ...${before.slice(-60)}`)
  }
})

await t('the branch prompt says WHY, so the next model does not re-invent the symlink', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/APL-99']
  assert.ok(/EXACTLY as written|Do NOT substitute/.test(p), 'a bare command invites "improvement"')
  assert.ok(/has no exported member/.test(p), 'the observable signature is what makes the ban stick')
})

process.exit(fails ? 1 : 0)
