// Follow-up after the run: merged PR stops the session, new human feedback resumes it, agent-written
// and old comments do not.
import assert from 'node:assert';
import { followUp, isHumanGithub, isHumanLinear } from '../../poller/followup.mjs';

let fails = 0;
const t = async (n, fn) => { try { await fn(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message); } };
const T = Date.parse('2026-09-16T12:00:00Z');
const at = (ms) => new Date(T + ms).toISOString();
const issue = (comments = []) => ({ id: 'i1', identifier: 'APL-89', comments: { nodes: comments } });
const reg = () => ({ i1: { identifier: 'APL-89', session: 's1', seenAt: T } });
const deps = (over = {}) => {
  const calls = { stop: [], resume: [], comment: [] };
  return {
    calls,
    d: {
      prFor: () => ({ number: 187, state: 'OPEN', url: 'u', comments: [] }),
      isWorking: () => false,
      resume: (s, p) => { calls.resume.push(p); return 's2'; },
      stop: (s) => calls.stop.push(s),
      comment: async (id, b) => calls.comment.push(b),
      link: (s) => `[${s}](<x>)`,
      log: () => {},
      ...over,
    },
  };
};

await t('a merged PR stops the session and drops the issue', async () => {
  const { d, calls } = deps({ prFor: () => ({ number: 187, state: 'MERGED', comments: [] }) });
  const next = await followUp([issue()], reg(), d, T + 10);
  assert.deepStrictEqual(calls.stop, ['s1']);
  assert.strictEqual(next.i1, undefined);
});
await t('a new human review comment resumes the session and moves the record to the new id', async () => {
  const c = { user: { login: 'mikhailkogan17' }, created_at: at(5), body: 'rename this', html_url: 'https://gh/c1' };
  const { d, calls } = deps({ prFor: () => ({ number: 187, state: 'OPEN', comments: [c] }) });
  const next = await followUp([issue()], reg(), d, T + 10);
  assert.match(calls.resume[0], /https:\/\/gh\/c1/);
  assert.strictEqual(next.i1.session, 's2');
  assert.strictEqual(next.i1.seenAt, T + 10);
  assert.match(calls.comment[0], /^Resumed by cycler for new review comments — session \[s2\]/);
});
await t('a busy session is not resumed and the feedback stays unread for next poll', async () => {
  const c = { user: { login: 'h' }, created_at: at(5), body: 'x' };
  const { d, calls } = deps({ isWorking: () => true, prFor: () => ({ number: 1, state: 'OPEN', comments: [c] }) });
  const next = await followUp([issue()], reg(), d, T + 10);
  assert.strictEqual(calls.resume.length, 0);
  assert.strictEqual(next.i1.seenAt, T);
});
await t('a human Linear comment resumes; the app\'s own does not', async () => {
  const { d, calls } = deps();
  await followUp([issue([{ createdAt: at(5), body: 'B', user: { id: 'u' }, botActor: null }])], reg(), d, T + 10);
  assert.strictEqual(calls.resume.length, 1);
  assert.strictEqual(isHumanLinear({ createdAt: at(5), user: null, botActor: { id: 'b' } }, T), false);
});
await t('agent-written, bot and old GitHub comments are ignored', () => {
  assert.strictEqual(isHumanGithub({ user: { login: 'me' }, created_at: at(5), body: 'x\n🤖 Generated with [Claude Code](y)' }, T), false);
  assert.strictEqual(isHumanGithub({ user: { login: 'linear-code' }, created_at: at(5), body: 'x' }, T), false);
  assert.strictEqual(isHumanGithub({ user: { login: 'dep[bot]' }, created_at: at(5), body: 'x' }, T), false);
  assert.strictEqual(isHumanGithub({ user: { login: 'me' }, created_at: at(-5), body: 'x' }, T), false);
  assert.strictEqual(isHumanGithub({ author: { login: 'me' }, submittedAt: at(5), body: 'fix' }, T), true);
});
await t('a failed resume keeps the record for the next poll', async () => {
  const c = { user: { login: 'h' }, created_at: at(5), body: 'x' };
  const { d } = deps({ resume: () => { throw new Error('boom'); }, prFor: () => ({ number: 1, state: 'OPEN', comments: [c] }) });
  const next = await followUp([issue()], reg(), d, T + 10);
  assert.deepStrictEqual(next.i1, reg().i1);
});

if (fails) { console.log(`${fails} failed`); process.exit(1); }
