// The workflow must not ship one project's build system to every user.
//
// It used to: the verify prompt named Applygent.xcodeproj, the schemes 'Applygent', 'Flow' and
// 'ProgressIndicatorView', and the ApplygentTests target — unconditionally, in every run, in every
// repo. Gated on apps/macOS/** so it would not RUN elsewhere, but still paid for in tokens on every
// verify agent and still telling a stranger's agent about a project that is not theirs.
//
// Same for the npm-workspace node_modules linking: correct for an npm workspace, meaningless for a
// Go or Python repo, and unconditional in worktree mode.
//
// Both are now config. These cases assert BOTH directions — absent when unconfigured, present when
// configured — because a check that only asserts absence passes against a workflow that dropped the
// feature entirely, and one that only asserts presence passes against the hardcoded version.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

let fails = 0
const t = async (n, fn) => { try { await fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } }

const green = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }
const base = { task: 'ABC-99 do a thing', cwd: '/tmp' }

function recorder(plan) {
  const inner = makeResponder(plan)
  const prompts = {}
  return { prompts, responder: async (l, p, o, c) => { prompts[l] = p; return inner(l, p, o, c) } }
}

const verifyPrompt = (prompts) =>
  Object.entries(prompts).find(([l]) => l.startsWith('verify'))?.[1] || ''

await t('an unconfigured run names no project-specific build system', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base }, responder })
  const all = Object.values(prompts).join('\n')
  for (const leak of ['Applygent', 'xcodegen', 'xcodebuild', '@applygent', 'ProgressIndicatorView']) {
    assert.ok(!all.includes(leak), `"${leak}" reached a prompt in a repo that never asked for it`)
  }
})

await t('a configured verify step reaches the verify prompt', async () => {
  const step = { when: 'apps/macOS/**', run: 'cd apps/macOS && xcodegen generate && xcodebuild test' }
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, config: { verify: { steps: [step] } } }, responder })
  const p = verifyPrompt(prompts)
  assert.ok(p.includes(step.run), `the configured command never reached the verify agent:\n${p.slice(0, 400)}`)
  assert.ok(p.includes(step.when), 'the verify agent was not told WHEN the step applies')
})

await t("a configured step's notes reach the prompt too", async () => {
  // The Applygent case needed prose as much as a command: "-scheme ApplygentTests fails instantly
  // and the implementer cannot fix it". A config that carried only the command would lose that.
  const step = { when: 'apps/macOS/**', run: 'echo hi', notes: 'The ONLY schemes are A and B.' }
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, config: { verify: { steps: [step] } } }, responder })
  assert.ok(verifyPrompt(prompts).includes(step.notes), 'notes were dropped')
})

await t('worktree linking is off unless configured', async () => {
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, worktree: true }, responder })
  const p = prompts['branch:claude/ABC-99'] || ''
  assert.ok(!/link-workspace\.sh/.test(p),
    'an npm-workspace step was ordered in a repo that never said it was an npm workspace')
})

await t('worktree linking happens when configured', async () => {
  const { responder, prompts } = recorder({
    ...green, }) 
  await run({ args: { ...base, worktree: true, config: { worktree: { linkWorkspace: true } } }, responder })
  const p = prompts['branch:claude/ABC-99'] || ''
  assert.ok(/link-workspace\.sh/.test(p), 'linkWorkspace: true did not order the link step')
  // The prohibition must survive with it — it is the reason the script exists.
  assert.ok(/has no exported member/.test(p), 'the observable signature that makes the ban stick was lost')
})

await t('a worktree bootstrap command runs only when configured', async () => {
  // link-workspace.sh used to end with another project's macOS bootstrap: create Secrets.xcconfig
  // from the example, then `npm run sidecar`. Real needs, but that project's — and unconditional.
  const { responder, prompts } = recorder({ ...green })
  await run({ args: { ...base, worktree: true }, responder })
  assert.ok(!/bootstrap/i.test(prompts['branch:claude/ABC-99'] || ''),
    'an unconfigured repo was given a bootstrap step')

  const r2 = recorder({ ...green })
  await run({
    args: { ...base, worktree: true, config: { worktree: { bootstrap: 'make dev-setup' } } },
    responder: r2.responder,
  })
  const p2 = r2.prompts['branch:claude/ABC-99'] || ''
  assert.ok(p2.includes('make dev-setup'), 'the configured bootstrap command never reached the agent')
  assert.ok(/advisory|not fatal|never fatal/i.test(p2),
    'bootstrap must be advisory — a missing toolchain must not block a run whose diff does not need it')
})

process.exit(fails ? 1 : 0)
