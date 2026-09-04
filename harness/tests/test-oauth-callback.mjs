// The authorisation callback binds this machine's poller to a Linear workspace. Whoever supplies the
// `code` it accepts decides which workspace that is.
//
// `state` used to be the constant string 'cycler', and the callback read only `code` — so it was
// neither a nonce nor checked, while the comment beside it claimed CSRF protection. While the flow
// is open, localhost:8787 answers a request from any page the browser happens to be on.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLLER = join(HERE, '..', '..', 'poller', 'poller.mjs');
const DOUBLE = join(HERE, 'linear-double', 'double.mjs');

let fails = 0;
const t = async (n, fn) => { try { await fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

// Run `poller.mjs auth`, wait for the authorize URL, then drive the callback ourselves.
async function authFlow(callbackQuery) {
  const home = mkdtempSync(join(tmpdir(), 'cycler-auth-'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ clientId: 'cid', clientSecret: 'csec' }));
  writeFileSync(join(home, 'script.json'), JSON.stringify({}));
  writeFileSync(join(home, 'journal.ndjson'), '');
  const child = spawn(process.execPath, ['--import', DOUBLE, POLLER, 'auth'], {
    env: { ...process.env, CYCLER_HOME: home, CYCLER_NO_BROWSER: '1',
           DOUBLE_SCRIPT: join(home, 'script.json'), DOUBLE_JOURNAL: join(home, 'journal.ndjson') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('auth never printed an authorize URL')), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/Authorize Claude: (\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('auth exited before printing a URL')); });
  });
  const realState = new URL(url).searchParams.get('state');
  const body = await fetch(`http://localhost:8787/callback?${callbackQuery(realState)}`).then((r) => r.text());
  await new Promise((r) => child.on('exit', r));
  return { body, realState, tokenPath: join(home, 'token.json') };
}

await t('a callback carrying the wrong state is REFUSED and stores no token', async () => {
  const { body, tokenPath } = await authFlow(() => 'code=attacker-code&state=cycler');
  assert.ok(!existsSync(tokenPath),
    'a token was stored from a callback this process did not initiate — the poller now holds a token for whichever workspace supplied that code');
  assert.match(body, /Auth failed/, `the refusal was not reported to the browser: ${body}`);
});

await t('a callback carrying the correct state IS accepted', async () => {
  // The other direction. A callback handler that rejected everything would pass the case above.
  const { body, tokenPath } = await authFlow((s) => `code=real-code&state=${s}`);
  assert.ok(existsSync(tokenPath), `the legitimate callback was refused: ${body}`);
  assert.ok(JSON.parse(readFileSync(tokenPath, 'utf8')).access_token, 'no access_token was stored');
});

await t('the state is a per-run nonce, not a constant', async () => {
  const a = await authFlow((s) => `code=c&state=${s}`);
  const b = await authFlow((s) => `code=c&state=${s}`);
  assert.notStrictEqual(a.realState, b.realState, 'two runs used the same state — it is a constant, not a nonce');
  assert.ok(a.realState.length >= 16, `state is too short to be unguessable: ${a.realState}`);
});

await t('the stored token is not world-readable', async () => {
  const { tokenPath } = await authFlow((s) => `code=c&state=${s}`);
  const mode = (await import('node:fs')).statSync(tokenPath).mode & 0o777;
  assert.strictEqual(mode, 0o600, `token.json is mode ${mode.toString(8)}; it holds a workspace credential`);
});

process.exit(fails ? 1 : 0);
