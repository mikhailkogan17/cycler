#!/usr/bin/env node
// Runs every test-*.mjs in this directory. No agents are spawned — sim.mjs stubs the
// workflow runtime, so the whole suite is free and runs in milliseconds.
//   node harness/tests/run.mjs
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const tests = readdirSync(here).filter((f) => f.startsWith('test-') && f.endsWith('.mjs')).sort()
let failed = 0
for (const t of tests) {
  console.log(`\n── ${t}`)
  const r = spawnSync(process.execPath, [join(here, t)], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
console.log(failed ? `\n${failed} test file(s) FAILED` : `\nall ${tests.length} test file(s) passed`)
process.exit(failed ? 1 : 0)
