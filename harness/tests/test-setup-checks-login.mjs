// The one credential without which nothing in cycler runs was the only one nothing checked.
//
// `/cycler:doctor` verified that the `claude` binary was an absolute path that exists and is
// executable — and stopped there. Executable is not usable. The CLI's OAuth entry had
// `expiresAt: 0` and could not refresh, so every dispatch spawned a session that died on its first
// turn with `Login expired`. Four consecutive dispatches of one issue went that way. The desktop app
// was signed in the whole time; it reads a different credential, so signing in there repairs nothing.
//
// Separately, setup's "confirm the hooks are active" step was `ls` on the hooks directory. That
// proves the files shipped. It cannot fail when a hook is not firing, so it was a green light wired
// to nothing — the exact shape of check this harness exists to refuse.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let fails = 0;
const t = (n, fn) => { try { fn(); console.log('PASS', n) } catch (e) { fails++; console.log('FAIL', n, '\n  ', e.message) } };

const doctor = readFileSync(join(ROOT, 'commands/doctor.md'), 'utf8');
const setup = readFileSync(join(ROOT, 'commands/setup.md'), 'utf8');

for (const [name, src] of [['doctor', doctor], ['setup', setup]]) {
  t(`${name} runs the claude CLI, not just stat it`, () => {
    assert.match(src, /claude --print/,
      `commands/${name}.md never invokes the CLI — an expired login passes every check it makes`);
  });

  t(`${name} says the desktop app is not the CLI`, () => {
    assert.match(src, /desktop app/i,
      `commands/${name}.md does not warn that signing in to the desktop app leaves the CLI expired — ` +
        'the wrong fix costs a full retry cycle to discover');
  });
}

t('setup does not present `ls` on the hooks directory as proof the hooks are active', () => {
  const section = setup.slice(setup.indexOf('## 6. The hooks'), setup.indexOf('## 7.'));
  assert.ok(section.includes('ls "${CLAUDE_PLUGIN_ROOT}/harness/hooks/'), 'the ls itself is still useful — keep it');
  assert.match(section, /only proves the files shipped/i,
    'the ls is presented as a liveness check again; it cannot fail when a hook is not firing');
  assert.match(section, /denied/i,
    'the section must name the observable that CAN go red — a denial on the first run');
});

t('doctor still checks the binary is absolute — the new check adds to it, not replaces it', () => {
  assert.match(doctor, /absolute/i, 'launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin; a bare `claude` is not found');
});

process.exit(fails ? 1 : 0);
