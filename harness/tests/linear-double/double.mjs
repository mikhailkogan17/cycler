// A Linear API double for the poller.
//
// Spec 001 marks ~17 assertions "untested: needs a Linear API double". This is that double. It is
// deliberately NOT a mock of the poller's internals — it replaces `fetch` only, so the poller runs
// its real entry path: token load, viewer query, delegate filter, routing, spawn, comment, state
// write. Everything the poller does above the wire is exercised for real.
//
// Loaded with `node --import`, so the poller under test is the shipped file, unmodified.
import { readFileSync, appendFileSync } from 'node:fs';

const SCRIPT = JSON.parse(readFileSync(process.env.DOUBLE_SCRIPT, 'utf8'));
const JOURNAL = process.env.DOUBLE_JOURNAL;
const record = (entry) => appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');

let tokenCalls = 0;
let graphqlCalls = 0;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body;

  if (u.includes('/oauth/token')) {
    const params = Object.fromEntries(new URLSearchParams(String(body)));
    record({ kind: 'oauth', grant_type: params.grant_type, sent_refresh_token: params.refresh_token });
    tokenCalls++;
    const r = SCRIPT.tokenResponses?.[tokenCalls - 1] ?? { access_token: 'refreshed-token', expires_in: 86399 };
    return { ok: true, json: async () => r };
  }

  if (u.includes('/graphql')) {
    const payload = JSON.parse(String(body));
    const auth = init.headers?.Authorization || '';
    graphqlCalls++;
    const isViewer = /viewer\s*\{\s*id/.test(payload.query);
    const isIssues = /issues\s*\(/.test(payload.query);
    const isComment = /commentCreate/.test(payload.query);

    record({
      kind: 'graphql',
      op: isViewer ? 'viewer' : isIssues ? 'issues' : isComment ? 'comment' : 'other',
      auth,
      query: payload.query,
      variables: payload.variables,
    });

    // Scripted auth failures, so the refresh-and-retry path (spec 1.4/1.5) is reachable.
    const failN = SCRIPT.authErrorOnCalls || [];
    if (failN.includes(graphqlCalls)) {
      return { ok: true, json: async () => ({ errors: [{ extensions: { type: 'AUTHENTICATION_ERROR' } }] }) };
    }
    if (isViewer) return { ok: true, json: async () => ({ data: { viewer: { id: SCRIPT.viewerId || 'viewer-1' } } }) };
    if (isIssues) return { ok: true, json: async () => ({ data: { issues: { nodes: SCRIPT.issues || [] } } }) };
    if (isComment) {
      if (SCRIPT.commentFails) return { ok: true, json: async () => ({ errors: [{ message: 'comment refused' }] }) };
      return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
    }
    return { ok: true, json: async () => ({ data: {} }) };
  }

  throw new Error('double: unexpected fetch to ' + u);
};
