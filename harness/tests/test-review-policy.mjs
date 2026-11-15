import assert from 'node:assert/strict';
import { admitReview, completeReview, withReviewLedger, readReviewLedger } from '../../lib/review-policy.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const h1 = 'a'.repeat(40), h2 = 'b'.repeat(40), h3 = 'c'.repeat(40), h4 = 'd'.repeat(40);
const first = admitReview({ history: [], round: 1, head: h1 });
assert.deepEqual(first, { model: 'gpt-6.1-sol', repeat: false });
let history = completeReview([], { approved: true, published: true, head: h1, confirmed: [{ severity: 'non-blocking', title: 'one' }] }, first.model);
assert.throws(() => admitReview({ history, round: 2, head: h1, previousReview: { head: h1, confirmed: history[0].findings } }), /new pushed/);
assert.throws(() => admitReview({ history, round: 2, head: h2 }), /prior findings/);
const repeat1 = admitReview({ history, round: 2, head: h2, previousReview: { head: h1, confirmed: history[0].findings } });
assert.equal(repeat1.model, 'gpt-6-luna');
history = completeReview(history, { approved: true, published: true, head: h2, confirmed: [] }, repeat1.model);
const repeat2 = admitReview({ history, round: 3, head: h3, previousReview: { head: h2, confirmed: [] } });
assert.equal(repeat2.model, 'gpt-6-luna');
history = completeReview(history, { approved: true, published: true, head: h3, confirmed: [] }, repeat2.model);
assert.throws(() => admitReview({ history: structuredClone(history), round: 4, head: h4, previousReview: { head: h3, confirmed: [] } }), /budget exhausted/);
assert.throws(() => completeReview(history, { published: false, head: h4, confirmed: [] }, repeat2.model), /missing output/);
assert.throws(() => completeReview(history, { approved: false, fatal: true, published: true, head: h4, confirmed: [] }, repeat2.model), /missing output/);
assert.equal(history.length, 3, 'interrupted review consumes no completed slot');
const repo = mkdtempSync(join(tmpdir(), 'cycler-review-ledger-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const pr = 'https://github.com/example/repo/pull/1';
  await withReviewLedger(repo, pr, async prior => ({ result: 'saved', history: completeReview(prior,
    { approved: true, published: true, head: h1, confirmed: [] }, 'gpt-6.1-sol') }));
  assert.equal(readReviewLedger(repo, pr).length, 1);
  assert.equal((await withReviewLedger(repo, pr, async prior => ({ result: prior[0].model }))), 'gpt-6.1-sol');
  assert.equal(readReviewLedger(repo, pr).length, 1, 'read-only return does not spend another slot');
} finally { rmSync(repo, { recursive: true, force: true }); }
console.log('PASS persistent review budget, head admission and interrupted-review accounting');
