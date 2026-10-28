import assert from 'node:assert/strict';
import { review, publishReview, publishReplies, assertLocations, anchorFindings } from '../review.mjs';
const head = 'a'.repeat(40), next = 'b'.repeat(40);
const pr = { number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', headRefOid: head, baseRefOid: 'c'.repeat(40), title: 'Fix', body: 'Acceptance' };
const files = [{ filename: 'x.js', changes: 1, patch: '@@ -1,2 +1,2 @@\n before\n-old\n+new' }];
let current = head, posts = [], reviews = [], comments = [];
const api = { pr: () => ({ ...pr, headRefOid: current }), list: endpoint => endpoint.endsWith('/files') ? files : endpoint.endsWith('/reviews') ? reviews : comments,
  api: (endpoint, body) => { posts.push({ endpoint, body }); if (endpoint.endsWith('/reviews')) reviews.push(body); return {}; } };
const finding = { file: 'x.js', line: 2, side: 'RIGHT', severity: 'blocking', title: 'Bug', description: 'Concrete trigger and consequence' };
assertLocations([finding], files);
assert.throws(() => assertLocations([{ ...finding, line: 300 }], files), /diff/);
const deleted = { filename: 'removed.js', status: 'removed', changes: 2,
  patch: '@@ -3,2 +0,0 @@\n-first\n-second\n\\ No newline at end of file' };
const deletion = { ...finding, file: 'removed.js', line: 3, side: 'LEFT' };
assertLocations([deletion, { ...deletion, line: 4 }], [deleted]);
for (const invalid of [{ line: 2 }, { line: 5 }, { line: 3, side: 'RIGHT' }, { side: 'UNKNOWN' }, { side: undefined }])
  assert.throws(() => assertLocations([{ ...deletion, ...invalid }], [deleted]), /diff/);
const offset = [{ filename: 'offset.js', patch: '@@ -10,3 +20,3 @@\n context\n-old\n+new\n tail\n@@ -50 +70 @@\n-old\n+new' }];
assertLocations([{ ...finding, file: 'offset.js', line: 11, side: 'LEFT' },
  { ...finding, file: 'offset.js', line: 21, side: 'RIGHT' },
  { ...finding, file: 'offset.js', line: 10, side: 'LEFT' },
  { ...finding, file: 'offset.js', line: 20, side: 'RIGHT' }], offset);
for (const invalid of [{ line: 11, side: 'RIGHT' }, { line: 21, side: 'LEFT' }, { line: 30, side: 'LEFT' }])
  assert.throws(() => assertLocations([{ ...finding, file: 'offset.js', ...invalid }], offset), /diff/);
const routes = [];
const agent = async request => {
  routes.push(request.runtime);
  if (request.schema.required.includes('isReal')) return { isReal: true, reasoning: 'Confirmed caller behavior' };
  return { findings: request.prompt.includes('Lens: bugs.') ? [finding] : [] };
};
const result = await review({ cwd: '/tmp', pr: pr.url, config: { review: { runtime: 'codex', lenses: { bugs: { runtime: 'dsh' } } } }, agent, api, snapshot: false, publish: true });
assert.equal(result.approved, false); assert.equal(result.published, true);
assert.deepEqual(routes, ['dsh', 'codex', 'codex', 'codex']);
assert.equal(posts[0].body.comments[0].line, 2); assert.equal(posts[0].body.commit_id, head);
assert.equal(posts[0].body.event, 'COMMENT');
await publishReview({ api, pr, findings: result.confirmed }); assert.equal(posts.length, 1, 'identical publication is idempotent');
current = next;
await assert.rejects(publishReview({ api, pr, findings: [finding] }), /head changed/);
current = head;
await assert.rejects(review({ cwd: '/tmp', pr: pr.url, agent: async () => null, api, snapshot: false }), /expected object/);
let finishedReviewers = 0;
await assert.rejects(review({ cwd: '/tmp', pr: pr.url, agent: async request => {
  if (request.prompt.includes('Lens: bugs.')) throw new Error('reviewer failed');
  await new Promise(resolve => setTimeout(resolve, 20));
  finishedReviewers++;
  return { findings: [] };
}, api, snapshot: false }), /reviewer failed/);
assert.equal(finishedReviewers, 2, 'all concurrent reviewers finish before snapshot cleanup');
await assert.rejects(review({ cwd: '/tmp', pr: pr.url, agent: async () => ({ findings: [{ ...finding, line: 99 }] }), api, snapshot: false, source: () => 'one\ntwo\n' }), /anchor/);
await assert.rejects(publishReview({ api: { ...api, list: e => e.endsWith('/files') ? files : [], api: () => { throw new Error('GitHub failed'); } }, pr, findings: [finding] }), /GitHub failed/);
const deletedPosts = [];
const deletionApi = { ...api, list: endpoint => endpoint.endsWith('/files') ? [deleted] : [],
  api: (endpoint, body) => { deletedPosts.push({ endpoint, body }); return {}; } };
let verifiedDeletion = false;
const deletedResult = await review({ cwd: '/tmp', pr: pr.url, api: deletionApi, snapshot: false, publish: true,
  agent: async request => {
    if (request.schema.required.includes('isReal')) {
      verifiedDeletion = true; assert.match(request.prompt, /"side":"LEFT"/);
      return { isReal: true, reasoning: 'Removal breaks existing caller' };
    }
    assert(request.schema.properties.findings.items.required.includes('side'));
    return { findings: request.prompt.includes('Lens: bugs.') ? [deletion] : [] };
  } });
assert(verifiedDeletion); assert.equal(deletedResult.approved, false);
assert.equal(deletedPosts[0].body.comments[0].side, 'LEFT');
assert.equal(deletedPosts[0].body.comments[0].line, 3);
assert.match(deletedResult.blockingIssues[0], /removed.js:LEFT:3/);
// Both sides can share a numeric coordinate and title but describe different code.
const mixed = await review({ cwd: '/tmp', pr: pr.url, api, snapshot: false,
  agent: async request => request.schema.required.includes('isReal') ? { isReal: true, reasoning: 'Confirmed' }
    : { findings: request.prompt.includes('Lens: bugs.') ? [finding, { ...finding, side: 'LEFT' }] : [] } });
assert.equal(mixed.confirmed.length, 2);
const bodyPosts = [], bodyReviews = [];
const bodyApi = { ...api, list: endpoint => endpoint.endsWith('/files') ? files : endpoint.endsWith('/reviews') ? bodyReviews : [],
  api: (endpoint, body) => { bodyPosts.push({ endpoint, body }); bodyReviews.push(body); return {}; } };
const fileFinding = { ...finding, line: 4, title: 'Unchanged caller breaks' };
let fileRefuted = false;
const bodyResult = await review({ cwd: '/tmp', pr: pr.url, api: bodyApi, snapshot: false, publish: true,
  source: () => 'one\ntwo\nthree\nfour\n', agent: async request => {
    if (request.schema.required.includes('isReal')) {
      fileRefuted = true; assert.match(request.prompt, /"location":"file"/);
      return { isReal: true, reasoning: 'Confirmed caller regression' };
    }
    return { findings: request.prompt.includes('Lens: bugs.') ? [fileFinding] : [] };
  } });
assert(fileRefuted); assert.equal(bodyResult.approved, false);
assert.equal(bodyPosts[0].body.comments.length, 0);
assert.match(bodyPosts[0].body.body, /File-level finding at "x.js":4/);
assert.match(bodyPosts[0].body.body, /Confirmed caller regression/);
assert.equal(bodyResult.confirmed[0].location, 'file');
await publishReview({ api: bodyApi, pr, findings: bodyResult.confirmed, source: () => 'one\ntwo\nthree\nfour\n' });
assert.equal(bodyPosts.length, 1, 'file-level publication is idempotent');
await publishReview({ api: bodyApi, pr, findings: [...bodyResult.confirmed, finding], source: () => 'one\ntwo\nthree\nfour\n' });
assert.equal(bodyPosts[1].body.comments.length, 1, 'only the valid hunk finding is inline');
assert.equal(bodyPosts[1].body.comments[0].line, 2);
assert.throws(() => anchorFindings([fileFinding], files), /unavailable/);
assert.throws(() => anchorFindings([{ ...fileFinding, line: 0 }], files, () => 'x'), /Invalid/);
comments = [{ id: 20, body: 'root' }]; current = next;
await publishReplies({ api, pr, replies: [{ id: 20, body: 'Fixed bounds; regression test passes.' }], commit: next });
assert(posts.at(-1).endpoint.endsWith('/comments/20/replies'));
assert.match(posts.at(-1).body.body, /Commit:/);
comments.push({ id: 21, in_reply_to_id: 20, body: posts.at(-1).body.body });
const count = posts.length;
await publishReplies({ api, pr, replies: [{ id: 20, body: 'Same fix' }], commit: next }); assert.equal(posts.length, count);
await assert.rejects(publishReplies({ api, pr, replies: [{ id: 999, body: 'x' }], commit: next }), /Unknown root/);
await assert.rejects(publishReplies({ api, pr, replies: [], commit: head }), /current pushed/);
console.log('PASS independent lenses, verification, inline publication, stale heads, failed output, retries and threaded replies');
