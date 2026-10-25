import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invocation, runtimeName, stageRoute, runAgent, execute, validate } from '../../lib/runtimes.mjs';
import { protect } from '../../lib/invariants.mjs';
import { installSkills } from '../install-skills.mjs';
const temp = mkdtempSync(join(tmpdir(), 'cycler-runtime-test-'));
try {
  assert.equal(runtimeName({}), 'claude');
  assert.throws(() => runtimeName({}, 'unknown'));
  const evil = 'Request " --model x $(touch /tmp/not-created)';
  for (const runtime of ['claude', 'codex', 'dsh']) {
    const argv = invocation({ runtime, cwd: temp, prompt: evil, output: '/tmp/result' });
    assert.equal(argv.at(-1), evil);
    assert(!argv.includes('--background'));
  }
  const code = invocation({ runtime: 'codex', cwd: temp, prompt: 'review', output: '/tmp/result', readOnly: true });
  assert(code.includes('read-only')); assert(!code.includes('--print'));
  assert.throws(() => invocation({ runtime: 'dsh', model: 'missing', prompt: 'x' }), /model_patches/);
  assert.deepEqual(stageRoute({ review: { runtime: 'dsh', lenses: { bugs: { runtime: 'codex', model: 'test-model' } } } }, 'review:bugs', 'claude', 'haiku'), { runtime: 'codex', model: 'test-model' });
  assert.equal(stageRoute({}, 'contract', 'codex', 'opus').model, undefined);
  const fake = join(temp, 'fake-cli.mjs');
  writeFileSync(fake, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; const a=process.argv.slice(2); const value=JSON.stringify({ok:true}); const i=a.indexOf("--output-last-message"); if(i>=0)writeFileSync(a[i+1],value);else if(a.includes("--json"))console.log(JSON.stringify({type:"final",text:value}));else console.log(value);\n', { mode: 0o755 });
  const protectedFile = join(temp, 'contract.md');
  writeFileSync(protectedFile, 'original');
  const guard = protect([protectedFile]); guard();
  writeFileSync(protectedFile, 'edited'); assert.throws(guard, /Protected/);
  const missing = join(temp, 'gate.sh'); const missingGuard = protect([missing]);
  writeFileSync(missing, 'echo pass'); assert.throws(missingGuard, /Protected/);
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
  for (const runtime of ['claude', 'codex', 'dsh']) {
    assert.deepEqual(await runAgent({ runtime, config: { runtimes: { [runtime]: { bin: fake } } }, cwd: temp, prompt: evil, schema }), { ok: true });
  }
  await assert.rejects(execute([process.execPath, '-e', 'process.exit(2)']), /failed/);
  await assert.rejects(runAgent({ runtime: 'dsh', config: { runtimes: { dsh: { bin: fake } } }, cwd: temp, prompt: 'x', schema: { type: 'object', required: ['missing'] } }), /missing/);
  assert.throws(() => validate({ findings: [{}] }, { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', required: ['line'] } } } }), /line/);
  installSkills(temp); installSkills(temp);
  assert.match(readFileSync(join(temp, '.agents/skills/cycler-workflow-review/SKILL.md'), 'utf8'), /harness|skills\/workflow-review/);
  writeFileSync(join(temp, '.agents/skills/cycler-start/SKILL.md'), 'user owned');
  assert.throws(() => installSkills(temp), /overwrite/);
  console.log('PASS provider argv, real fake-CLI execution, invalid output, routing and skill installation');
} finally { rmSync(temp, { recursive: true, force: true }); }
