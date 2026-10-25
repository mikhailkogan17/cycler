import assert from 'node:assert/strict';
import { run } from './sim.mjs';
import { makeResponder } from './stubs.mjs';
import { runWorkflow } from '../../workflows/run.mjs';
let reviews = 0, replies = 0;
const defaultResponse = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
const responder = async (label, prompt, opts, calls) => {
  if (label === 'github-review') {
    reviews++;
    assert(opts.schema, 'native agent must return structured JSON');
    return { approved: reviews > 1, fatal: false, published: true, head: 'a'.repeat(40), confirmed: [],
      blockingIssues: reviews === 1 ? ['x.js:1: failing input'] : [], threads: reviews === 1 ? [{ id: 4, body: 'bug' }] : [] };
  }
  if (label === 'review-replies') { replies++; assert.match(prompt, /--replies/); return { replied: true }; }
  return defaultResponse(label, prompt, opts, calls);
};
const result = await run({ args: { task: 'TEST-1 fix', githubReview: true }, responder });
assert.equal(reviews, 2); assert.equal(replies, 1); assert.equal(result.result.status, 'done');
const bad = await run({ args: { task: 'TEST-1 fix', githubReview: true }, responder: async (l, p, o, c) => l === 'github-review' ? { approved: true, published: false } : defaultResponse(l, p, o, c) });
assert.equal(bad.result.status, 'blocked'); assert.equal(bad.result.stage, 'review');
const seen = [];
const stub = makeResponder({ auditDirty: [false], verifyGreen: [true], reviewApproved: [true] });
const portable = await runWorkflow({ cwd: '/tmp', task: 'test', runtime: 'codex', config: {}, noCommit: true }, { enforce: false, agent: async req => {
  seen.push(req);
  return stub(req.label, req.prompt, {}, []);
} });
assert(seen.every(r => r.runtime === 'codex'));
assert(seen.every(r => !['haiku', 'opus', 'sonnet'].includes(r.model)));
assert.equal(portable.status, 'done');
assert(seen.some(r => r.label === 'verify-gate'), 'the real portable runner must reach verification');
console.log('PASS shared GitHub review loop, threaded replies, publication failure and portable stage routing');
