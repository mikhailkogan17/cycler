// Executable tests for the two shell scripts the gate actually depends on.
//
// Every other test in this directory asserts PROMPT SUBSTRINGS via sim.mjs. That layer cannot see a
// bug in ~350 lines of bash. An independent review found four blocking defects in these scripts by
// simply RUNNING them — a `--only` check that reported PASS having run nothing, `vitest related`
// matching zero tests and reporting green, a forbidden-path DELETION invisible to danger, and
// `link-workspace.sh` writing through a symlinked scope directory into the MAIN checkout.
//
// These run the real scripts against throwaway fixtures.
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..')
// LINK_SH / GATE_SH override the scripts under test, mirroring the WF= convention used by the
// sim-based tests — so a fix can be shown to fail against the pre-fix copy.
const LINK = process.env.LINK_SH || join(HARNESS, 'link-workspace.sh')
const GATE = process.env.GATE_SH || join(HARNESS, 'gate.sh')

let fails = 0
const t = (name, fn) => { try { fn(); console.log('PASS', name) } catch (e) {
  // A test whose PRECONDITION is absent must say SKIP, not PASS. This case exists because a check
  // that cannot fail on the input it judges is the failure this harness is built around, and a
  // vacuously green test is that same bug one level up.
  if (e && e.skip) { console.log('SKIP', name, '—', e.message); return }
  fails++; console.log('FAIL', name, '\n  ', e.message)
} }
const skip = (why) => { const e = new Error(why); e.skip = true; throw e }

// Runs a command, never throws: returns { code, out }.
function sh(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000, ...opts })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

// A minimal npm-workspace pair: a "main checkout" and a "worktree".
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lw-'))
  for (const side of ['main', 'wt']) {
    mkdirSync(join(root, side, 'packages', 'shared'), { recursive: true })
    mkdirSync(join(root, side, 'node_modules'), { recursive: true })
    writeFileSync(join(root, side, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }))
    writeFileSync(join(root, side, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@acme/shared' }))
  }
  mkdirSync(join(root, 'main', 'node_modules', '@acme'), { recursive: true })
  symlinkSync('../../packages/shared', join(root, 'main', 'node_modules', '@acme', 'shared'))
  writeFileSync(join(root, 'main', 'node_modules', 'lodash.js'), '// third party')
  return { root, main: join(root, 'main'), wt: join(root, 'wt') }
}
const mainShared = (f) => readlinkSync(join(f.main, 'node_modules', '@acme', 'shared'))

t('link-workspace: a SYMLINKED scope dir must not be written through into the main checkout', () => {
  const f = fixture()
  // The exact pre-state that corrupted the main checkout: wt/node_modules/@acme -> main's.
  symlinkSync(join(f.main, 'node_modules', '@acme'), join(f.wt, 'node_modules', '@acme'))
  const before = mainShared(f)
  const r = sh('bash', [LINK, f.wt, f.main])
  assert.strictEqual(r.code, 0, `script failed: ${r.out}`)
  assert.strictEqual(mainShared(f), before,
    'the MAIN checkout was repointed at the worktree — the corruption AGENTS.md documents')
  assert.ok(readlinkSync(join(f.wt, 'node_modules', '@acme', 'shared')).startsWith(f.wt),
    "the worktree's own link must point inside the worktree")
  rmSync(f.root, { recursive: true, force: true })
})

t('link-workspace: a whole-node_modules symlink is replaced, not followed', () => {
  const f = fixture()
  rmSync(join(f.wt, 'node_modules'), { recursive: true, force: true })
  symlinkSync(join(f.main, 'node_modules'), join(f.wt, 'node_modules'))
  const before = mainShared(f)
  const r = sh('bash', [LINK, f.wt, f.main])
  assert.strictEqual(r.code, 0, `script failed: ${r.out}`)
  assert.strictEqual(mainShared(f), before, 'main checkout must be untouched')
  assert.ok(readlinkSync(join(f.wt, 'node_modules', '@acme', 'shared')).startsWith(f.wt))
  rmSync(f.root, { recursive: true, force: true })
})

t('link-workspace: running it twice is safe and still correct', () => {
  const f = fixture()
  sh('bash', [LINK, f.wt, f.main])
  const before = mainShared(f)
  const r = sh('bash', [LINK, f.wt, f.main])
  assert.strictEqual(r.code, 0, `second run failed: ${r.out}`)
  assert.strictEqual(mainShared(f), before)
  assert.ok(readlinkSync(join(f.wt, 'node_modules', '@acme', 'shared')).startsWith(f.wt))
  rmSync(f.root, { recursive: true, force: true })
})

t('link-workspace: refuses when the worktree IS the main checkout', () => {
  const f = fixture()
  const r = sh('bash', [LINK, f.main, f.main])
  assert.strictEqual(r.code, 0)
  assert.ok(/IS the main checkout/.test(r.out), `expected a no-op message, got: ${r.out}`)
  assert.strictEqual(mainShared(f), '../../packages/shared', 'a self-run must change nothing')
  rmSync(f.root, { recursive: true, force: true })
})

t('link-workspace: third-party packages are linked, workspace packages are not shared', () => {
  const f = fixture()
  const r = sh('bash', [LINK, f.wt, f.main])
  assert.strictEqual(r.code, 0, r.out)
  assert.ok(existsSync(join(f.wt, 'node_modules', 'lodash.js')), 'third-party entry must be available')
  assert.ok(readlinkSync(join(f.wt, 'node_modules', 'lodash.js')).startsWith(f.main),
    'third-party entries point at the main checkout (no re-download)')
  rmSync(f.root, { recursive: true, force: true })
})

// ---- gate.sh argument and exit-code contract (no npm needed) ----
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gate-'))
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: root })
  writeFileSync(join(root, 'a.txt'), 'hello\n')
  execSync('git add -A && git commit -qm init', { cwd: root })
  return root
}

t('gate.sh: --only on a check that gets SKIPPED must not report PASS', () => {
  const root = gitRepo()
  // danger skips without CONTRACT_PATH. It must not read as a pass — this is `npm run gate:diff`.
  const r = sh('bash', [GATE, '--only', 'danger'], { cwd: root, env: { ...process.env, CONTRACT_PATH: '' } })
  assert.notStrictEqual(r.code, 0, `a gate that ran nothing exited 0:\n${r.out}`)
  assert.ok(/GATE: FAIL/.test(r.out), `expected GATE: FAIL, got:\n${r.out}`)
  rmSync(root, { recursive: true, force: true })
})

t('gate.sh: the index survives a run — a gate must not decide what lands in a git commit', () => {
  const root = gitRepo()
  // Two changes: one the author staged on purpose, one they deliberately left out.
  writeFileSync(join(root, 'staged.txt'), 'mine\n')
  writeFileSync(join(root, 'unstaged.txt'), 'not mine\n')
  execSync('git add staged.txt', { cwd: root })

  const before = execSync('git diff --cached --name-only', { cwd: root }).toString().trim()
  assert.strictEqual(before, 'staged.txt', 'test setup: only staged.txt should start staged')

  // danger stages every changed file so it can review the index. That is fine; leaving them staged
  // is not. gate.sh used to, so a later bare commit swept in unstaged.txt under a message describing
  // only staged.txt — the commit held more than its author believed, and nobody lied.
  sh('bash', [GATE, '--fast'], { cwd: root, env: { ...process.env, CONTRACT_PATH: 'x.md' } })

  const after = execSync('git diff --cached --name-only', { cwd: root }).toString().trim()
  assert.strictEqual(after, before, `gate.sh mutated the index: before [${before}] after [${after}]`)
  rmSync(root, { recursive: true, force: true })
})

t('gate.sh: a non-.swift change under apps/macOS still gates the Swift suite', () => {
  const root = gitRepo()
  // APL-63. swift-tests used to sit inside the CHANGED_SWIFT guard, so a diff that touched no .swift
  // file skipped it — and the PR that exists to change Swift TEST behaviour, re-recording a snapshot
  // baseline, is exactly that diff. APL-57 re-recorded a baseline and --full reported PASS having run
  // no Swift test at all. The suite's inputs are wider than its sources: baselines, fixtures, Assets,
  // project.yml. A check that cannot run on the change it is about is not a check.
  execSync('mkdir -p apps/macOS/AppTests/Support/Fixtures', { cwd: root })
  writeFileSync(join(root, 'apps/macOS/AppTests/Support/Fixtures/stats.json'), '{}\n')

  // xcodebuild is hidden, so the check cannot actually run — the point is WHICH skip is reported.
  // "no changed apps/macOS files" means the gate never considered it; anything else means it did.
  const r = sh('bash', [GATE, '--full', '--only', 'swift-tests'],
    { cwd: root, env: { ...process.env, PATH: '/usr/bin:/bin', CONTRACT_PATH: 'x.md' } })
  // cycler's DEFAULT gate has no Swift checks — this case is about a repo gate that does.
  // Without this guard the assertions below would pass vacuously against the default, which is
  // precisely the kind of green-that-cannot-go-red the rest of this file exists to catch.
  if (/matched no check/.test(r.out)) skip('the gate under test has no swift-tests check')
  assert.ok(!/no changed apps\/macOS files/.test(r.out),
    `a fixture change under apps/macOS was treated as nothing to test:\n${r.out}`)
  assert.ok(!/no changed \.swift files/.test(r.out),
    `swift-tests is still gated on .swift sources only:\n${r.out}`)
  rmSync(root, { recursive: true, force: true })
})

t('gate.sh: --only with an unknown name fails', () => {
  const root = gitRepo()
  const r = sh('bash', [GATE, '--only', 'nosuchcheck'], { cwd: root })
  assert.notStrictEqual(r.code, 0)
  assert.ok(/matched no check/.test(r.out), r.out)
  rmSync(root, { recursive: true, force: true })
})

for (const flag of ['--only', '--base', '--tail']) {
  t(`gate.sh: ${flag} with no value errors instead of hanging forever`, () => {
    const root = gitRepo()
    // `shift 2` with one argument left does not shift and returns non-zero, so the arg loop spins.
    // The 20s timeout in sh() is the hang detector.
    const r = sh('bash', [GATE, flag], { cwd: root })
    assert.strictEqual(r.code, 2, `expected exit 2, got ${r.code}:\n${r.out}`)
    assert.ok(/requires a value/.test(r.out), r.out)
    rmSync(root, { recursive: true, force: true })
  })
}

process.exit(fails ? 1 : 0)
