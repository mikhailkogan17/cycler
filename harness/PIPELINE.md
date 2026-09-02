# The pipeline, end to end

How a Linear issue becomes a merged PR. Dispatch, the workflow's own phases, branching, and the gate
— previously spread across `DISPATCH.md`, `GATE.md` and `BRANCHING.md`, and in one case written down
nowhere at all.

## 1. Delegate → session

| # | Step | Who | Concretely |
|---|---|---|---|
| 1 | Delegate | you | `"${CLAUDE_PLUGIN_ROOT}/poller/lin-delegate" APL-14` — sets `delegateId`, **not** assignee |
| 2 | Poll | the launchd job (`launchd.label`, default `dev.cycler.linear`), every 180s | queries `delegate == the Claude OAuth app` |
| 3 | Dispatch | poller | `claude --background --permission-mode auto "<workflow> APL-14"` in `repo.path` |
| 4 | Record | poller | comments the session id on the issue |
| 5 | Resolve | the skill | `lin issue view APL-14` → title + body become the task |
| 6 | Work | `task-orchestration.js` | the phases in §2 |
| 7 | Gate | inside Verify | `gate.sh` |
| 8 | Enforce | `PreToolUse` hooks | contract required before edits; green gate required before commit |
| 9 | PR | workflow | opened, **never merged** |
| 10 | Merge | a human | |

**The trigger is the delegate field.** `linear-cli` exposes `--assignee` and has no delegate flag, so
`lin issue update --assignee claude` looks right in the UI, changes the wrong field and dispatches
nothing. That silent no-op is the easiest way to believe work is queued when it is not.

**`launchctl` addresses jobs by LABEL, not by filename**, and a mismatch fails with a 501 that reads
like "not running". This is not hypothetical: the setup cycler grew out of had a job labelled
`dev.example.agent` living in a plist named after something else, and an `unload` of the
obvious filename silently did nothing while `launchctl list` still showed the job.

Every cycler command therefore derives the filename from the one configured label:

```bash
LABEL="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" launchd.label dev.cycler.linear)"
launchctl kickstart -k "gui/$(id -u)/$LABEL"   # force a poll now
launchctl list | grep "$LABEL"                 # what is actually loaded
```

**Re-dispatching:** `~/.cycler/processed.json` holds the issue UUIDs already dispatched, so
re-delegating something the poller has seen does nothing. Remove its id to force a re-run. Issues in
a `completed` or `canceled` state are skipped regardless.

**A healthy poll** reads `poll ok: 2 delegated, 2 processed total`. If `delegated` grows while
`processed` does not, dispatch is failing — the poller comments the failure on the issue itself, so
look there before the log.

**Which workflow step 3 dispatches** is decided from the issue's labels: `Research` or `Harness` →
`/research`, everything else → `/task`. The dispatch comment names the route and why, so a mis-route
is visible on the board rather than only in the log. `LINEAR_CLAUDE_WORKFLOW` overrides all of it.
See `ROUTING.md` for the full table.

## 2. The workflow's phases

`task-orchestration.js`, one run:

| # | Phase | Agents | Model | Does |
|---|---|---|---|---|
| 1 | Contract | 1 | `opus` | Writes `contracts/<issue>-<slug>.md`. May return `openQuestions` and stop. |
| 2 | Branch | 1 | `haiku` | Creates/reuses `claude/<ISSUE>` off an up-to-date base |
| 3 | Implement | 1 | inherit | Minimal diff inside Allowed paths. Re-entered on every fix round. |
| 4 | Audit | 1 | inherit | Contract compliance. DIRTY → back to 3. |
| 5 | Verify | 1 | inherit | Plans and runs the gate. Red → back to 3. |
| 6 | Commit | 1 | `haiku` | Stages only the contract's files |
| 7 | PR | 1 | `haiku` | `gh pr create`. Never merges. |
| 8 | Review | 4 + N + 1 | mixed | 4 lenses parallel → 1 refuter per blocking finding (cap 12) → synthesis. Blocking → back to 3. Max 2 rounds. |
| 9 | Follow-ups | 1 | `haiku` | Triages the contract's `## Follow-ups`, files survivors to Linear **Triage** |
| 10 | Cleanup | 1 | `haiku` | Releases the lock, removes the worktree on a clean finish |

Lenses: `bugs`, `scope-creep`, `test-gaps`, `contract`. Ceiling ~60 agents.

`verify`, `audit` and `refute` are deliberately **not** downgraded — a weak refuter defaults to
"not real" and silently drops findings, which is worse than not refuting at all.

## 3. Branching

`claude/<ISSUE_ID>`, created off an up-to-date base by the Branch stage, which refuses to run if the
branch would equal the base — so the harness never commits onto `main`.

Not Linear's suggested `feature/apl-n`: the key is uppercased so the branch, the contract filename
and the PR body all carry the same identifier, and `git branch --list 'claude/*'` lists exactly the
harness's branches and nothing else.

## 4. The gate

```bash
CONTRACT_PATH=<contract> bash ${CLAUDE_PLUGIN_ROOT}/harness/gate.sh --fast --base main
```

One line per passing check; only failures print detail; the last line is `GATE: PASS|FAIL`.

**Never run `danger` bare** — it exits 0 even when it fails the build, so a bare run reads as a pass.

**`--fast` and `--full` are your gate's distinction to make.** cycler's default gate runs the same
checks either way; a repo gate typically keeps a slow suite out of `--fast`. Whatever you exclude,
put it in `cycler.yaml` under `verify.steps` so the verify agent still runs it — a check that lives
nowhere is a check nobody runs.

Two things a slow suite teaches, from the repo this grew in: run it **serialized** if your DI
container is a global registry (parallel suites clobber each other's registrations into a hang), and
treat `Test run with 0 tests` as a **failure** — `xcodebuild` prints `** TEST SUCCEEDED **` when a
`-only-testing` filter matches nothing, so a typo reads as a green suite.
This file previously claimed the gate never ran Swift at all, which was false and had a cost — it is
why `--full` stopped being run while ~226 Swift tests sat skipped behind one stale bitmap.

Swift is gated on **`apps/macOS/**`**, not `*.swift` (APL-63): the suite's inputs include snapshot
baselines, fixtures, Assets and `project.yml`, so gating on sources alone meant the one kind of PR
that exists to change test behaviour skipped the tests entirely.

`gate.sh` restores the git index when it finishes. It stages changed files so danger can review them,
but a gate is a *read* of the tree and must not decide what a later commit contains.

Two things it still cannot tell you:

- **It lints only CHANGED files**, so a red repo-wide baseline is invisible to it (APL-59).
- **Its SwiftLint is not the build's SwiftLint** — CLI 0.57.1 on PATH versus `SwiftLintPlugins`
  0.65.0 pinned in `project.yml`. They enforce different rules, so a green `gate.sh` does not imply a
  green Swift build, and the reverse also holds.

## 5. Watching and operating

| want | do |
|---|---|
| list sessions | `claude agents` |
| watch one | `claude attach <id>` |
| read its log | `claude logs <id>` (raw terminal escapes; prefer the transcript) |
| stop one | `claude stop <id>` |
| poller log | `~/.cycler/poller.log` |
| force a poll | `launchctl kickstart -k "gui/$(id -u)/$LABEL"` (see above) |
| read/write Linear | `${CLAUDE_PLUGIN_ROOT}/poller/lin` (use `--body-file` for markdown) |

Inside a dispatched session you are working an issue under `ISSUE-PROCESS.md`. You have no terminal
and nobody is watching: a question asked mid-run blocks forever, so decide and record the decision in
the contract's Risks instead.
