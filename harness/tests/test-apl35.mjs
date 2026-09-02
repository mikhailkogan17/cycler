// APL-35 — a Linear URL or bare key as the /task argument resolves into the contract.
import { run } from './sim.mjs'
import { makeResponder } from './stubs.mjs'
import assert from 'node:assert'

let fails = 0
const t = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { fails++; console.log('FAIL', name, '\n  ', e.message) } }
const green = { auditDirty: [false], verifyGreen: [true], reviewApproved: [true] }

// Capture the prompts the workflow builds, so we can assert on what each stage was told.
async function capture(task, extra = {}) {
  const prompts = {}
  const responder = makeResponder({ ...green })
  const { result, calls } = await run({
    args: { task, cwd: '/tmp', ...extra },
    responder: async (label, prompt, opts, c) => { prompts[label] = prompt; return responder(label, prompt, opts, c) },
  })
  return { prompts, result, calls }
}

await t('a Linear issue URL yields the branch, and tells the contract author to resolve it', async () => {
  const { prompts, calls } = await capture('https://linear.app/mikhailkogan/issue/APL-1/cv-tailor-fails-on-fly')
  assert.ok(calls.includes('branch:claude/APL-1'), 'branch should be claude/APL-1, got ' + calls.join(','))
  assert.match(prompts.contract, /RESOLVE THE ISSUE FIRST/)
  assert.match(prompts.contract, /get_issue \{ id: "APL-1" \}/)
  assert.match(prompts.contract, /contracts\/apl-1-<short-kebab-slug>\.md/)
})

await t('a bare identifier works identically', async () => {
  const { prompts, calls } = await capture('APL-12')
  assert.ok(calls.includes('branch:claude/APL-12'))
  assert.match(prompts.contract, /RESOLVE THE ISSUE FIRST/)
  assert.match(prompts.contract, /contracts\/apl-12-<short-kebab-slug>\.md/)
})

await t('a lowercase bare key still resolves', async () => {
  const { calls } = await capture('apl-7')
  assert.ok(calls.includes('branch:claude/APL-7'))
})

await t('a described task that MENTIONS an issue is not treated as a reference-only request', async () => {
  const { prompts } = await capture('APL-9 — split fixMax into separate gate and review budgets')
  assert.ok(!/RESOLVE THE ISSUE FIRST/.test(prompts.contract), 'the request text is the spec here')
  assert.match(prompts.contract, /you may resolve it for context/)
  assert.match(prompts.contract, /contracts\/apl-9-<short-kebab-slug>\.md/)
})

await t('a non-Linear argument behaves exactly as before', async () => {
  const { prompts, calls, result } = await capture('add a retry to the uploader')
  assert.strictEqual(result.status, 'done')
  assert.ok(calls.some((c) => c.startsWith('branch:claude/')), 'falls back to the contract slug')
  assert.ok(!/RESOLVE THE ISSUE FIRST/.test(prompts.contract))
  assert.match(prompts.contract, /contracts\/<short-kebab-slug>\.md/)
})

await t('the issue key reaches the commit subject and the PR body', async () => {
  const { prompts } = await capture('https://linear.app/mikhailkogan/issue/APL-1/x')
  assert.match(prompts['committer:initial'], /Put the issue key\s+APL-1 in the subject line/)
  assert.match(prompts['pr-opener'], /Closes APL-1\./)
})

await t('with no issue key, nothing bogus is injected into commit or PR text', async () => {
  const { prompts } = await capture('add a retry to the uploader')
  assert.ok(!/Put the issue key/.test(prompts['committer:initial']))
  assert.ok(!/Closes/.test(prompts['pr-opener']))
})

await t('explicit args.issueId still wins', async () => {
  const { calls } = await capture('some free-form request', { issueId: 'APL-42' })
  assert.ok(calls.includes('branch:claude/APL-42'))
})

process.exit(fails ? 1 : 0)
