// Simulator for workflows/task-orchestration.js — stubs the workflow runtime
// (agent/parallel/pipeline/phase/log/budget/args) so control flow can be exercised
// without spawning a single real agent.
import { readFileSync } from 'node:fs'

const SRC = process.env.WF || new URL('../../workflows/task-orchestration.js', import.meta.url)

// The workflow now REQUIRES cwd and pluginRoot (see task-orchestration.js — there is no `process`
// to fall back on). Every behavioural test here is about stages and control flow, not about arg
// validation, so the simulator supplies both. `noDefaults: true` turns that off, which is how
// test-workflow-runtime-globals.mjs exercises the missing-arg path for real.
const SIM_DEFAULTS = { cwd: '/tmp/sim-repo', pluginRoot: '/tmp/sim-plugin' }

export async function run({ args = {}, responder, budgetTotal = null, noDefaults = false }) {
  args = noDefaults ? args : { ...SIM_DEFAULTS, ...args }
  const src = readFileSync(SRC, 'utf8').replace(/^export const meta/m, 'const meta')
  const calls = []
  // label -> the model the workflow routed that stage to. Stage routing is a real correctness
  // property (a downgraded refuter silently drops findings), and without recording it a test that
  // asserts a model is asserting against undefined and passes no matter what.
  const models = {}
  let spent = 0
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || 'unlabeled'
    calls.push(label)
    models[label] = opts.model ?? null
    spent += 1000
    const r = await responder(label, prompt, opts, calls)
    return r === undefined ? null : r
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const pipeline = async (items, ...stages) => {
    return Promise.all(items.map(async (it, i) => {
      let v = it
      for (const s of stages) v = await s(v, it, i)
      return v
    }))
  }
  const logs = []
  const log = (m) => logs.push(m)
  const phase = () => {}
  const budget = { total: budgetTotal, spent: () => spent, remaining: () => budgetTotal == null ? Infinity : Math.max(0, budgetTotal - spent) }
  // The Workflow runtime is NOT Node module scope: it exposes agent/parallel/pipeline/log/phase/
  // budget/args and nothing else. This simulator used to be a plain Node AsyncFunction, so every
  // Node global leaked in and the simulator was strictly MORE permissive than production —
  // `const repoRoot = args?.cwd || process.cwd()` passed all 29 tests and then died in the real
  // runtime with `process is not defined`, on the first line of every unattended run.
  // Shadowing them as parameters (bound to undefined) is what makes a green sim mean something.
  const ABSENT = ['process', 'require', 'module', 'exports', '__dirname', '__filename', 'global']
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
    'args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', ...ABSENT, src
  )
  const result = await fn(args, agent, parallel, pipeline, log, phase, budget)
  return { result, calls, logs, models }
}
