import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexAppServer } from '../../lib/codex-app-server.mjs';
import { runAgent } from '../../lib/runtimes.mjs';
import { runSkill, save } from '../../workflows/run.mjs';

const temp = mkdtempSync(join(tmpdir(), 'cycler-app-server-test-'));
const fake = join(temp, 'codex');
writeFileSync(fake, `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.CYCLER_TEST_MODE || 'ok';
let currentThread = 'thread-1';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  appendFileSync(process.env.CYCLER_TEST_JOURNAL, line+'\\n');
  if (!r.id) return;
  if (r.method === 'initialize') send({id:r.id,result:{userAgent:'fake'}});
  else if (r.method === 'account/rateLimits/read') {
    if (mode === 'quota-rpc-error') { send({id:r.id,error:{message:'usage unavailable'}}); return; }
    const bucket = {limitId:'codex',primary:{usedPercent:mode === 'quota-primary' ? 80 : 1,resetsAt:123},secondary:{usedPercent:mode === 'quota-weekly' ? 80 : 30,resetsAt:456}};
    send({id:r.id,result:mode === 'quota-missing' ? {} : {ordinaryUsageAllowed:mode !== 'quota-denied',rateLimitsByLimitId:{codex:bucket}}});
  }
  else if (r.method === 'thread/start' || r.method === 'thread/resume') { currentThread = r.params.threadId || 'thread-1'; send({id:r.id,result:{thread:{id:currentThread,source:'vscode',cwd:r.params.cwd},model:r.params.model}}); }
  else if (r.method === 'thread/name/set') send({id:r.id,result:{}});
  else if (r.method === 'turn/start') {
    send({id:r.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
    if (mode === 'hang') return;
    if (mode === 'approval') { send({id:999,method:'item/commandExecution/requestApproval',params:{threadId:currentThread}}); return; }
    if (mode === 'rpc-error') { send({id:r.id,error:{code:-32602,message:'bad config'}}); return; }
    if (mode !== 'empty') send({method:'item/completed',params:{threadId:currentThread,turnId:'turn-1',item:{id:'message-1',type:'agentMessage',phase:mode === 'legacy' ? undefined : mode === 'commentary' ? 'commentary' : mode === 'partial' ? 'partial_answer' : 'final_answer',text:mode === 'invalid-nested' ? '{"checks":[{"passed":"yes"}]}' : '{"ok":true}'}}});
    send({method:'turn/completed',params:{threadId:currentThread,turn:{id:'turn-1',status:mode === 'failed' ? 'failed' : mode === 'interrupted' ? 'interrupted' : 'completed',error:mode === 'failed' ? {message:'provider failed'} : null}}});
  }
});
`, { mode: 0o755 });

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
let index = 0;
async function run(mode = 'ok', options = {}) {
  const journal = join(temp, `journal-${index++}.jsonl`);
  writeFileSync(journal, '');
  const threads = [];
  const value = await runCodexAppServer({
    bin: fake, cwd: temp, model: 'test-model', prompt: 'test prompt', schema,
    name: 'APL-147 · implementer', approvals: 'auto-review', timeout: 2000,
    env: { ...process.env, CYCLER_TEST_MODE: mode, CYCLER_TEST_JOURNAL: journal },
    onThread: thread => threads.push(thread), ...options,
  });
  return { value, threads, calls: readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse) };
}
try {
  const ok = await run();
  assert.equal(ok.value, '{"ok":true}');
  const start = ok.calls.find(x => x.method === 'thread/start').params;
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.equal(start.ephemeral, false);
  assert.equal(ok.calls.find(x => x.method === 'thread/name/set').params.name, 'APL-147 · implementer');
  assert.deepEqual(ok.calls.find(x => x.method === 'turn/start').params.outputSchema, schema);
  assert.equal(ok.threads[0].id, 'thread-1');
  assert.equal(ok.threads[0].source, 'vscode');
  assert.equal(ok.threads[0].model, 'test-model');
  assert.equal(ok.calls.some(x => x.method === 'account/rateLimits/read'), false, 'legacy default stays unchanged');
  const budgeted = await run('ok', { usageReservePercent: 20 });
  assert(budgeted.calls.findIndex(x => x.method === 'account/rateLimits/read') < budgeted.calls.findIndex(x => x.method === 'thread/start'));
  for (const mode of ['quota-primary', 'quota-weekly', 'quota-missing', 'quota-denied', 'quota-rpc-error']) {
    const journalIndex = index;
    await assert.rejects(run(mode, { usageReservePercent: 20 }), e => e.code === 'CYCLER_QUOTA_HOLD');
    const heldCalls = readFileSync(join(temp, `journal-${journalIndex}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    assert(!heldCalls.some(x => ['thread/start', 'thread/resume', 'turn/start'].includes(x.method)), 'a quota hold never starts a paid model turn');
  }
  await assert.rejects(run('ok', { usageReservePercent: 0 }), /usage_reserve_percent/);
  await assert.rejects(run('ok', { usageReservePercent: 100 }), /usage_reserve_percent/);
  const resumed = await run('ok', { threadId: 'workflow-thread', cwd: temp });
  assert.equal(resumed.calls.some(x => x.method === 'thread/start'), false);
  const resume = resumed.calls.find(x => x.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'workflow-thread');
  assert.equal(resume.cwd, temp);
  assert.equal(resume.sandbox, 'workspace-write');
  assert.equal(resume.approvalsReviewer, 'auto_review');
  assert.equal('ephemeral' in resume, false);
  assert.equal(resumed.threads[0].id, 'workflow-thread');
  const isolated = await run('ok', { ephemeral: true });
  assert.equal(isolated.calls.find(x => x.method === 'thread/start').params.ephemeral, true);
  assert.equal(isolated.calls.some(x => x.method === 'thread/name/set'), false, 'ephemeral threads reject persistent metadata updates');
  assert.equal(isolated.threads[0].ephemeral, true);
  await assert.rejects(run('ok', { threadId: 'workflow-thread', ephemeral: true }), /ephemeral/);

  const readOnly = await run('ok', { readOnly: true });
  const ro = readOnly.calls.find(x => x.method === 'thread/start').params;
  assert.equal(ro.sandbox, 'read-only');
  assert.equal(ro.approvalPolicy, 'never');
  assert.equal(ro.approvalsReviewer, 'user');
  const deny = await run('ok', { approvals: 'deny' });
  assert.equal(deny.calls.find(x => x.method === 'thread/start').params.approvalPolicy, 'never');
  assert.equal((await run('legacy')).value, '{"ok":true}');
  await assert.rejects(run('failed'), /provider failed/);
  await assert.rejects(run('interrupted'), /interrupted/);
  await assert.rejects(run('empty'), /final answer/);
  await assert.rejects(run('commentary'), /final answer/);
  await assert.rejects(run('partial'), /final answer/);
  await assert.rejects(run('approval'), /approval|requestApproval/i);
  await assert.rejects(run('rpc-error'), /bad config/);
  await assert.rejects(run('hang'), /timed out/);
  await assert.rejects(run('ok', { approvals: 'accept-everything' }), /approvals/);
  const journal = join(temp, 'routed.jsonl');
  writeFileSync(journal, '');
  process.env.CYCLER_TEST_JOURNAL = journal;
  const threads = [];
  assert.deepEqual(await runAgent({ runtime: 'codex', cwd: temp, prompt: 'test', schema, label: 'implementer',
    config: { runtimes: { codex: { bin: fake, transport: 'app-server' } } }, onThread: t => threads.push(t) }), { ok: true });
  assert.equal(threads[0].name, 'Cycler · implementer');
  const optional = { type: 'object', properties: { checks: { type: 'array', maxItems: 8, items: {
    type: 'object', properties: { passed: { type: 'boolean' }, outputTail: { type: 'string' } }, required: ['passed']
  } } }, required: [] };
  const normalized = await run('ok', { schema: optional });
  const sent = normalized.calls.find(x => x.method === 'turn/start').params.outputSchema;
  assert.deepEqual(sent.required, ['checks']);
  assert.equal(sent.additionalProperties, false);
  assert.equal(sent.properties.checks.maxItems, 8);
  assert.deepEqual(sent.properties.checks.items.required, ['passed', 'outputTail']);
  assert.equal(sent.properties.checks.items.additionalProperties, false);
  assert.deepEqual(optional.required, [], 'original workflow contract is unchanged');
  process.env.CYCLER_TEST_MODE = 'invalid-nested';
  await assert.rejects(runAgent({ runtime: 'codex', cwd: temp, prompt: 'test', schema: optional,
    config: { runtimes: { codex: { bin: fake, transport: 'app-server' } } } }), /checks\[0\].passed: expected boolean/);
  delete process.env.CYCLER_TEST_MODE;
  const statePath = join(temp, 'state.json');
  save(statePath, { status: 'running' });
  await runSkill({ workflow: 'workflow-research', task: 'a question', issueId: 'TEST-1', cwd: temp, runtime: 'codex', statePath,
    config: { runtimes: { codex: { bin: fake, transport: 'app-server' } } } });
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).codexThreads[0].name, 'Cycler TEST-1 · workflow-research');
  delete process.env.CYCLER_TEST_JOURNAL;
  console.log('PASS app-server process transport, named thread metadata, structured turns, permission boundaries and fatal outcomes');
} finally { rmSync(temp, { recursive: true, force: true }); }
