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
 * Repo, dispatch command and routes come from cycler.yaml (see cycler.example.yaml).
 *
 * One-time setup:
 *   1. Linear → Settings → API → Applications → New application
 *      - Name: Claude   (this is how the agent appears in Linear)
 *      - Callback URL: http://localhost:8787/callback
 *      - Webhooks: NOT needed
 *   2. /cycler:setup writes ~/.cycler/config.json { "clientId", "clientSecret" } and cycler.yaml
 *   3. node poller/poller.mjs auth     # browser opens; approve; token saved
 *   4. /cycler:start-polling           # loads the launchd job that runs this every 180s
 *
 * Re-dispatch an issue: remove its id from ~/.cycler/processed.json
 * Re-auth (if token revoked): run the `auth` subcommand again.
 * Config edits: take effect on the next launchd run (every 180s); force now with
 *   launchctl kickstart -k gui/$(id -u)/dev.cycler.linear
 */

import { spawn, exec } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lib/yaml.mjs';

const DIR = process.env.CYCLER_HOME || join(homedir(), '.cycler');
const CONFIG_PATH = join(DIR, 'config.json');
const TOKEN_PATH = join(DIR, 'token.json');
const STATE_PATH = join(DIR, 'processed.json');

const REDIRECT_URI = 'http://localhost:8787/callback';
const SCOPES = 'read,write,app:assignable,app:mentionable';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'; // use absolute path under launchd
// cycler.yaml is the source of truth for everything below; the env vars stay as overrides because
// launchd is easier to debug when you can force one value without editing a file.
const ycfg = readConfig();
const expand = (v) => String(v).replace(/^~(?=$|\/)/, homedir());
const REPO_PATH = expand(process.env.REPO_PATH || ycfg.repo?.path || '~/your-repo');
const PATH_PREPEND = (ycfg.dispatch?.pathPrepend?.length
  ? cfg.dispatch.pathPrepend
  : ['~/.local/bin', '~/bin', '/opt/homebrew/bin', '/usr/local/bin']).map(expand);
// /task runs the contract -> implement -> audit -> gate -> PR workflow. Measured against running the
// harness inline in one long-lived session on the same issue and contract: 1.68M subagent tokens and a
// merged PR, versus 10.77M and nothing shipped. There is no /start command in this repo — dispatching
// it sent the session a literal string with no skill behind it.
const WORKFLOW = process.env.CYCLER_WORKFLOW || ycfg.routes?.default || '/cycler:task';
const MAX_PER_POLL = 50;

// Route by label, per harness/ROUTING.md. Until this existed the poller dispatched /task for
// EVERYTHING, so that table was advice the only automated path ignored — a Research issue got a
// contract-and-gate run for work that produces no diff, and a Harness issue got an implementer that
// is forbidden `.claude/**` and therefore cannot pass its own audit.
//
// Deliberately a lookup on a label a human already wrote, not a classifier. A model here would infer,
// less reliably, something already recorded — and a router that picks /task for everything is
// indistinguishable from a working one until something audits its choices.
//
// CYCLER_WORKFLOW still overrides everything, for a one-off or a bisect.
const ROUTES = (Array.isArray(ycfg.routes?.byLabel) && cfg.routes.byLabel.length
  ? cfg.routes.byLabel.map((r) => [String(r.label).toLowerCase(), r.workflow, r.why || 'configured route'])
  : [['research', '/cycler:research', 'decision, not a diff — nothing to gate or audit']]);
function workflowFor(issue) {
  if (process.env.CYCLER_WORKFLOW) return { workflow: WORKFLOW, why: 'CYCLER_WORKFLOW override' };
  const labels = (issue.labels?.nodes || []).map((l) => String(l.name || '').toLowerCase());
  for (const [label, workflow, why] of ROUTES) {
    if (labels.includes(label)) return { workflow, why: `label "${label}": ${why}` };
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

/**
 * Linear OAuth access tokens last 24h (`expires_in: 86399`). Without a refresh the poller silently
 * stops dispatching a day after `auth`, and the symptom is a 401 that reads like a network fault —
 * it cost most of a week of debugging on the previous orchestrator before the expiry was noticed.
 * The refresh token is long-lived, so one retry on 401 keeps this running indefinitely.
 */
async function refreshToken() {
  const cfg = loadJson(CONFIG_PATH, null);
  const tok = loadJson(TOKEN_PATH, {});
  if (!cfg?.clientId || !cfg?.clientSecret || !tok.refresh_token) return false;
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: tok.refresh_token,
    }),
  });
  const data = await res.json();
  if (!data.access_token) return false;
  // Merge: a refresh response may omit refresh_token, and dropping it would make the NEXT refresh
  // impossible — turning a self-healing poller into one that dies 24h later.
  writeFileSync(TOKEN_PATH, JSON.stringify({ ...tok, ...data }, null, 2));
  log('token refreshed (expires_in', data.expires_in, 's)');
  return true;
}

async function gqlOnce(query, variables) {
  const { access_token } = loadJson(TOKEN_PATH, {});
  if (!access_token) throw new Error('No token. Run: /cycler:setup (or: node poller/poller.mjs auth)');
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
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg?.clientId || !cfg?.clientSecret) {
    throw new Error(`Missing ${CONFIG_PATH} with { "clientId", "clientSecret" }`);
  }
  const url =
    'https://linear.app/oauth/authorize' +
    `?client_id=${cfg.clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    '&response_type=code' +
    `&scope=${encodeURIComponent(SCOPES)}` +
    '&actor=app' + // app acts as itself ("Claude"), not as you
    '&state=linear-claude';

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost:8787');
    if (u.pathname !== '/callback') { res.end('ignored'); return; }
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: REDIRECT_URI,
        code: u.searchParams.get('code'),
      });
      const r = await fetch('https://api.linear.app/oauth/token', { method: 'POST', body });
      const data = await r.json();
      if (!data.access_token) throw new Error(JSON.stringify(data));
      writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
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
    exec(`open "${url}"`); // macOS
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
  const tpl = ycfg.dispatch?.command || DEFAULT_DISPATCH;
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
  // The whole command is configurable (cycler.yaml: dispatch.command). The default is the one that
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
  const sessionId = await new Promise((resolve, reject) => {
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
  await comment(
    issue.id,
    `⚡ Dispatched "${sessionName}"${sessionId ? ` — session \`${sessionId}\`` : ''} in \`${REPO_PATH}\`` +
      `\n\n**Route:** \`${workflow}\` — ${why}` +
      `\n\nWatch it: \`claude attach ${sessionId || '<id>'}\` · \`claude logs ${sessionId || '<id>'}\``
  );
  log(`dispatched ${issue.identifier} workflow=${workflow} session=${sessionId || 'unknown'}`);
}

async function poll() {
  const { viewer } = await gql('query { viewer { id } }');
  const { issues } = await gql(
    `query ($delegateId: ID!) {
       issues(first: ${MAX_PER_POLL}, filter: { delegate: { id: { eq: $delegateId } } }) {
         nodes { id identifier title state { type } labels { nodes { name } } }
       }
     }`,
    { delegateId: viewer.id }
  );

  const processed = new Set(loadJson(STATE_PATH, []));
  let changed = false;

  for (const issue of issues.nodes) {
    if (processed.has(issue.id)) continue;
    if (['completed', 'canceled'].includes(issue.state?.type)) continue;
    if (!existsSync(REPO_PATH)) throw new Error(`REPO_PATH not found: ${REPO_PATH}`);
    try {
      await dispatch(issue);
      processed.add(issue.id);
      changed = true;
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
  log(`poll ok: ${issues.nodes.length} delegated, ${processed.size} processed total`);
}

// Exported so the tests can exercise routing and the dispatch template without starting a poll —
// a dispatch command that silently renders wrong is the failure this whole file is careful about,
// and it is only checkable if it can be called.
export { workflowFor, buildDispatchArgv, splitCommand, DEFAULT_DISPATCH };

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
