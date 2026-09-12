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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig, configPath, pick } from '../lib/yaml.mjs';

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
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

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
      `⚡ Dispatched "${sessionName}"${sessionId ? ` — session \`${sessionId}\`` : ''} in \`${REPO_PATH}\`` +
        `\n\n**Route:** \`${workflow}\` — ${why}` +
        `\n\nWatch it: \`claude attach ${sessionId || '<id>'}\` · \`claude logs ${sessionId || '<id>'}\`` +
        // Appended, never prefixed: "⚡ Dispatched" is the first thing this comment says on every
        // dispatch, and other things match on that.
        ((carryAttempts.get(issue.id) || 1) > 1
          ? `\n\n▶️ **Resumed** after the account's usage window reset — attempt `
            + `${carryAttempts.get(issue.id)} of ${MAX_DISPATCH_ATTEMPTS}.`
          : '')
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
// The proof of life is the start marker `<!-- harness:<KEY>:... -->` that every routable skill posts
// as its first act (skills/workflow-feature step 3, skills/workflow-research step 1b). It is checked here, on a LATER
// poll, because the check has to outlive the poll that dispatched: asking immediately would only ever
// see a session that has not got there yet.
async function checkLiveness() {
  const pending = loadJson(PENDING_PATH, []);
  if (!pending.length) return;
  const now = Date.now();
  const due = pending.filter((r) => now - r.at >= START_GRACE_MS);
  if (!due.length) return;

  const processed = new Set(loadJson(STATE_PATH, []));
  const keep = pending.filter((r) => now - r.at < START_GRACE_MS);
  let stateChanged = false;

  for (const rec of due) {
    let comments;
    try {
      ({ issue: { comments } } = await gql(
        'query ($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
        { id: rec.issueId }
      ));
    } catch (err) {
      // Could not tell either way. Keep waiting rather than declare a live run dead — a false
      // "dead" costs a duplicate session on the same branch, which is the one thing worse than
      // silence.
      logErr(`liveness check failed for ${rec.identifier}: ${err.message}`);
      keep.push(rec);
      continue;
    }

    if (comments.nodes.some((c) => c.body.includes(`harness:${rec.identifier}:`))) {
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
    logErr(
      `dead dispatch: ${rec.identifier} session=${rec.session || 'unknown'} posted no start marker ` +
        `within ${START_GRACE_MS / 1000}s (attempt ${attempts}/${MAX_DISPATCH_ATTEMPTS})`
    );
    try {
      await comment(
        rec.issueId,
        `⚠️ **Dispatched session never started.** \`${rec.identifier}\` was handed to ` +
          `\`${rec.workflow}\`${rec.session ? ` as session \`${rec.session}\`` : ''}, but it posted no ` +
          `start marker within ${START_GRACE_MS / 1000}s — so it spawned and then died, rather than ` +
          `never being seen.\n\n` +
          `Most likely: the \`claude\` CLI login expired. Check with \`claude --print "ok"\`; ` +
          `if it fails, run \`/login\` in an interactive terminal.\n\n` +
          (giveUp
            ? `This was attempt ${attempts} of ${MAX_DISPATCH_ATTEMPTS}. **Not retrying** — fix the cause, then remove ` +
              `the issue id from \`~/.cycler/processed.json\`.`
            : `Retrying on the next poll (attempt ${attempts + 1} of ${MAX_DISPATCH_ATTEMPTS}).`)
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
function defaultCredentialRead() {
  try {
    return execFileSync('security', ['find-generic-password', '-s', CRED_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return existsSync(CRED_FILE) ? readFileSync(CRED_FILE, 'utf8') : null;
  }
}

function readClaudeExpiry(read = defaultCredentialRead) {
  try {
    const raw = read();
    if (!raw) return null;
    const at = (JSON.parse(raw).claudeAiOauth || {}).expiresAt;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// How many issues one poll may dispatch. An unreadable credential yields NO limit on purpose: a
// machine whose keychain this process cannot read must behave exactly as it did before this
// existed. Degrading to "dispatch nothing" would turn an unreadable keychain into a silent stall,
// which is the failure mode every other guard in this file is written to avoid.
function dispatchBudget(expiresAt, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (!Number.isFinite(expiresAt)) return Infinity;
  return expiresAt - now > skewMs ? Infinity : 1;
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

function isWorking(a) {
  const state = agentState(a);
  return state !== '' && !AGENT_IDLE_STATES.has(state);
}

function defaultAgentsRead() {
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

// The tail is enough: the limit message is the last thing a killed session prints.
function defaultLogsRead(id) {
  return execFileSync(CLAUDE_BIN, ['logs', id],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 4 << 20 });
}

// Sessions this poller started, still being watched. Anything that has stopped being busy is read
// once for a limit message and then forgotten — a session that ended for any other reason leaves
// no trace here, which is the point: only a limit holds the queue.
function reviewRunning(readLogs = defaultLogsRead, busyIds = null) {
  const watched = loadJson(RUNNING_PATH, []);
  if (!watched.length) return { state: null, limited: [] };
  const keep = [];
  const limited = [];
  let hold = null;
  for (const rec of watched) {
    if (busyIds && rec.session && busyIds.has(rec.session)) { keep.push(rec); continue; }
    let out = '';
    try { out = readLogs(rec.session); } catch { /* gone, or unreadable — either way stop watching */ }
    const until = parseLimitReset(out);
    if (until !== null) {
      logErr(`${rec.identifier} (session ${rec.session}) ended on the account's usage limit`);
      hold = Math.max(hold || 0, until);
      limited.push(rec);
    }
  }
  writeFileSync(RUNNING_PATH, JSON.stringify(keep, null, 2));
  if (hold === null) return { state: null, limited: [] };
  const state = { until: hold, reason: 'a dispatched session ended on the account usage limit', at: Date.now() };
  writeFileSync(COOLDOWN_PATH, JSON.stringify(state, null, 2));
  // The records come back rather than being acted on here: writing processed.json and posting to
  // Linear are the caller's jobs, and keeping them out of this function is what lets the cooldown
  // logic stay testable without a network.
  return { state, limited };
}

// A session the usage limit killed did not finish its issue, so the issue must go back in the queue.
// It is still in processed.json — dispatch() put it there and nothing takes it out — so without this
// the cooldown expires onto an empty queue and the work is simply dropped, which is what happened to
// APL-79 and APL-67.
//
// Attempts still count. An issue that hits the limit on every attempt would otherwise re-dispatch
// forever, burning each new window on the same run and never reaching the retry ceiling that exists
// for exactly this.
function requeueAfterLimit(limited) {
  const processed = new Set(loadJson(STATE_PATH, []));
  const requeued = [];
  for (const rec of limited) {
    if (!rec.issueId) {
      logErr(`${rec.identifier} was killed by the usage limit but its watch record has no issue id — `
        + `it cannot be requeued automatically; remove it from ~/.cycler/processed.json by hand`);
      continue;
    }
    const attempts = rec.attempts || 1;
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      logErr(`${rec.identifier} has been killed by the usage limit ${attempts} times — not requeuing`);
      continue;
    }
    processed.delete(rec.issueId);
    carryAttempts.set(rec.issueId, attempts + 1);
    requeued.push(rec);
  }
  if (requeued.length) writeFileSync(STATE_PATH, JSON.stringify([...processed], null, 2));
  return requeued;
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
         }
       }
     }`,
    { delegateId: viewer.id }
  );

  // Before dispatching anything new: settle the fate of what was dispatched last time. This can
  // un-process an issue, which is what makes a dead dispatch retry below in the same poll.
  await checkLiveness();

  const processed = new Set(loadJson(STATE_PATH, []));
  let changed = false;

  const expiresAt = readClaudeExpiry();
  const credBudget = dispatchBudget(expiresAt);
  if (credBudget !== Infinity) {
    log('claude credential is stale — dispatching one issue this poll so a single session performs '
      + 'the refresh; the rest go out on the next poll');
  }
  const running = countRunningSessions();
  // Read once a session stops being busy: did it stop because the account's window ran out?
  const review = reviewRunning(defaultLogsRead, busySessionIds());
  if (review.limited.length) {
    const resumesAt = new Date(review.state.until);
    for (const rec of requeueAfterLimit(review.limited)) {
      // Say it on the ISSUE, not only in a log file nobody opens. A run that vanishes because the
      // account's window ran out is indistinguishable on the board from one that was never picked
      // up, and that ambiguity is the whole reason every other outcome here posts a comment.
      try {
        await comment(
          rec.issueId,
          `⏸️ **Paused — Claude usage limit reached.**\n\n`
            + `The session working this issue (\`${rec.session}\`) was killed when the account's `
            + `5-hour window ran out. Nothing was lost that a re-run cannot redo, but the work is `
            + `**not finished**.\n\n`
            + `The poller has put this issue back in its queue and is holding every dispatch until `
            + `**${resumesAt.toISOString()}**, when the window resets. It will re-dispatch `
            + `automatically then — no action needed.\n\n`
            + `Attempt ${(rec.attempts || 1) + 1} of ${MAX_DISPATCH_ATTEMPTS}.`
        );
      } catch (err) {
        logErr(`could not tell ${rec.identifier} it was paused on the usage limit: ${err.message}`);
      }
      log(`${rec.identifier} requeued — re-dispatches after the usage window resets at ${resumesAt.toISOString()}`);
    }
  }
  const cooling = cooldownRemaining(loadJson(COOLDOWN_PATH, null));
  if (cooling > 0) {
    log(`holding off: a dispatched session ended on the account usage limit — nothing goes out for `
      + `another ${Math.ceil(cooling / 60_000)} min, when the window resets`);
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
          `⚠️ Dispatch failed for \`${issue.identifier}\` — will retry on the next poll (180s).\n\n` +
            '```\n' + String(err.message).slice(0, 1500) + '\n```'
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
  const cred = expiresAt === null
    ? 'credential unreadable'
    : `credential expires ${new Date(expiresAt).toISOString()}`;
  log(`poll ok: ${issues.nodes.length} delegated, ${processed.size} processed total, ${cred}`);
}

// Exported so the tests can exercise routing and the dispatch template without starting a poll —
// a dispatch command that silently renders wrong is the failure this whole file is careful about,
// and it is only checkable if it can be called.
export { workflowFor, buildDispatchArgv, splitCommand, DEFAULT_DISPATCH, dispatchBudget, readClaudeExpiry,
  countRunningSessions, concurrencySlots, busySessionIds, parseLimitReset, cooldownRemaining,
  agentState, isWorking, findSessionByKey, requeueAfterLimit, isBlocked, blockerKeys };

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
