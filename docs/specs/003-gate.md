# Spec 003 — the gate

[ADR 0003](../adr/0003-the-gate-belongs-to-the-repo.md) explains why the gate is the repo's.

## Resolution

| # | Assertion | Test |
|---|---|---|
| 1.1 | `$CLAUDE_PROJECT_DIR/.claude/harness/gate.sh` is used whenever it exists | `test-gate-resolver.mjs` |
| 1.2 | Otherwise `harness/gate.default.sh` is used | `test-gate-resolver.mjs` |
| 1.3 | Arguments reach the chosen gate unchanged | `test-gate-resolver.mjs` |
| 1.4 | The chosen gate's exit status is the resolver's (it `exec`s) | `test-gate-resolver.mjs` |
| 1.5 | Which gate was chosen is printed to **stderr**, never stdout | `test-gate-resolver.mjs` |
| 1.6 | A repo gate that is the plugin's own file does not recurse | — untested |

1.1 and 1.2 are asserted together on purpose: a resolver that always returned the default would pass
1.2 alone and be indistinguishable from a working one. 1.5 keeps stdout as the output contract while
still making the choice visible — silence here is how a repo runs the default for months believing
it runs its own.

## Output contract

Every gate, cycler's or a repo's, must satisfy this. Callers depend on it.

| # | Assertion | Test |
|---|---|---|
| 2.1 | A passing check prints exactly one line | — untested |
| 2.2 | Only failures print detail, capped at `--tail` | — untested |
| 2.3 | The last line is `GATE: PASS\|FAIL (n of m)` | `test-gate-script.mjs` |
| 2.4 | Exit 0 only when every check that ran passed | `test-shell-scripts.mjs` |
| 2.5 | `--only <name>` that ran nothing reports FAIL, not `PASS (0 of 0)` | `test-shell-scripts.mjs` |
| 2.6 | `--base`/`--tail`/`--only` with no value error instead of hanging | `test-shell-scripts.mjs` |
| 2.7 | The gate does not mutate the git index | `test-shell-scripts.mjs` |
| 2.8 | The default gate FAILS when it finds no `lint`/`build`/`test` script | `test-gate-resolver.mjs` |

2.7 is not tidiness. A gate that leaves files staged decides what a following bare `git commit`
includes — so the commit contains more than its author believed, under a message describing only what
they added, with nobody lying.

2.8 is 2.5 at the level of the whole gate.

## The pass marker

| # | Assertion | Test |
|---|---|---|
| 3.1 | A green gate writes `.test-results/gate/last-pass` | `test-require-green-gate-hook.mjs` |
| 3.2 | A red gate deletes it, so no stale pass is honoured | — untested |
| 3.3 | The hash is index-independent: `git add` does not change it | `test-green-gate-marker.mjs` |
| 3.4 | A content change **does** change it | `test-green-gate-marker.mjs` |
| 3.5 | A deletion changes it | `test-green-gate-marker.mjs` |
| 3.6 | Gate and hook compute it with the **same** script | `test-require-green-gate-hook.mjs` |

3.1 and 3.6 cited `test-green-gate-marker.mjs` until an audit checked: that file tests
`tree-fingerprint.sh` and mentions neither the marker path nor the gate. Four rows across two specs
said the commit hook was covered while it had no test at all, and the hook could be deleted with all
25 files still green. A citation that makes a gap look covered is the same defect as a check that
cannot fail, one level up — so these rows now name the test that actually asserts them.

3.3 and 3.4 are the pair. Asserting only 3.4 was possible before, and the old implementation would
have passed it while making every commit impossible — see
[ADR 0007](../adr/0007-index-independent-gate-marker.md).

## Writing your own

Copy `harness/gate.default.sh` to `.claude/harness/gate.sh` and replace the checks. You inherit the
runner: argument handling, changed-file sets, the output contract, the marker.

Two rules to keep:

- **A check that cannot fail is not a check.** If nothing ran, report FAIL.
- **Never trust an exit code you have not verified.** `danger local` prints
  `Failing the build, there is 1 fail.` and exits **0**. Until the gate grepped for that string,
  danger was advisory while every report said it was blocking.
