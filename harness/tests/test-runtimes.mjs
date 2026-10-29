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
  const separated = { runtimes: { claude: { args: ['--restricted', '--tools', 'Read'], implementation_args: ['--permission-mode', 'auto'] } } };
  const writeRoute = invocation({ runtime: 'claude', config: separated, prompt: 'write' });
  const reviewRoute = invocation({ runtime: 'claude', config: separated, prompt: 'review', readOnly: true });
  assert(writeRoute.includes('auto')); assert(!writeRoute.includes('--restricted'));
  assert(reviewRoute.includes('--restricted')); assert(!reviewRoute.includes('auto'));
  const fake = join(temp, 'fake-cli.mjs');
  writeFileSync(fake, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; const a=process.argv.slice(2); const value=JSON.stringify({ok:true}); const i=a.indexOf("--output-last-message"); if(i>=0)writeFileSync(a[i+1],value);else if(a.includes("--json-schema"))console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"I reported the result.",structured_output:{ok:true}}));else if(a.includes("--json"))console.log(JSON.stringify({type:"final",text:value}));else console.log(value);\n', { mode: 0o755 });
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
  for (const auth of [{ loggedIn: false, authMethod: 'none' }, { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }]) {
    let calls = 0;
    await assert.rejects(runAgent({ runtime: 'claude', cwd: temp, prompt: 'must not run',
      config: { runtimes: { claude: { subscription_only: true } } },
      run: async argv => { calls++; assert.deepEqual(argv.slice(1), ['auth', 'status', '--json']); return JSON.stringify(auth); } }), /subscription/);
    assert.equal(calls, 1);
  }
  const largePrompt = 'untrusted review data '.repeat(20000);
  await runAgent({ runtime: 'claude', cwd: temp, prompt: largePrompt, schema,
    run: async (argv, options) => {
      assert(!argv.some(arg => arg.includes(largePrompt)));
      assert(!argv.includes('--'));
      assert(options.input.startsWith(largePrompt));
      return JSON.stringify({ subtype: 'success', structured_output: { ok: true } });
    } });
  const stdinCli = join(temp, 'stdin-cli.mjs');
  writeFileSync(stdinCli, '#!/usr/bin/env node\nimport {readFileSync} from "node:fs"; console.log(readFileSync(0,"utf8"));', { mode: 0o755 });
  assert((await runAgent({ runtime: 'claude', config: { runtimes: { claude: { bin: stdinCli } } }, cwd: temp, prompt: largePrompt })).startsWith(largePrompt));
  const claudeArgs = invocation({ runtime: 'claude', cwd: temp, prompt: 'review', schema });
  assert.equal(claudeArgs[claudeArgs.indexOf('--output-format') + 1], 'json');
  assert.deepEqual(JSON.parse(claudeArgs[claudeArgs.indexOf('--json-schema') + 1]), schema);
  const plainClaude = invocation({ runtime: 'claude', prompt: 'plain' });
  assert.equal(plainClaude[plainClaude.indexOf('--output-format') + 1], 'text');
  assert(!plainClaude.includes('--json-schema'));
  for (const envelope of [
    { subtype: 'success', result: 'I reported a finding' },
    { subtype: 'error_max_turns', structured_output: { ok: true } },
    { is_error: true, structured_output: { ok: true } },
    { subtype: 'success', structured_output: { ok: 'yes' } },
  ]) {
    let attempts = 0;
    await assert.rejects(runAgent({ runtime: 'claude', cwd: temp, prompt: 'review', schema,
      run: async () => { attempts++; return JSON.stringify(envelope); } }));
    assert.equal(attempts, 1, 'provider failures and invalid output do not trigger paid blind retries');
  }
  const calls = [];
  const session = 'session-11111111-1111-4111-8111-111111111111';
  const output = answer => `${JSON.stringify({ type: 'session', sessionId: session })}\n${JSON.stringify({ type: 'final', text: answer })}\n`;
  assert.deepEqual(await runAgent({ runtime: 'dsh', cwd: temp, prompt: 'review', schema,
    run: async argv => { calls.push(argv); return output(calls.length === 1 ? "I'll review the files." : '{"ok":true}'); } }), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(calls[1].indexOf('--session-id'), calls[1].indexOf('--session-id') + 2), ['--session-id', session]);
  await assert.rejects(execute([process.execPath, '-e', 'process.exit(2)']), /failed/);
  await assert.rejects(runAgent({ runtime: 'dsh', config: { runtimes: { dsh: { bin: fake } } }, cwd: temp, prompt: 'x', schema: { type: 'object', required: ['missing'] } }), /missing/);
  assert.throws(() => validate({ findings: [{}] }, { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', required: ['line'] } } } }), /line/);
  installSkills(temp); installSkills(temp);
  assert.match(readFileSync(join(temp, '.agents/skills/cycler-workflow-review/SKILL.md'), 'utf8'), /harness|skills\/workflow-review/);
  writeFileSync(join(temp, '.agents/skills/cycler-start/SKILL.md'), 'user owned');
  assert.throws(() => installSkills(temp), /overwrite/);
  console.log('PASS provider argv, real fake-CLI execution, invalid output, routing and skill installation');
} finally { rmSync(temp, { recursive: true, force: true }); }
