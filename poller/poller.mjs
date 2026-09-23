#!/usr/bin/env node
/**
 * cycler/poller — a dummy Linear "agent" named Claude, polled from your own machine.
 *
 * Polls Linear for issues delegated to the "Claude" OAuth app and, for each
 * new one, starts a background Claude Code session inside REPO_PATH:
 *   claude --background --name "[<KEY>] <title>" --remote-control "<same>"
 *          --permission-mode auto --append-system-prompt "..." "/start <KEY>"
 * (--print must NOT be passed: it conflicts with --background and exits 1.)
 * then posts a confirmation comment (with the bg session id) and remembers it.
 *
 * Credentials, repo, dispatch command and workflows all come from ONE file:
 * ~/.config/cycler/config.yaml (see cycler.example.yaml).
 *
 * One-time setup:
 *   1. Linear → Settings → API → Applications → New application
 *      - Name: Claude   (this is how the agent appears in Linear)
 *      - Callback URL: http://localhost:8787/callback
 *      - Webhooks: NOT needed
 *   2. /cycler:start writes ~/.config/cycler/config.yaml, including linear.client_id/client_secret
 *   3. node poller/poller.mjs auth     # browser opens; approve; token saved
 *   4. /cycler:start also loads the launchd job that runs this every 180s
 *
 * ~/.cycler/ holds no config — only state this poller WRITES: token.json, processed.json and the
 * launchd logs. Re-dispatch an issue by removing its id from ~/.cycler/processed.json.
 * Re-auth (if token revoked): run the `auth` subcommand again.
 * Config edits: take effect on the next launchd run (every 180s); force now with
 *   launchctl kickstart -k gui/$(id -u)/<launchd.label>
 */

import { spawn, exec, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig, configPath, pick } from '../lib/yaml.mjs';
import { followUp } from './followup.mjs';

// State, not config: everything in here is written by this process. The config lives in
// ~/.config/cycler/config.yaml and is never written to.
const DIR = process.env.CYCLER_HOME || join(homedir(), '.cycler');
const TOKEN_PATH = join(DIR, 'token.json');
const STATE_PATH = join(DIR, 'processed.json');
// Dispatch records awaiting proof of life. See checkLiveness().
const PENDING_PATH = join(DIR, 'pending.json');
// Sessions confirmed alive, kept until they leave the busy state. See "The usage-limit cooldown".
const RUNNING_PATH = join(DIR, 'running.json');
// When the account's usage window is known to be spent, and why.
const COOLDOWN_PATH = join(DIR, 'cooldown.json');
// Sessions the usage limit killed, parked until the window reopens. See resumeAfterLimit().
const RESUME_PATH = join(DIR, 'resume.json');
// The last credential expiry the poller has already reported as near. Exists only so the
// "expiring" notice is logged once per episode instead of on every poll: the message describes a
// self-healing state, and 1081 repetitions of it in poller.log trained a reader to treat a real
// notice as noise (and to go re-login, which never was the fix).
const CRED_NOTICE_PATH = join(DIR, 'cred-notice.json');
// issueId → the session that owns it and when its feedback was last read. See followup.mjs.
const FOLLOW_PATH = join(DIR, 'follow.json');

const REDIRECT_URI = 'http://localhost:8787/callback';
const SCOPES = 'read,write,app:assignable,app:mentionable';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'; // use absolute path under launchd
// The config file is the source of truth for everything below; the env vars stay as overrides
// because launchd is easier to debug when you can force one value without editing a file.
const ycfg = readConfig();
const cfg = (dotted) => dotted.split('.').reduce((cur, k) => pick(cur, k), ycfg);
const expand = (v) => String(v).replace(/^~(?=$|\/)/, homedir());
const REPO_PATH = expand(process.env.REPO_PATH || cfg('repo.path') || '~/your-repo');
const prepend = cfg('dispatch.path_prepend');
const PATH_PREPEND = (Array.isArray(prepend) && prepend.length
  ? prepend
  : ['~/.local/bin', '~/bin', '/opt/homebrew/bin', '/usr/local/bin']).map(expand);
// /workflow-feature runs the contract -> implement -> audit -> gate -> PR workflow. Measured against running the
// harness inline in one long-lived session on the same issue and contract: 1.68M subagent tokens and a
// merged PR, versus 10.77M and nothing shipped. There is no /start command in this repo — dispatching
// it sent the session a literal string with no skill behind it.
const WORKFLOW = process.env.CYCLER_WORKFLOW || cfg('workflows.default') || '/cycler:workflow-feature';
const MAX_PER_POLL = 50;
const BRANCH_PREFIX = cfg('repo.branch_prefix') || 'claude/';
// How long a dispatched session gets to post its start marker before it is declared dead, and how
// many times an issue is re-dispatched before the poller stops trying. Both are config keys because
// "how slow is a cold start here" is a machine fact, not a universal one. Read through cfg() like
// everything else: a key spelled startGraceSeconds must not read as ABSENT and silently restore the
// default, which is how a repo with a slow cold start gets duplicate sessions it explicitly configured
// against.
const START_GRACE_MS = Number(cfg('dispatch.start_grace_seconds') ?? 300) * 1000;
const MAX_DISPATCH_ATTEMPTS = Number(cfg('dispatch.max_attempts') ?? 3);
// How many dispatched sessions may run AT ONCE. See "Concurrency" below for why the default is 1.
const MAX_CONCURRENT = Number(cfg('dispatch.max_concurrent') ?? 1);
// Fallback hold when a limit message parses as a limit but its reset time does not parse, and the
// ceiling that no parsed reset may exceed. The ceiling is not paranoia: a misread "resets 9am" that
// landed a year out would stall the queue silently, which is the one outcome worse than the burn.
const COOLDOWN_FALLBACK_MS = Number(cfg('dispatch.cooldown_fallback_minutes') ?? 60) * 60_000;
const COOLDOWN_CEILING_MS = 6 * 60 * 60_000;

// Route by label, per harness/ROUTING.md. Until this existed the poller dispatched /workflow-feature for
// EVERYTHING, so that table was advice the only automated path ignored — a Research issue got a
// contract-and-gate run for work that produces no diff, and a Harness issue got an implementer that
// is forbidden `.claude/**` and therefore cannot pass its own audit.
//
// `workflows:` is a map from Linear LABEL to workflow, plus the reserved key `default`. It used to be
// `routes.byLabel`, a list of {label, workflow, why} — three keys and a nesting level to say what
// `research: /cycler:workflow-research` says on one line.
//
// Deliberately a lookup on a label a human already wrote, not a classifier. A model here would infer,
// less reliably, something already recorded — and a router that picks /workflow-feature for everything is
// indistinguishable from a working one until something audits its choices.
//
// CYCLER_WORKFLOW still overrides everything, for a one-off or a bisect.
const wfMap = cfg('workflows');
const configured = Object.entries(wfMap && typeof wfMap === 'object' && !Array.isArray(wfMap) ? wfMap : {})
  .filter(([label, workflow]) => label.toLowerCase() !== 'default' && typeof workflow === 'string')
  .map(([label, workflow]) => [label.toLowerCase(), workflow]);
// Order is the file's own order — the parser preserves it — so the first matching label wins and a
// user can express precedence by moving a line.
const ROUTES = configured.length ? configured : [['research', '/cycler:workflow-research']];
function workflowFor(issue) {
  if (process.env.CYCLER_WORKFLOW) return { workflow: WORKFLOW, why: 'CYCLER_WORKFLOW override' };
  const labels = (issue.labels?.nodes || []).map((l) => String(l.name || '').toLowerCase());
  for (const [label, workflow] of ROUTES) {
    if (labels.includes(label)) return { workflow, why: `label "${label}"` };
  }
  return { workflow: WORKFLOW, why: 'no routing label — the default implement-and-gate path' };
}

mkdirSync(DIR, { recursive: true });

// Every line is timestamped and goes to poller.log via launchd. When a dispatch fails at 4am the
// only evidence is this file, so it logs the decision as well as the outcome.
function log(...a) { console.log(new Date().toISOString(), ...a); }
function logErr(...a) { console.error(new Date().toISOString(), ...a); }

// Board comments become phone notifications, so a timestamp in them has to be readable at a
// glance: an ISO string in UTC is neither local nor scannable. Date only when it is not today.
function localTime(d, now = new Date()) {
  const sameDay = d.toDateString() === now.toDateString();
  return d.toLocaleString(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

// The OAuth application's credentials, from the one config file. Not a personal API key: a personal
// key acts as YOU, and an issue cannot be delegated to a person the way it is delegated to an agent.
// `actor=app` is what makes "Claude" a name on the board, and it is what the delegate filter matches.
function linearApp() {
  return { clientId: cfg('linear.client_id'), clientSecret: cfg('linear.client_secret') };
}

/**
 * Linear OAuth access tokens last 24h (`expires_in: 86399`). Without a refresh the poller silently
 * stops dispatching a day after `auth`, and the symptom is a 401 that reads like a network fault —
 * it cost most of a week of debugging on the previous orchestrator before the expiry was noticed.
 * The refresh token is long-lived, so one retry on 401 keeps this running indefinitely.
 */
async function refreshToken() {
  const { clientId, clientSecret } = linearApp();
  const tok = loadJson(TOKEN_PATH, {});
  if (!clientId || !clientSecret || !tok.refresh_token) return false;
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tok.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) return false;
  // Merge: a refresh response may omit refresh_token, and dropping it would make the NEXT refresh
  // impossible — turning a self-healing poller into one that dies 24h later.
  // 0600 to match poller/lin, which already chmods it. writeFileSync's default is 0644, so a
  // token first written here was world-readable until something else happened to tighten it.
  writeFileSync(TOKEN_PATH, JSON.stringify({ ...tok, ...data }, null, 2), { mode: 0o600 });
  log('token refreshed (expires_in', data.expires_in, 's)');
  return true;
}

async function gqlOnce(query, variables) {
  const { access_token } = loadJson(TOKEN_PATH, {});
  if (!access_token) throw new Error('No token. Run: /cycler:start (or: node poller/poller.mjs auth)');
  // A dropped connection, a 429 or a 5xx is transient. Retried in-process with backoff so one blip does
  // not cost a whole 180s poll; after the last attempt it throws and the next poll starts over.
  let lastErr;
  for (let attempt = 0; attempt < GQL_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, lastErr.waitMs));
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
        body: JSON.stringify({ query, variables }),
      });
      const http = res['status'];
      if (http === 429 || http >= 500) {
        const after = Number(res.headers.get('retry-after'));
        lastErr = new Error(`Linear HTTP ${http}`);
        lastErr.waitMs = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt, 30_000);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      lastErr.waitMs = 2000 * 2 ** attempt;
    }
  }
  throw lastErr;
}
const GQL_ATTEMPTS = 4;

async function gql(query, variables = {}, retried = false) {
  const json = await gqlOnce(query, variables);
  if (json.errors) {
    const auth = JSON.stringify(json.errors).includes('AUTHENTICATION_ERROR');
    if (auth && !retried && (await refreshToken())) return gql(query, variables, true);
    throw new Error(JSON.stringify(json.errors));
  }
  return json.data;
}

async function auth() {
  const { clientId, clientSecret } = linearApp();
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing linear.client_id / linear.client_secret in ${configPath() || '~/.config/cycler/config.yaml'}`);
  }
  // A real nonce, and one that is actually checked below. This used to be the constant string
  // 'cycler', with the callback reading only `code` — so it was neither a nonce nor verified, while
  // the comment claimed CSRF protection. While the flow is open, localhost:8787 accepts a request
  // from any page the browser is on, so an unchecked callback lets an attacker's `code` be exchanged
  // and stored: the poller ends up holding a token for the ATTACKER's workspace, and every issue it
  // then dispatches comes from a board they control. The window is short; the consequence is not.
  const state = randomBytes(16).toString('hex');
  const url =
    'https://linear.app/oauth/authorize' +
    `?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    '&response_type=code' +
    `&scope=${encodeURIComponent(SCOPES)}` +
    '&actor=app' + // app acts as itself ("Claude"), not as you
    `&state=${state}`;

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost:8787');
    if (u.pathname !== '/callback') { res.end('ignored'); return; }
    try {
      // Constant-time, and length-checked first: timingSafeEqual throws on a length mismatch.
      const got = Buffer.from(u.searchParams.get('state') || '');
      const want = Buffer.from(state);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        throw new Error('state mismatch — this callback did not come from the authorisation this process started');
      }
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        code: u.searchParams.get('code'),
      });
      const r = await fetch('https://api.linear.app/oauth/token', { method: 'POST', body });
      const data = await r.json();
      if (!data.access_token) throw new Error(JSON.stringify(data));
      writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
      res.end('Claude installed in your workspace. You can close this tab.');
      console.log('Token saved to', TOKEN_PATH);
    } catch (err) {
      res.end('Auth failed: ' + err.message);
      console.error(err);
    } finally {
      server.close();
      process.exit(0);
    }
  });
  server.listen(8787, () => {
    console.log('Authorize Claude:', url);
    // CYCLER_NO_BROWSER exists so the flow can be driven without a browser — by a test, and by anyone
    // running setup over ssh, where `open` puts the page on the wrong machine.
    if (!process.env.CYCLER_NO_BROWSER) exec(`open "${url}"`); // macOS
  });
}

async function comment(issueId, body) {
  return gql(
    `mutation ($issueId: String!, $body: String!) {
       commentCreate(input: { issueId: $issueId, body: $body }) { success }
     }`,
    { issueId, body }
  );
}

// The dispatch command, as a template. Placeholders: {workflow} {issue} {title} {url} {session}.
// Split like a shell would, but WITHOUT a shell — issue titles contain quotes, backticks and $, and
// handing those to `sh -c` is both a quoting bug and an injection surface. Quoted segments are kept
// whole and placeholders are substituted AFTER splitting, so a title can never introduce an argument.
const DEFAULT_DISPATCH =
  'claude --background --name "{session}" --remote-control "{session}" ' +
  '--remote-control-session-name-prefix linear --permission-mode auto ' +
  '--append-system-prompt "Started by cycler for {issue}" "{workflow} {issue}"';

function splitCommand(tpl) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(tpl)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function buildDispatchArgv(issue, workflow, sessionName) {
  const tpl = cfg('dispatch.command') || DEFAULT_DISPATCH;
  const vars = {
    workflow,
    issue: issue.identifier,
    title: issue.title || '',
    url: issue.url || '',
    session: sessionName,
  };
  const argv = splitCommand(tpl).map((tok) =>
    tok.replace(/\{(workflow|issue|title|url|session)\}/g, (_, k) => vars[k] ?? '')
  );
  // The binary stays separately overridable: launchd needs an ABSOLUTE path, and that is a machine
  // fact rather than a project one.
  if (argv[0] === 'claude') argv[0] = CLAUDE_BIN;
  return argv;
}

async function dispatch(issue) {
  const sessionName = `[${issue.identifier}] ${issue.title}`.slice(0, 80);
  const { workflow, why } = workflowFor(issue);
  log(`routing ${issue.identifier} -> ${workflow} (${why})`);
  // The whole command is configurable (config: dispatch.command). The default is the one that
  // works: --print must NOT appear alongside --background — they conflict and claude exits 1, which
  // looks exactly like "the agent never saw the issue".
  const argv = buildDispatchArgv(issue, workflow, sessionName);
  const child = spawn(
    argv[0],
    argv.slice(1),
    {
      cwd: REPO_PATH,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // launchd gives a job a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). The spawned session
      // inherits it, so `linear`, `lin`, `node`, `gh` and every brew binary are missing and the run
      // stalls asking a human where to fix it. An interactive session never sees this because the
      // shell's PATH is already right — which is why it only shows up once dispatch is automated.
      env: {
        ...process.env,
        PATH: [
          ...PATH_PREPEND,
          process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        ].join(':'),
      },
    }
  );
  const printedSessionId = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let spawned = false;
    const t = setTimeout(() => resolve(null), 20_000); // --background should return at once
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('spawn', () => { spawned = true; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(t);
      if (!spawned) return reject(new Error('spawn failed'));
      if (code) return reject(new Error(`claude exited ${code}: ${err.trim().split('\n')[0] || out.trim().split('\n')[0] || 'no output'}`));
      // "backgrounded · 8095f69f · [APL-16] title" — the last stdout line is a hint list, not the id.
      const m = out.match(/backgrounded\s+·\s+(\S+)/);
      resolve(m ? m[1] : null);
    });
  });
  child.unref();
  // Fall back to the registry when stdout did not yield an id. Failing to resolve it is survivable —
  // liveness still proves the run started off the Linear start marker, which needs no session id —
  // so this never throws, it just leaves `session` null as before.
  let sessionId = printedSessionId;
  if (!sessionId) {
    try {
      sessionId = findSessionByKey(issue.identifier);
      if (sessionId) log(`dispatched ${issue.identifier} printed no session id — resolved ${sessionId} from the registry`);
    } catch (err) {
      logErr(`could not resolve a session id for ${issue.identifier} from the registry: ${err.message}`);
    }
  }
  log(`dispatched ${issue.identifier} workflow=${workflow} session=${sessionId || 'unknown'}`);
  if (sessionId) follow(issue.id, issue.identifier, sessionId);
  // Record it as UNPROVEN. checkLiveness() on a later poll decides whether this session ever ran.
  // Written before the announcement comment on purpose: a dispatch that is announced but not tracked
  // is exactly the silent failure this whole mechanism exists to end.
  try {
    const pending = loadJson(PENDING_PATH, []).filter((r) => r.issueId !== issue.id);
    pending.push({
      issueId: issue.id,
      identifier: issue.identifier,
      workflow,
      session: sessionId,
      at: Date.now(),
      attempts: carryAttempts.get(issue.id) || 1,
    });
    writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
  } catch (err) {
    logErr(`dispatched ${issue.identifier} but could not record it as pending: ${err.message}`);
  }
  // The session is already running. A failure to ANNOUNCE it must not be reported as a failure to
  // dispatch it: the caller marks an issue processed only when dispatch() resolves, so throwing here
  // leaves a live session with the issue still unprocessed, and the next poll (180s) spawns a SECOND
  // session on the same issue and the same branch. A missing comment is cosmetic; two concurrent runs
  // on one branch is the corruption the one-tree-one-run rule exists to prevent.
  try {
    await comment(
      issue.id,
      // One line. These land as phone notifications, and a paragraph of route explanation and
      // attach commands is unreadable there — the id is the only part anyone acts on.
      `Dispatched to \`claude\` session ${sessionLink(sessionId)}.`
    );
  } catch (err) {
    logErr(`dispatched ${issue.identifier} but could not comment: ${err.message}`);
  }
}

// Spawning a session is not the same as the session running.
//
// dispatch() resolves as soon as `claude --background` prints an id, and the caller marks the issue
// processed on that. But a session can die on its first turn — an expired Claude Code login does
// exactly this, in under a second — and from the board that is indistinguishable from a healthy run
// that has not commented yet. Four consecutive APL-60 dispatches died this way and all four were
// recorded as successful. The failure comment that exists for a failed SPAWN had no counterpart for
// a failed START.
//
// The proof of life is the session's own transcript: a real model reply after dispatch. It used to be a
// start comment every routable skill posted
// as its first act (skills/workflow-feature step 3, skills/workflow-research step 1b). It is checked here, on a LATER
// poll, because the check has to outlive the poll that dispatched: asking immediately would only ever
// see a session that has not got there yet.
//
// Returns what it found, for the poll's outcome line: `dead` (retried or given up) and `authDead`
// (died logged out — not retried at all, see classifyAuthFailure).
async function checkLiveness(readAgentsRaw = defaultAgentsRead, readTranscript = defaultTranscriptRead,
  readCred = defaultCredentialRead) {
  const found = { dead: [], authDead: [] };
  const pending = loadJson(PENDING_PATH, []);
  if (!pending.length) return found;
  const now = Date.now();
  const due = pending.filter((r) => now - r.at >= START_GRACE_MS);
  if (!due.length) return found;

  const processed = new Set(loadJson(STATE_PATH, []));
  const keep = pending.filter((r) => now - r.at < START_GRACE_MS);
  let stateChanged = false;
  // Could not tell either way: keep waiting rather than declare a live run dead — a false "dead"
  // costs a duplicate session on the same branch, which is the one thing worse than silence.
  const agents = readAgents(readAgentsRaw);
  if (agents === null) {
    logErr('liveness check skipped: the session registry is unreadable');
    writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
    return found;
  }

  for (const rec of due) {
    const agent = agentFor(rec, agents);
    let transcript = '';
    if (agent) { try { transcript = readTranscript({ session: String(agent.id) }, agent); } catch { transcript = ''; } }
    // Before the liveness verdict: a session that died logged out is dead whatever else the registry
    // says, and re-dispatching it only starts another session on the same dead credential. So no
    // retry and no attempt spent — the pending record is dropped and the issue un-processed, so it
    // goes out cleanly on the first poll after a login, which the hold below waits for.
    const authReason = classifyAuthFailure(transcript, rec.at);
    if (authReason) {
      found.authDead.push({ identifier: rec.identifier, reason: authReason });
      logErr(`dead dispatch: ${rec.identifier} session=${rec.session || 'unknown'} died logged out `
        + `("${authReason}") — not retrying; run /login`);
      try {
        writeFileSync(AUTH_HOLD_PATH, JSON.stringify(
          { expiresAt: readClaudeExpiry(readCred), reason: authReason, identifier: rec.identifier, at: now }, null, 2));
      } catch (err) {
        logErr(`  and could not record the auth hold: ${err.message}`);
      }
      // No notification here: the hold makes this same poll's pre-flight refuse, and that notifies.
      try {
        await comment(rec.issueId,
          `🔑 Session ${sessionLink(rec.session)} died logged out (${authReason}). Not retrying — `
            + `run \`/login\`; it goes out again on the next poll.`);
      } catch (err) {
        logErr(`  and could not comment: ${err.message}`);
      }
      processed.delete(rec.issueId);
      stateChanged = true;
      continue;
    }
    const verdict = livenessVerdict(agent, transcript, rec.at);
    if (verdict === 'unknown') { keep.push(rec); continue; }
    if (verdict === 'alive') {
      if (agent && agent.id) rec.session = String(agent.id);
      log(`liveness ok: ${rec.identifier} session=${rec.session || 'unknown'} started`);
      // Confirmed alive, so this record's job here is done — but the session now has to be watched
      // for how it ENDS, which is a different question and a much later one. See reviewRunning().
      if (rec.session) {
        try {
          const watched = loadJson(RUNNING_PATH, []).filter((r) => r.session !== rec.session);
          // issueId and workflow ride along because a session killed by the usage limit has to be
          // RE-DISPATCHED once the window resets, and re-dispatching means deleting the issue from
          // processed.json — which needs the issue's id, not its key. Watching without them is how
          // APL-79 and APL-67 were each recorded as "ended on the usage limit" and then silently
          // abandoned: the cooldown held the queue correctly and the queue had nothing left in it.
          watched.push({
            session: rec.session,
            issueId: rec.issueId,
            identifier: rec.identifier,
            workflow: rec.workflow,
            attempts: rec.attempts || 1,
            at: Date.now(),
          });
          writeFileSync(RUNNING_PATH, JSON.stringify(watched, null, 2));
        } catch (err) {
          logErr(`could not watch ${rec.identifier} for a usage limit: ${err.message}`);
        }
      }
      continue;
    }

    const attempts = (rec.attempts || 1);
    const giveUp = attempts >= MAX_DISPATCH_ATTEMPTS;
    found.dead.push({ identifier: rec.identifier, giveUp });
    logErr(
      `dead dispatch: ${rec.identifier} session=${rec.session || 'unknown'} never replied ` +
        `within ${START_GRACE_MS / 1000}s (attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS})`
    );
    try {
      await comment(
        rec.issueId,
        `${giveUp ? '💀 ' : ''}Session ${sessionLink(rec.session)} died without starting. `
          + (giveUp ? `Giving up (${attempts}/${MAX_DISPATCH_ATTEMPTS}).` : `Retrying (${attempts + 1}/${MAX_DISPATCH_ATTEMPTS}).`)
      );
    } catch (err) {
      logErr(`  and could not comment: ${err.message}`);
    }

    if (!giveUp) {
      // Un-process it so the next poll dispatches again. The attempt count rides on the pending
      // record that dispatch() will write, via carryAttempts.
      processed.delete(rec.issueId);
      stateChanged = true;
      carryAttempts.set(rec.issueId, attempts + 1);
    }
  }

  if (stateChanged) writeFileSync(STATE_PATH, JSON.stringify([...processed], null, 2));
  writeFileSync(PENDING_PATH, JSON.stringify(keep, null, 2));
  return found;
}

// The session a pending record refers to: by id, else the newest `[KEY]`-named one (dispatch may
// not have printed an id).
function agentFor(rec, agents) {
  if (rec.session) {
    const byId = agents.find((a) => a && (String(a.id || '') === rec.session || a.sessionId === rec.session));
    if (byId) return byId;
  }
  return agents
    .filter((a) => a && String(a.name || '').startsWith(`[${rec.identifier}]`))
    .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))[0] || null;
}

// Did the dispatched session actually run? Answered from the session's own transcript, not from
// Linear: no comment, label or emoji can fake it.
//   alive   — a real model reply (or a usage-limit stop, which the watchdog handles) after dispatch
//   dead    — the session is gone, or all it produced after dispatch were API errors (expired login)
//   unknown — it exists and has not replied yet: keep waiting
function livenessVerdict(agent, transcript, sinceMs = 0) {
  if (!agent) return 'dead';
  let reply = false;
  let apiError = false;
  for (const line of String(transcript || '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'assistant' || e.isSidechain) continue;
    if ((Date.parse(e.timestamp) || 0) < sinceMs) continue;
    if (!e.isApiErrorMessage || LIMIT_RE.test(entryText(e))) reply = true; else apiError = true;
  }
  if (reply) return 'alive';
  if (apiError || AGENT_GONE_STATES.has(agentState(agent))) return 'dead';
  return 'unknown';
}

// ── The refresh race ─────────────────────────────────────────────────────────────────────────
// The Claude Code CLI holds an OAuth access token that lives 8 hours behind a refresh token that
// ROTATES: spending it invalidates it. Two sessions started seconds apart against an already
// expired access token both try to refresh; one wins, and the loser presents a refresh token that
// has already been consumed. The CLI reports that as "OAuth session expired and could not be
// refreshed" — which names the wrong cause — and the session dies on its first turn. From the
// board that is a dispatch which spawned and then went silent.
//
// APL-74 and APL-78 died exactly that way, three attempts each, always within three seconds of
// each other, because dispatch() awaits only the SPAWN: poll() starts every due issue and they
// then run concurrently.
//
// The fix is to guarantee that only ONE process ever performs a refresh. A fresh access token
// means nobody needs to refresh and any number of sessions may start together; a stale one means
// exactly one issue goes out this poll, it refreshes, and the next poll (180s) finds the
// credential fresh and releases the rest. The expiry is read from the local keychain, so this
// costs no network call and no inference call — the poller still makes one outbound request per
// poll, which is the claim the README makes.
const CRED_SERVICE = 'Claude Code-credentials';
const CRED_FILE = join(homedir(), '.claude', '.credentials.json');
const REFRESH_SKEW_MS = 60_000;

// Keychain first: that is where the CLI puts it on macOS. The file is the fallback the CLI uses
// where there is no keychain, and reading it costs nothing when it is absent.
// CYCLER_CREDENTIALS_FILE replaces both, for tests: the pre-flight refuses on an unreadable
// credential, so a poller driven from a test needs one it can read without touching the keychain.
function defaultCredentialRead() {
  if (process.env.CYCLER_CREDENTIALS_FILE) {
    try { return readFileSync(process.env.CYCLER_CREDENTIALS_FILE, 'utf8'); } catch { return null; }
  }
  try {
    return execFileSync('security', ['find-generic-password', '-s', CRED_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return existsSync(CRED_FILE) ? readFileSync(CRED_FILE, 'utf8') : null;
  }
}

// The expiries only — never the token values, which nothing here needs and nothing here may log.
function readClaudeCredential(read = defaultCredentialRead) {
  try {
    const raw = read();
    if (!raw) return null;
    const o = JSON.parse(raw).claudeAiOauth;
    if (!o || typeof o !== 'object') return null;
    const num = (v) => (Number.isFinite(v) ? v : null);
    return { expiresAt: num(o.expiresAt), refreshExpiresAt: num(o.refreshTokenExpiresAt), hasRefresh: Boolean(o.refreshToken) };
  } catch {
    return null;
  }
}

function readClaudeExpiry(read = defaultCredentialRead) {
  const cred = readClaudeCredential(read);
  return cred ? cred.expiresAt : null;
}

// Anything before this is not an expiry, it is a field that failed to be one: epoch zero is what the
// keychain held on 2026-09-23 after a session exited mid-refresh, and a seconds-for-milliseconds
// value lands in 1970 too.
const PLAUSIBLE_EXPIRY_MS = Date.UTC(2020, 0, 1);

// ── Pre-flight ───────────────────────────────────────────────────────────────────────────────
// Whether this poll may dispatch at all, and how many. It used to fail OPEN on an unreadable
// credential, on the theory that a keychain launchd cannot read should not stall the queue. The
// launchd log settles that: this process reads the keychain on every poll. And the one time the read
// came back unusable — `expiresAt: 0` after a session exited mid-refresh, 2026-09-23 — the account
// WAS logged out, and failing open sent six sessions to die on "Login expired · Please run /login"
// while every poll logged `poll ok`. So "cannot tell" now means "not safe".
//
// An expired ACCESS token is still not a refusal. It lasts 8 hours and the CLI renews it from the
// refresh token on the next session it starts — APL-97 and APL-98 went out on 2026-09-16 against an
// access token 13 hours stale and both ran. Refusing there would stall the queue every night until
// someone ran /login, which was never the fix. What decides "logged out" is the REFRESH token: missing,
// expired, or unknown means no session can renew anything, and that is a refusal. With it valid, one
// issue goes out so exactly one process performs the refresh (see "The refresh race").
//
// `hold` is the credential a dispatched session already died of (see classifyAuthFailure). While the
// keychain still holds that same credential, dispatching again is the burn this exists to stop; a
// /login or a refresh by anyone changes expiresAt and lifts it.
//
// Returns { budget } or { budget: 0, refuse }. `refuse` is the one-line reason for the log.
function credentialPreflight(cred, now = Date.now(), skewMs = REFRESH_SKEW_MS, hold = null) {
  const at = cred && cred.expiresAt;
  if (!Number.isFinite(at) || at < PLAUSIBLE_EXPIRY_MS) {
    return { budget: 0, refuse: `claude credential expiry is unreadable (${Number.isFinite(at) ? new Date(at).toISOString() : at == null ? 'missing' : String(at)})` };
  }
  if (hold && hold.expiresAt === at) {
    return { budget: 0, refuse: `a dispatched session died logged out (${hold.reason}) and the credential has not changed since` };
  }
  if (dispatchBudget(at, now, skewMs) === Infinity) return { budget: Infinity };
  const r = cred.refreshExpiresAt;
  if (!cred.hasRefresh || !Number.isFinite(r) || r - now <= skewMs) {
    const why = !cred.hasRefresh ? 'no refresh token' : !Number.isFinite(r) ? 'refresh token expiry unknown' : 'refresh token expired';
    return { budget: 0, refuse: `claude access token expired ${new Date(at).toISOString()} and cannot be renewed (${why})` };
  }
  return { budget: 1 };
}

// The access-token half, kept as its own function because the refresh race is its own rule.
function dispatchBudget(expiresAt, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!Number.isFinite(expiresAt)) return 0;
  return expiresAt - now > skewMs ? Infinity : 1;
}

// A session that died logged out. Kept until the credential changes, so no poll re-dispatches onto
// the same dead login. See credentialPreflight().
const AUTH_HOLD_PATH = join(DIR, 'auth-hold.json');

// ── Terminal auth failures ───────────────────────────────────────────────────────────────────
// What the CLI writes into a session's transcript when it cannot authenticate, as a synthetic
// assistant entry with isApiErrorMessage set. The three observed on 2026-09-23:
//   "Login expired · Please run /login"                          (error: authentication_failed)
//   "Could not refresh your login because another Claude Code process is refreshing it (or exited
//    mid-refresh) · Try again in a minute; …"                      (error: server_error)
// Retrying either is pointless: the credential is the problem, not the session, and a fresh session
// reads the same credential. Only API-error entries count — a real reply that QUOTES these strings
// (a session working on this very bug, say) is a live session, not a dead one.
//
// "OAuth session expired and could not be refreshed" is deliberately NOT here: that is the loser of a
// two-session refresh race (APL-74/78), and the winner leaves a good credential behind, so a retry works.
const AUTH_FAILURE_RE = /Login expired|Please run \/login|Could not refresh your login/i;

// Transcript text in → the failure's first line out, or null when it is not an auth failure.
function classifyAuthFailure(transcript, sinceMs = 0) {
  for (const line of String(transcript || '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.type !== 'assistant' || e.isSidechain || !e.isApiErrorMessage) continue;
    if ((Date.parse(e.timestamp) || 0) < sinceMs) continue;
    const text = entryText(e);
    if (AUTH_FAILURE_RE.test(text) || e.error === 'authentication_failed') {
      return text.trim().split('\n')[0].split(' · ')[0].slice(0, 120) || String(e.error);
    }
  }
  return null;
}

// A refusal repeats every poll until someone logs in; the desktop notification should not. One
// episode is one reason. A poll that dispatches normally ends the episode (pass null).
function shouldNotifyRefusal(reason, read = () => loadJson(CRED_NOTICE_PATH, {}),
  write = (v) => writeFileSync(CRED_NOTICE_PATH, JSON.stringify(v, null, 2))) {
  const prev = read() || {};
  if ((prev.refused ?? null) === reason) return false;
  try { write({ ...prev, refused: reason }); } catch { /* a notice is not worth failing a poll */ }
  return reason !== null;
}

/**
 * Whether this poll should log the near-expiry notice. One episode is one `expiresAt` value: while
 * the token is unchanged the notice is logged once, and a refreshed token (a new expiresAt) is a
 * new episode that may report again.
 *
 * Split out from the caller so it is testable without a keychain: the read/write are injected.
 */
function shouldAnnounceExpiry(expiresAt, read = () => loadJson(CRED_NOTICE_PATH, {}),
  write = (v) => writeFileSync(CRED_NOTICE_PATH, JSON.stringify(v, null, 2))) {
  if (!Number.isFinite(expiresAt)) return false;
  if (read().announcedFor === expiresAt) return false;
  try { write({ announcedFor: expiresAt }); } catch { /* a notice is not worth failing a poll */ }
  return true;
}

// ── Concurrency ──────────────────────────────────────────────────────────────────────────────
// A dispatched session is not one agent. /cycler:workflow-feature runs task-orchestration.js, which
// fans out to ~5-9 subagents for a normal run and up to ~70 in the worst case, most of them on the
// inherited model. Two of those at once share ONE account-level usage pool, and neither can see the
// other spending it: the workflow's own budget guard reads `budget.remaining()`, which is Infinity
// unless a budget was set, and a budget CANNOT be set for a dispatched session — `--max-budget-usd`
// only works with `--print`, and `--print` conflicts with `--background` (see the header).
//
// So the guard inside the workflow is unreachable from here by construction, and the only lever the
// poller actually holds is how many runs it starts. APL-74 and APL-78 went out in the same poll on
// 2026-09-10 and hit the session limit together 30 minutes later, both blocked at their audit stage
// with the diff unverified. Serialising costs a poll interval (180s) per issue and nothing else:
// nothing is dropped, the rest simply go out on later polls.
//
// The count comes from `claude agents --json` — a local read of this machine's session registry,
// ~0.2s, no network call and no inference call, so the README's "one outbound request per poll,
// and never an LLM call" still holds.
//
// Only sessions this poller could have started are counted, identified by the name dispatch() gives
// them ("[APL-78] title"), and only while they are actually working. Counting an idle one would be a
// stall with extra steps: two sessions sat `idle`/`blocked` for fifteen hours after hitting the
// limit, and a poller that counted those would never dispatch again.
const SESSION_NAME_RE = /^\[[A-Z][A-Z0-9]*-\d+\]/;

// The registry reports this as `state`. It was read as `status` from the day the cap was written,
// and `undefined === 'busy'` is false for every entry, so countRunningSessions() returned a
// confident 0 on every poll and dispatch.max_concurrent was never once enforced. It did not fail
// open — the listing parsed fine — which is why nothing in the log ever looked wrong: it said
// "0 dispatched session(s) still running" while two provably-live sessions were emptying the
// account's usage window. `status` is still accepted so a future rename cannot re-break this the
// same way, and agentState() is the ONLY place either name appears.
function agentState(a) {
  return String((a && (a.state ?? a.status)) || '').toLowerCase();
}

// Named by what they are: states in which a session will not consume another token unattended.
// `blocked` is here deliberately — it means "waiting on a permission prompt", which holds a worktree
// but makes no progress and never ends on its own, so counting it stalls the queue permanently.
// An UNRECOGNISED state counts as working, which is the safe direction: over-counting costs one
// poll of delay, under-counting costs the whole usage window.
const AGENT_IDLE_STATES = new Set([
  'idle', 'blocked', 'completed', 'done', 'failed', 'error', 'stopped', 'killed', 'canceled', 'cancelled',
]);

// dispatch() takes the session id from the child's stdout, and when that line is not what the regex
// expects the id is simply lost. It is not cosmetic: the id is how reviewRunning() watches a session
// for the usage-limit message that holds the queue, so a session dispatched without one can burn the
// whole window with no cooldown to show for it. APL-76 went out this way.
//
// The registry is the authoritative answer to "what did I just start", so ask it. Matching is on the
// `[KEY]` prefix rather than the full name because dispatch() truncates the name to 80 chars and the
// registry truncates again; the prefix is exact and one dispatch owns one key at a time.
function findSessionByKey(identifier, read = defaultAgentsRead) {
  const list = readAgents(read);
  if (list === null) return null;
  const prefix = `[${identifier}]`;
  const hit = list.filter((a) => a && String(a.name || '').startsWith(prefix))
    // Newest wins: a re-dispatch after a dead run leaves the old entry in place for a while.
    .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))[0];
  return hit && hit.id ? String(hit.id) : null;
}

// The id of a session that is ALREADY working this issue, if there is one.
//
// A session the usage limit stops is not dead. It resumes on its own when the window reopens — and
// the poller's cooldown expires at the same moment, so both the resumed session and a fresh dispatch
// start on the same branch within the same second. That happened to APL-84 on 2026-09-12: e416007a
// resumed at 12:00:40 and 9f2a405e was dispatched at 12:01:26, two runs in one worktree.
//
// max_concurrent cannot catch this. It reads the registry once at the top of a poll, and at that
// instant the resuming session had not yet flipped to `working`. So the invariant is enforced here
// instead, per issue, immediately before spawning: one issue, one session, checked as late as
// possible rather than inferred from a count taken earlier.
function liveSessionFor(identifier, read = defaultAgentsRead) {
  const list = readAgents(read);
  if (list === null) return null;
  const prefix = `[${identifier}]`;
  const hit = list.find((a) => a && String(a.name || '').startsWith(prefix) && isWorking(a));
  return hit && hit.id ? String(hit.id) : null;
}

function isWorking(a) {
  const state = agentState(a);
  return state !== '' && !AGENT_IDLE_STATES.has(state);
}

function defaultAgentsRead() {
  if (process.env.CYCLER_AGENTS_FILE) return readFileSync(process.env.CYCLER_AGENTS_FILE, 'utf8');
  return execFileSync(CLAUDE_BIN, ['agents', '--json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
}

function readAgents(read) {
  let parsed;
  try {
    parsed = JSON.parse(read());
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && parsed.agents);
  return Array.isArray(list) ? list : null;
}

// null means "could not tell" — distinct from 0, which is a confident "nothing is running".
function countRunningSessions(read = defaultAgentsRead) {
  const list = readAgents(read);
  if (list === null) return null;
  return list.filter((a) => a && isWorking(a) && SESSION_NAME_RE.test(String(a.name || ''))).length;
}

// Short ids of everything still busy, for deciding which watched sessions have actually stopped.
// An unreadable registry yields an empty set, which only means a watched session is read one poll
// early — harmless, since reading a live session's log finds no limit message.
function busySessionIds(read = defaultAgentsRead) {
  const list = readAgents(read) || [];
  return new Set(list.filter((a) => a && isWorking(a)).map((a) => String(a.id || '')));
}

// An issue is blocked while any issue that "blocks" it is not finished.
//
// Linear stores the relation on the BLOCKER ("A blocks B" lives on A), so B sees it as an inverse
// relation. Getting that backwards is silent in the worst way: every issue reads as unblocked and
// the feature looks like it works right up until the ordering matters.
//
// Only `blocks` counts. `related` and `duplicate` are not ordering constraints and treating them as
// such would stall a queue for reasons nobody wrote down.
//
// Fails OPEN, like every other guard here: an issue whose relations cannot be read dispatches. A
// missing field must not become a queue that silently stops.
function isBlocked(issue) {
  const nodes = issue?.inverseRelations?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((r) =>
    r && r.type === 'blocks' && r.issue && !['completed', 'canceled'].includes(r.issue.state?.type));
}

// Which ones, for the log line — "blocked" with no blocker named is a dead end for whoever reads it.
function blockerKeys(issue) {
  const nodes = issue?.inverseRelations?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((r) => r && r.type === 'blocks' && r.issue && !['completed', 'canceled'].includes(r.issue.state?.type))
    .map((r) => r.issue.identifier);
}

// Fails OPEN, for the same reason dispatchBudget() does: a machine where this process cannot ask
// what is running must behave exactly as it did before this existed. Turning "I don't know" into
// "dispatch nothing" would make an unreadable registry a silent, permanent stall.
function concurrencySlots(running, max = MAX_CONCURRENT) {
  if (running === null) return Infinity;
  if (!Number.isFinite(max) || max <= 0) return Infinity;
  return Math.max(0, max - running);
}

// ── The usage-limit cooldown ─────────────────────────────────────────────────────────────────
// max_concurrent stops two runs from racing each other. It does NOT stop them from emptying the
// same pool one after the other, and that is what happened on 2026-09-11: APL-78 ran alone for 22
// minutes across 14 agents, finished, and APL-74 started three minutes later into what was left of
// the same window and died at its last stage. Nothing ran concurrently — the log is eleven straight
// "holding off" lines — so serialising was never going to be enough on its own.
//
// One run of the feature workflow is 14-17 agents. Two of them do not fit in one usage window, and
// no amount of spacing changes that; what changes it is not starting the second run until the
// window has actually reset. The CLI says exactly when that is, in the message it kills the session
// with: "You've hit your session limit · resets 9am (Asia/Jerusalem)".
//
// That message is read from `claude logs <id>` — local, no network call and no inference call, same
// as the other two guards. It is only read once, when a session this poller started stops being
// busy, which is why running.json exists: pending.json is dropped as soon as a session proves it
// STARTED, and a limit is hit hours after that.
const LIMIT_RE = /hit your (?:session|usage) limit/i;
const RESET_RE = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

// Wall-clock minutes since midnight in an IANA zone, or null when the zone is not one this runtime
// knows. Intl is the only timezone database available here, and a Workflow-style "parse it by hand"
// would be wrong twice a year.
function zoneMinutes(tz, now) {
  try {
    const parts = new Intl.DateTimeFormat('en-US',
      { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now));
    const h = Number(parts.find((x) => x.type === 'hour').value);
    const m = Number(parts.find((x) => x.type === 'minute').value);
    return (h % 24) * 60 + m;
  } catch {
    return null;
  }
}

// Returns the epoch ms to hold until, or null when the text is not a limit message at all. A limit
// message whose reset time cannot be read still returns a hold — knowing the window is spent is the
// load-bearing half; knowing exactly when it reopens only sharpens it.
function parseLimitReset(text, now = Date.now(), fallbackMs = COOLDOWN_FALLBACK_MS, ceilingMs = COOLDOWN_CEILING_MS) {
  if (typeof text !== 'string' || !LIMIT_RE.test(text)) return null;
  const m = RESET_RE.exec(text);
  const zone = m && m[4];
  const nowMin = zone ? zoneMinutes(zone, now) : null;
  if (!m || nowMin === null) return now + fallbackMs;
  let hour = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase();
  if (hour > 23 || min > 59) return now + fallbackMs;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const targetMin = hour * 60 + min;
  // The reset is always in the future: the same clock time today if it has not passed yet,
  // tomorrow's if it has.
  const delta = targetMin > nowMin ? targetMin - nowMin : targetMin - nowMin + 24 * 60;
  return now + Math.min(delta * 60_000, ceilingMs);
}

function cooldownRemaining(state, now = Date.now()) {
  const until = state && Number(state.until);
  return Number.isFinite(until) && until > now ? until - now : 0;
}

// The session's own transcript, not `claude logs`. The logs are a redrawn terminal screen: a limit line
// from hours ago stays on it after the session was respawned and carried on, and re-reading it parked
// APL-87 behind a fake 6-hour cooldown on 2026-09-12. The transcript is append-only and every entry is
// timestamped, so "is the LAST thing this session did a limit error, and is it newer than the watch" has
// one deterministic answer.
function transcriptFile(session, agent) {
  const full = (agent && agent.sessionId) || session;
  const cwd = (agent && agent.cwd) || REPO_PATH;
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${full}.jsonl`);
}

function defaultTranscriptRead(rec, agent) {
  return readFileSync(transcriptFile(rec.session, agent), 'utf8');
}

function entryText(e) {
  const c = e && e.message && e.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
}

// limited  — the last assistant entry is the CLI's synthetic limit error, written after `sinceMs`
// turn     — the last assistant entry ended its turn normally (a question for a human, or a final report)
// working  — anything else (mid tool call, empty, unparseable)
// The workflow's own board comments, as they appear in the transcript once the session posts them. A turn
// that ends after one of these is the session's closing summary, not a question: the finished one ends
// the watch, the blocked one has already told the board (with the questions) and must not be repeated.
const RUN_FINISHED_RE = /Workflow run finished/;
const RUN_BLOCKED_RE = /Workflow run blocked|is waiting for your reply/;

function classifyTranscript(text, sinceMs = 0) {
  let last = null;
  let finished = false;
  let reported = false;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || e.isSidechain) continue;
    if ((Date.parse(e.timestamp) || 0) >= sinceMs) {
      if (RUN_FINISHED_RE.test(line)) finished = true;
      if (e.type === 'user' && typeof e.message?.content === 'string') reported = false;
      if (RUN_BLOCKED_RE.test(line)) reported = true;
    }
    if (e.type === 'assistant') last = e;
  }
  if (!last) return { kind: 'working' };
  const ts = Date.parse(last.timestamp) || 0;
  const body = entryText(last);
  if (last.isApiErrorMessage && LIMIT_RE.test(body)) {
    return ts >= sinceMs ? { kind: 'limited', text: body, at: ts, uuid: last.uuid } : { kind: 'working' };
  }
  if (last.message && last.message.stop_reason === 'end_turn' && body.trim()) {
    if (finished) return { kind: 'done', at: ts, uuid: last.uuid };
    return { kind: 'turn', text: body, at: ts, uuid: last.uuid, reported };
  }
  return { kind: 'working' };
}

// States after which a session never acts again. `done`, `idle` and `blocked` are NOT here: those
// sessions still exist and resume the moment someone answers them.
const AGENT_GONE_STATES = new Set(['stopped', 'killed', 'failed', 'error', 'canceled', 'cancelled']);

// Every watched session gets exactly one verdict per poll:
//   busy                         → keep watching
//   limit error newer than watch → park for resume, hold the queue until the reset
//   ended a turn, still exists   → waiting on a human: notify ONCE per message, keep watching
//   gone / stopped / issue closed → finished: stop watching
// Nothing is dropped just because it went quiet — that is how a session waiting on a question used to
// vanish from running.json and sit unanswered.
function reviewRunning({ agents = readAgents(defaultAgentsRead), readTranscript = defaultTranscriptRead,
  issueStates = new Map(), now = Date.now() } = {}) {
  const watched = loadJson(RUNNING_PATH, []);
  const none = { state: null, limited: [], waiting: [], finished: [] };
  if (!watched.length) return none;
  // An unreadable registry decides nothing: every verdict below depends on it.
  if (agents === null) return none;
  const byId = new Map(agents.filter(Boolean).map((a) => [String(a.id || ''), a]));
  const keep = [];
  const limited = [];
  const waiting = [];
  const finished = [];
  let hold = null;
  for (const rec of watched) {
    const agent = byId.get(rec.session);
    const issueState = issueStates.get(rec.issueId);
    if (['completed', 'canceled'].includes(issueState)) { finished.push(rec); continue; }
    if (agent && isWorking(agent)) { keep.push(rec); continue; }
    let verdict = { kind: 'working' };
    try { verdict = classifyTranscript(readTranscript(rec, agent), Number(rec.at) || 0); } catch { /* unreadable */ }
    if (verdict.kind === 'limited') {
      // Reset is computed from when the limit was HIT, not from now: read late, "resets 1am" must not
      // roll over to tomorrow's 1am.
      const until = parseLimitReset(verdict.text, verdict.at || now);
      logErr(`${rec.identifier} (session ${rec.session}) ended on the account's usage limit`);
      hold = Math.max(hold || 0, until);
      limited.push(rec);
      continue;
    }
    if (!agent || AGENT_GONE_STATES.has(agentState(agent)) || verdict.kind === 'done'
      || (rec.followup && verdict.kind === 'turn')) { finished.push(rec); continue; }
    if (verdict.kind === 'turn' && rec.notified !== verdict.uuid) {
      rec.notified = verdict.uuid;
      if (!verdict.reported) waiting.push({ ...rec, question: verdict.text, remoteUrl: remoteControlUrl(rec.session, () => JSON.stringify(agents)) });
    }
    keep.push(rec);
  }
  writeFileSync(RUNNING_PATH, JSON.stringify(keep, null, 2));
  for (const rec of finished) log(`${rec.identifier} session ${rec.session} finished — no longer watched`);
  if (hold === null) return { ...none, waiting, finished };
  // A hold already in the past still parks the session; resumeAfterLimit() then runs in this same poll.
  const state = { until: hold, reason: 'a dispatched session ended on the account usage limit', at: now };
  if (hold > now) writeFileSync(COOLDOWN_PATH, JSON.stringify(state, null, 2));
  // The records come back rather than being acted on here: writing processed.json and posting to
  // Linear are the caller's jobs, and keeping them out of this function is what lets the cooldown
  // logic stay testable without a network.
  return { state, limited, waiting, finished };
}

// Sessions nobody should be running:
//   - copies named after the resume prompt (a `--resume` that forked instead of continuing)
//   - a second live `[KEY]` session for an issue whose watched session still exists
// Stopped, never removed: `claude stop` keeps the conversation, so a wrong call costs nothing.
const GHOST_NAME_PREFIX = "The account's Claude usage window";
function findGhosts(agents, watched) {
  if (!Array.isArray(agents)) return [];
  const live = (a) => a && !AGENT_GONE_STATES.has(agentState(a)) && agentState(a) !== 'done';
  const ids = new Set(agents.map((a) => a && String(a.id || '')));
  const owner = new Map(watched.filter((r) => ids.has(r.session)).map((r) => [r.identifier, r.session]));
  const ghosts = [];
  for (const a of agents.filter(live)) {
    const name = String(a.name || '');
    const id = String(a.id || '');
    if (name.startsWith(GHOST_NAME_PREFIX)) { ghosts.push({ id, name, why: 'copy forked from a resume prompt' }); continue; }
    const key = (name.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/) || [])[1];
    if (key && owner.has(key) && owner.get(key) !== id) {
      ghosts.push({ id, name, why: `duplicate of watched ${key} session ${owner.get(key)}` });
    }
  }
  return ghosts;
}

function reapGhosts(agents, stop = defaultStop) {
  const reaped = [];
  for (const g of findGhosts(agents, loadJson(RUNNING_PATH, []))) {
    try { stop(g.id); log(`stopped ghost session ${g.id} (${g.why}): ${g.name.slice(0, 80)}`); reaped.push(g); }
    catch (err) { logErr(`could not stop ghost session ${g.id}: ${err.message}`); }
  }
  return reaped;
}

// A desktop notification in addition to the Linear comment — a question on the board is easy to miss.
// CYCLER_NO_NOTIFY is for the test suite, which drives real polls on a real Mac.
function notifyDesktop(title, body) {
  if (process.env.CYCLER_NO_NOTIFY) return;
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(body.slice(0, 200))} with title ${JSON.stringify(title)}`],
      { stdio: 'ignore', timeout: 5_000 });
  } catch { /* not macOS, or no GUI session */ }
}

// A session the usage limit killed did not finish its issue — but it is NOT dead. It holds the whole
// run: the contract, the branch, the worktree, the audit findings, everything it had done when the
// window closed. Re-dispatching throws all of that away and starts the issue from zero, and worse,
// the killed session resumes ITSELF when the window reopens, so a fresh dispatch means two runs on
// one branch. APL-84 is the recorded case: session e416007a died at 08:23, a NEW session 9f2a405e
// was dispatched at 12:01:26 when the cooldown expired, and e416007a came back six minutes later.
//
// So nothing is requeued. The record is parked in resume.json and, once the window reopens,
// resumeAfterLimit() continues THAT session in place. The issue stays in processed.json throughout,
// which is what stops the normal dispatch path from racing the resume.
//
// Attempts still count. An issue that hits the limit on every attempt would otherwise resume forever,
// burning each new window on the same run and never reaching the retry ceiling that exists for it.
function parkForResume(limited, until) {
  const parked = loadJson(RESUME_PATH, []);
  const added = [];
  for (const rec of limited) {
    if (!rec.session) {
      logErr(`${rec.identifier} was killed by the usage limit but its watch record has no session id — `
        + `it cannot be resumed automatically; re-run it by hand`);
      continue;
    }
    const attempts = rec.attempts || 1;
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      logErr(`${rec.identifier} has been killed by the usage limit ${attempts} times — not resuming`);
      continue;
    }
    const next = {
      session: rec.session,
      issueId: rec.issueId,
      identifier: rec.identifier,
      workflow: rec.workflow,
      attempts: attempts + 1,
      until,
      at: Date.now(),
    };
    const at = parked.findIndex((r) => r.session === rec.session);
    if (at >= 0) parked[at] = next; else parked.push(next);
    added.push(next);
  }
  if (added.length) writeFileSync(RESUME_PATH, JSON.stringify(parked, null, 2));
  return added;
}

// Once the window has reopened, continue each parked session where it stopped.
//
// `claude --background --resume <id>` continues that session under the same id. The one case it does
// something else is when the session is ALREADY running — then it starts a copy, which is exactly the
// duplicate this whole mechanism exists to prevent. A limit-killed session often restores itself at
// the reset, so that case is common rather than exotic: when the registry says the session is working
// again, the resume is skipped and the record retired, because the session is already doing the thing
// the resume would have asked for.
//
// Records survive a failed resume: they stay in resume.json and the next poll tries again, up to the
// attempt ceiling parkForResume() already applied.
function resumeAfterLimit(runResume = defaultResume, read = defaultAgentsRead) {
  const parked = loadJson(RESUME_PATH, []);
  if (!parked.length) return { resumed: [], selfRestored: [] };
  const keep = [];
  const resumed = [];
  const agents = readAgents(read) || [];
  for (const rec of parked) {
    try {
      const agent = agents.find((a) => a && String(a.id || '') === rec.session);
      const carried = runResume(rec.session, resumePrompt(rec),
        agent || { id: rec.session, name: `[${rec.identifier}] resumed` });
      if (typeof carried === 'string' && carried && carried !== rec.session) { rec.previous = rec.session; rec.session = carried; }
      rec.remoteUrl = remoteControlUrl(rec.session, read);
      log(`resumed ${rec.identifier} session=${rec.session}${rec.previous ? ` (was ${rec.previous}, stopped)` : ''} `
        + `after the usage window reset (attempt ${rec.attempts} of ${MAX_DISPATCH_ATTEMPTS}) — continuing automatically`);
      resumed.push(rec);
    } catch (err) {
      logErr(`could not resume ${rec.identifier} session ${rec.session}: ${err.message} — retrying next poll`);
      keep.push(rec);
    }
  }
  writeFileSync(RESUME_PATH, JSON.stringify(keep, null, 2));
  // A resumed session has to be watched again: the window it just re-entered can run out too.
  if (resumed.length) {
    const watched = loadJson(RUNNING_PATH, []);
    for (const rec of resumed) {
      if (watched.some((r) => r.session === rec.session)) continue;
      watched.push({
        session: rec.session,
        issueId: rec.issueId,
        identifier: rec.identifier,
        workflow: rec.workflow,
        attempts: rec.attempts,
        at: Date.now(),
      });
    }
    writeFileSync(RUNNING_PATH, JSON.stringify(watched, null, 2));
  }
  return { resumed, selfRestored: [] };
}

// What the resumed session is told. It has its own transcript, so this says what CHANGED — the window
// is open again — and not what the task is.
function resumePrompt(rec) {
  return `The account's Claude usage window has reset, so you can continue. You were working `
    + `${rec.identifier} via ${rec.workflow || 'its workflow'} and were stopped mid-run by the usage `
    + `limit. Pick up exactly where you left off: re-read your contract and the workflow's stage list, `
    + `work out which stage you had reached, and carry on from there. Do not start over and do not `
    + `create a second branch or worktree.`;
}

// Continue a session WITHOUT a human, WITHOUT forking, and with the CONFIGURED command's flags.
//  - `claude --resume` always creates a new session id, and it drops every flag the config command
//    set (APL-98's 312a2dfd lost --remote-control and vanished from Desktop and claude.ai).
//  - `claude respawn <id>` keeps the id and restarts with the job's saved flags, but takes no prompt.
// So: the job's saved flags are reset to the ones dispatch.command gives this issue, the job is
// respawned (same id, those flags), and the prompt is typed into `claude attach <id>` by
// send-prompt.exp, which then detaches. Returns the id that carries the run — always the same one.
const SEND_PROMPT = join(fileURLToPath(new URL('.', import.meta.url)), 'send-prompt.exp');
function defaultResume(session, prompt, agent) {
  const env = { ...process.env, CLAUDE_BIN, PATH: [...PATH_PREPEND, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':') };
  const name = String((agent && agent.name) || '');
  const key = (name.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/) || [])[1];
  if (key && applyConfiguredFlags(session, key, name)) {
    execFileSync(CLAUDE_BIN, ['respawn', session], { stdio: 'ignore', timeout: 30_000, env });
  }
  execFileSync('/usr/bin/expect', sendPromptArgv(session, prompt), {
    cwd: (agent && agent.cwd) || REPO_PATH, stdio: 'ignore', timeout: 90_000, env,
  });
  return session;
}

// The flags dispatch.command gives an issue, minus the binary, --background and the prompt.
function configuredFlags(identifier, sessionName) {
  const argv = buildDispatchArgv({ identifier, title: '' }, '', sessionName).slice(1);
  const flags = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--background' || tok === '--bg') continue;
    if (!tok.startsWith('-')) continue; // positional: the prompt
    flags.push(tok);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-') && i + 1 < argv.length - 1) { flags.push(next); i++; }
  }
  return flags;
}

// Rewrites the job's saved respawn flags to the configured ones. True when the job file was changed.
function applyConfiguredFlags(session, identifier, sessionName, jobsDir = join(homedir(), '.claude', 'jobs')) {
  const file = join(jobsDir, session, 'state.json');
  try {
    const st = JSON.parse(readFileSync(file, 'utf8'));
    const want = configuredFlags(identifier, sessionName);
    const keepModel = [];
    const old = Array.isArray(st.respawnFlags) ? st.respawnFlags : [];
    const m = old.indexOf('--model');
    if (m >= 0 && !want.includes('--model')) keepModel.push('--model', old[m + 1]);
    const next = [...want, ...keepModel];
    if (JSON.stringify(next) === JSON.stringify(old)) return false;
    st.respawnFlags = next;
    writeFileSync(file, JSON.stringify(st, null, 2));
    log(`${identifier} session ${session} restored to the configured dispatch flags`);
    return true;
  } catch (err) {
    logErr(`could not apply configured flags to ${session}: ${err.message}`);
    return false;
  }
}

function sendPromptArgv(session, prompt) {
  return [SEND_PROMPT, String(session), String(prompt).replace(/\s*\n\s*/g, ' ')];
}

// The remote-control link a session announces in its own transcript (a `bridge_status` line).
function remoteControlUrl(session, read = defaultAgentsRead) {
  try {
    const hit = (readAgents(read) || []).find((a) => a && String(a.id || '') === session);
    const urls = readFileSync(transcriptFile(session, hit), 'utf8').match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g);
    return urls ? urls[urls.length - 1] : null;
  } catch {
    return null;
  }
}

// A session id as the board shows it: a link to the session when it has announced one.
function sessionLink(session, read = defaultAgentsRead) {
  if (!session) return '`?`';
  const url = remoteControlUrl(session, read);
  return url ? `[${session}](<${url}>)` : `\`${session}\``;
}

function follow(issueId, identifier, session, seenAt = Date.now()) {
  try {
    const reg = loadJson(FOLLOW_PATH, {});
    reg[issueId] = { ...(reg[issueId] || { seenAt }), identifier, session };
    writeFileSync(FOLLOW_PATH, JSON.stringify(reg, null, 2));
  } catch (err) {
    logErr(`could not record ${identifier} for follow-up: ${err.message}`);
  }
}

// The PR on the issue's branch, with every comment a human could have left on it: conversation
// comments, review bodies and inline review comments.
function defaultPrFor(identifier) {
  const opts = { cwd: REPO_PATH, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 };
  let pr;
  try {
    pr = JSON.parse(execFileSync('gh', ['pr', 'view', `${BRANCH_PREFIX}${identifier}`, '--json',
      'number,state,url,comments,reviews'], opts));
  } catch { return null; } // no PR yet
  const inline = JSON.parse(execFileSync('gh', ['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`], opts) || '[]');
  const comments = [
    ...(pr.comments || []),
    ...(pr.reviews || []).filter((r) => r.body || r.state === 'CHANGES_REQUESTED').map((r) => ({ ...r, createdAt: r.submittedAt })),
    ...inline,
  ];
  return { number: pr.number, state: pr.state, url: pr.url, comments };
}

function defaultStop(session) {
  execFileSync(CLAUDE_BIN, ['stop', session], { stdio: 'ignore', timeout: 15_000 });
}

// issueId -> the attempt number the NEXT dispatch of it represents. Lives for one poll: it is the
// only thing carrying retry count across the un-process/re-dispatch boundary within a single run.
const carryAttempts = new Map();

async function poll() {
  const { viewer } = await gql('query { viewer { id } }');
  const { issues } = await gql(
    `query ($delegateId: ID!) {
       issues(first: ${MAX_PER_POLL}, filter: { delegate: { id: { eq: $delegateId } } }) {
         nodes {
           id identifier title state { type } labels { nodes { name } }
           # "A blocks B" is stored on A, so B finds it through inverseRelations. Fetching this is
           # what makes a blocking link mean something to the poller: without it the board can say
           # an issue is blocked and the poller will cheerfully dispatch it anyway.
           inverseRelations { nodes { type issue { identifier state { type } } } }
           comments(last: 10) { nodes { createdAt body user { id app isMe } botActor { id } } }
         }
       }
     }`,
    { delegateId: viewer.id }
  );

  // Before dispatching anything new: settle the fate of what was dispatched last time. This can
  // un-process an issue, which is what makes a dead dispatch retry below in the same poll.
  const liveness = await checkLiveness();

  const processed = new Set(loadJson(STATE_PATH, []));
  let changed = false;

  const cred = readClaudeCredential();
  const expiresAt = cred ? cred.expiresAt : null;
  const hold = loadJson(AUTH_HOLD_PATH, null);
  const pre = credentialPreflight(cred, Date.now(), REFRESH_SKEW_MS, hold);
  if (hold && !pre.refuse) {
    // The credential changed since a session died of it: someone logged in, or a refresh landed.
    try { unlinkSync(AUTH_HOLD_PATH); } catch { /* already gone */ }
    log(`claude credential changed since ${hold.identifier || 'a session'} died logged out — dispatching again`);
  }
  // A refusal dispatches nothing and marks nothing: the loop below never runs, so no issue is added
  // to processed.json and no attempt is spent. It says so on the poll's outcome line, every poll,
  // and on the desktop once per episode.
  if (pre.refuse) {
    if (shouldNotifyRefusal(pre.refuse)) notifyDesktop('cycler: Claude is logged out', `${pre.refuse}. Run /login.`);
  } else {
    shouldNotifyRefusal(null);
  }
  const credBudget = pre.budget;
  if (credBudget === 1 && shouldAnnounceExpiry(expiresAt)) {
    // Not "you are logged out". The access token is minutes from expiry and the CLI refreshes it
    // by itself on the next session that goes out; the refresh token is untouched and `claude`
    // still reports a logged-in account. Dispatching one issue is how the refresh is serialised,
    // so several sessions do not race to perform it. Nothing here needs a human.
    log('claude access token expires shortly — letting a single session refresh it, so this poll '
      + 'dispatches one issue and the rest go out on the next. No action needed; not a logout');
  }
  const agents = readAgents(defaultAgentsRead);
  reapGhosts(agents);
  let running = countRunningSessions();
  const issueStates = new Map(issues.nodes.map((i) => [i.id, i.state?.type]));
  const review = reviewRunning({ agents, issueStates });
  for (const rec of review.waiting) {
    const excerpt = rec.question.length > 400 ? `…${rec.question.slice(-400)}` : rec.question;
    try {
      await comment(
        rec.issueId,
        `🙋 Session ${rec.remoteUrl ? `[${rec.session}](<${rec.remoteUrl}>)` : `\`${rec.session}\``} is waiting for your reply:\n\n`
          + excerpt.split('\n').map((l) => `> ${l}`).join('\n')
      );
    } catch (err) {
      logErr(`${rec.identifier} is waiting on a human but could not comment: ${err.message}`);
    }
    notifyDesktop(`cycler: ${rec.identifier} is waiting`, rec.question.trim().split('\n').pop() || '');
    log(`${rec.identifier} session ${rec.session} is waiting on a human${rec.remoteUrl ? ` — ${rec.remoteUrl}` : ''}`);
  }
  if (review.limited.length) {
    const resumesAt = new Date(review.state.until);
    for (const rec of parkForResume(review.limited, review.state.until)) {
      // Say it on the ISSUE, not only in a log file nobody opens. A run that vanishes because the
      // account's window ran out is indistinguishable on the board from one that was never picked
      // up, and that ambiguity is the whole reason every other outcome here posts a comment.
      try {
        await comment(
          rec.issueId,
          `5h usage window exceeded. Resets at ${localTime(resumesAt)}.`
        );
      } catch (err) {
        logErr(`could not tell ${rec.identifier} it was paused on the usage limit: ${err.message}`);
      }
      log(`${rec.identifier} parked — session ${rec.session} resumes after the usage window resets `
        + `at ${resumesAt.toISOString()}`);
    }
  }
  const cooling = cooldownRemaining(loadJson(COOLDOWN_PATH, null));
  if (cooling > 0) {
    log(`holding off: a dispatched session ended on the account usage limit — nothing goes out for `
      + `another ${Math.ceil(cooling / 60_000)} min, when the window resets`);
  }
  if (cooling === 0) {
    // The window is open again. Parked sessions go first: they are half-finished runs, and resuming
    // one costs less than the fresh dispatch that would otherwise take the same slot.
    const { resumed } = resumeAfterLimit();
    // A resumed session occupies a slot now, even if the registry has not caught up yet.
    if (running !== null) running += resumed.length;
    for (const rec of resumed) {
      if (rec.session) follow(rec.issueId, rec.identifier, rec.session);
      try {
        await comment(
          rec.issueId,
          `Resumed by cycler because the usage window reset — session ${sessionLink(rec.session)}.`
        );
      } catch (err) {
        logErr(`resumed ${rec.identifier} but could not comment: ${err.message}`);
      }
    }
  }
  // Merged PRs close their sessions; new human feedback wakes them. Backfill first, so issues
  // dispatched before this existed are followed too — from now, not from their whole history.
  try {
    const reg = loadJson(FOLLOW_PATH, {});
    const idsNow = new Map((agents || []).filter(Boolean).map((a) => [String(a.id || ''), a]));
    for (const issue of issues.nodes) {
      if (reg[issue.id] || !processed.has(issue.id)) continue;
      const session = findSessionByKey(issue.identifier, () => JSON.stringify(agents || []));
      if (session) reg[issue.id] = { identifier: issue.identifier, session, seenAt: Date.now() };
    }
    const next = await followUp(issues.nodes, reg, {
      prFor: defaultPrFor,
      isWorking: (id) => { const a = idsNow.get(id); return Boolean(a && isWorking(a)); },
      resume: (id, prompt, identifier) => {
        const session = defaultResume(id, prompt, idsNow.get(id) || { id, name: `[${identifier}] follow-up` });
        // Watched like any run, so a usage limit still parks it. `followup` marks its closing turn as
        // the end of the job rather than a question: it answers feedback, it does not ask for any.
        const issue = issues.nodes.find((i) => i.identifier === identifier);
        const watched = loadJson(RUNNING_PATH, []).filter((r) => r.session !== id);
        watched.push({ session, issueId: issue?.id, identifier, at: Date.now(), followup: true });
        writeFileSync(RUNNING_PATH, JSON.stringify(watched, null, 2));
        return session;
      },
      stop: defaultStop,
      comment,
      link: (id) => sessionLink(id),
      log,
    });
    writeFileSync(FOLLOW_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    logErr(`follow-up pass failed: ${err.message}`);
  }
  const slots = cooling > 0 ? 0 : concurrencySlots(running);
  if (slots === 0) {
    log(`holding off: ${running} dispatched session(s) still running and dispatch.max_concurrent is `
      + `${MAX_CONCURRENT} — the queue moves on the next poll that finds a free slot`);
  }
  let budget = Math.min(credBudget, slots);

  for (const issue of issues.nodes) {
    // Checked at the TOP, not only after a dispatch: a budget that starts at 0 must start nothing.
    if (budget <= 0) break;
    if (processed.has(issue.id)) continue;
    if (['completed', 'canceled'].includes(issue.state?.type)) continue;
    // Checked BEFORE the budget is spent, and deliberately not marked processed: a blocked issue is
    // not finished with, it is waiting. It is re-examined every poll and goes out on the first one
    // after its blockers close, with no further action from anyone.
    if (isBlocked(issue)) {
      log(`skipping ${issue.identifier} — blocked by ${blockerKeys(issue).join(', ')}`);
      continue;
    }
    // Last line of defence against two runs on one branch, and the only one that catches a session
    // resuming from a usage limit at the same moment its cooldown lifts. Not marked processed: if
    // that session then fails, the issue is still eligible on a later poll.
    const already = liveSessionFor(issue.identifier);
    if (already) {
      log(`skipping ${issue.identifier} — session ${already} is already working it`);
      continue;
    }
    try {
      // Inside the try on purpose. Thrown from out here it escaped poll() entirely, so a mistyped
      // repo.path aborted the whole poll before the failure comment below and every delegated issue
      // sat in silence — the exact "indistinguishable from never seeing the issue" state that the
      // failure comment exists to prevent.
      if (!existsSync(REPO_PATH)) throw new Error(`REPO_PATH not found: ${REPO_PATH}`);
      await dispatch(issue);
      processed.add(issue.id);
      changed = true;
      budget -= 1;
    } catch (err) {
      logErr(`failed ${issue.identifier}: ${err.message}`); // retried on next poll
      // Post it too. Without this the issue just sits delegated with no comment, which is
      // indistinguishable from "the agent never saw it" — the --print/--background conflict looked
      // exactly like that for a week.
      try {
        await comment(
          issue.id,
          `⚠️ Dispatch failed, retrying next poll: ${String(err.message).split('\n')[0].slice(0, 200)}`
        );
      } catch (e2) {
        logErr(`  and could not comment: ${e2.message}`);
      }
    }
  }

  if (changed) writeFileSync(STATE_PATH, JSON.stringify([...processed], null, 2));
  // The credential state is logged every poll on purpose: whether THIS process can read the
  // keychain is a property of how it was started (launchd, not a shell), so the only honest place
  // to find out is the launchd log itself.
  const credText = expiresAt === null
    ? 'credential unreadable'
    : `credential expires ${new Date(expiresAt).toISOString()}`;
  const tail = `${issues.nodes.length} delegated, ${processed.size} processed total, ${credText}`;
  const problems = pollProblems(pre, liveness);
  // `poll ok` is the line a human greps for, so it is printed only when nothing went wrong.
  // 2026-09-23: six sessions died on "Login expired" and every poll in that window said `poll ok`.
  log(problems.length ? `poll degraded: ${problems.join("; ")} | ${tail}` : `poll ok: ${tail}`);
}

// What makes a poll degraded, one short clause each, so the outcome line stays one line.
function pollProblems(pre, liveness = { dead: [], authDead: [] }) {
  const out = [];
  if (pre && pre.refuse) out.push(`not dispatching, ${pre.refuse} — run /login`);
  if (liveness.authDead.length) out.push(`${liveness.authDead.map((d) => d.identifier).join(', ')} died logged out`);
  if (liveness.dead.length) out.push(`dead dispatch ${liveness.dead.map((d) => d.identifier + (d.giveUp ? ' (gave up)' : '')).join(', ')}`);
  return out;
}

// Exported so the tests can exercise routing and the dispatch template without starting a poll —
// a dispatch command that silently renders wrong is the failure this whole file is careful about,
// and it is only checkable if it can be called.
export { localTime, workflowFor, buildDispatchArgv, splitCommand, DEFAULT_DISPATCH, dispatchBudget, readClaudeExpiry,
  shouldAnnounceExpiry, readClaudeCredential, credentialPreflight, classifyAuthFailure, shouldNotifyRefusal, pollProblems,
  countRunningSessions, concurrencySlots, busySessionIds, parseLimitReset, cooldownRemaining,
  agentState, isWorking, findSessionByKey, liveSessionFor, parkForResume, resumeAfterLimit, resumePrompt, sendPromptArgv, configuredFlags, applyConfiguredFlags, remoteControlUrl, livenessVerdict, agentFor, isBlocked,
  classifyTranscript, reviewRunning, sessionLink, follow, findGhosts, reapGhosts,
  blockerKeys };

// Run only when executed directly, not when imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'auth') await auth();
    else await poll();
  } catch (err) {
    logErr('poll failed:', err.stack || err.message);
    process.exit(1);
  }
}
