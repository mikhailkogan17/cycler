// Simulator for workflows/task-orchestration.js — stubs the workflow runtime
// (agent/parallel/pipeline/phase/log/budget/args) so control flow can be exercised
// without spawning a single real agent.
import { readFileSync } from 'node:fs'

const SRC = process.env.WF || new URL('../../workflows/task-orchestration.js', import.meta.url)

export async function run({ args = {}, responder, budgetTotal = null }) {
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
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
    'args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', src
  )
  const result = await fn(args, agent, parallel, pipeline, log, phase, budget)
  return { result, calls, logs, models }
}
