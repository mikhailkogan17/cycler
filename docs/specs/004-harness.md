# Spec 004 — the harness

`workflows/task-orchestration.js` plus `harness/hooks/`. Reference prose lives in
`harness/HARNESS.md`; this file is the assertions.

## Phases

`Contract → Branch → Implement → Audit → Verify → Commit → PR → Review → Follow-ups → Cleanup`

| # | Assertion | Test |
|---|---|---|
| 1.1 | A run with open questions stops and posts them rather than implementing a guess | `test-apl36.mjs` |
| 1.2 | The branch is `<branchPrefix><ISSUE-KEY>`, off an up-to-date base | `test-apl35.mjs` |
| 1.3 | The harness never commits onto the base branch | `test-apl35.mjs` |
| 1.4 | It opens a PR and **never** merges | — untested |
| 1.5 | An issue key is parsed from a bare key or a Linear URL | `test-apl35.mjs` |

## Hooks

[ADR 0006](../adr/0006-enforcement-outside-the-agent.md).

| # | Assertion | Test |
|---|---|---|
| 2.1 | An edit with no contract for this issue is denied | `test-require-contract-hook.mjs` |
| 2.2 | A contract for a **different** issue does not satisfy the hook | `test-require-contract-hook.mjs` |
| 2.3 | A commit with no green marker is denied | `test-green-gate-marker.mjs` |
| 2.4 | A commit after an edit invalidating the marker is denied | `test-green-gate-marker.mjs` |
| 2.5 | Editing past `escapeHatch` limits is denied, with the reason | `test-escape-hatch-hook.mjs` |
| 2.6 | An explicit waiver in the contract re-opens the escape hatch | `test-escape-hatch-hook.mjs` |
| 2.7 | A write outside the session's worktree is denied | `test-confine-to-worktree.mjs` |
| 2.8 | The plan-mode plan file is exempt from 2.7 | `test-confine-to-worktree.mjs` |
| 2.9 | That exemption is a literal match, not a general escape | `test-confine-to-worktree.mjs` |

2.2 exists because the hook once picked the **newest** contract in the directory (`ls -t | head -1`),
so a concurrent run's contract judged this run's edit.

## Concurrency

| # | Assertion | Test |
|---|---|---|
| 3.1 | A working tree hosts at most one run; the second refuses | `test-apl45.mjs` |
| 3.2 | `worktree: true` gives the run its own git worktree | `test-apl45.mjs` |
| 3.3 | A shared-tree run leaks no worktree path into its prompts | `test-apl45.mjs` |
| 3.4 | Cleanup reports the lock as *possibly held* when it cannot confirm release | `test-apl45.mjs` |
| 3.5 | With `worktree.linkWorkspace`, the worktree gets a **real** `node_modules` | `test-worktree-node-modules.mjs` |
| 3.6 | The prompt names the forbidden symlink **only** inside a prohibition | `test-worktree-node-modules.mjs` |

3.6 is unusual and worth keeping: the prompt must mention `ln -s "$P/node_modules"` in order to forbid
it, so the test checks that every occurrence is preceded by a negation. Absence would be the wrong
assertion — it would pass on a prompt that dropped the warning entirely.

## Review

| # | Assertion | Test |
|---|---|---|
| 4.1 | Round 1 runs all four lenses over the full branch diff | `test-apl42.mjs` |
| 4.2 | Later rounds re-run only lenses that raised a blocking finding | `test-apl42.mjs` |
| 4.3 | Only blocking findings get a refuter | `test-refute-blocking-only.mjs` |
| 4.4 | A review of only nits spawns no refuters | `test-refute-blocking-only.mjs` |
| 4.5 | Fan-out is capped per lens, per round and overall | `test-apl9.mjs` |
| 4.6 | Anything a cap cut short is stated in the result | `test-apl42.mjs` |
| 4.7 | The gate and review loops have independent fix budgets | `test-apl9.mjs` |

4.6 is the one that keeps the rest honest: a truncated review must never read as a complete one.

## Models

| # | Assertion | Test |
|---|---|---|
| 5.1 | Mechanical stages route to a cheap model | `test-followups.mjs` |
| 5.2 | Verify, audit and refute are **not** downgraded | — untested |

5.2 is a correctness property, not a cost one — a downgraded refuter silently drops findings — and it
is currently unasserted. It should be a test.

## Follow-ups

| # | Assertion | Test |
|---|---|---|
| 6.1 | Follow-ups are filed as issues, not PR prose | `test-followups.mjs` |
| 6.2 | At most 3 per run | `test-followups.mjs` |
| 6.3 | Filed with the bundled `lin`, never an MCP server | `test-gql-not-inlined.mjs` |
| 6.4 | A confirmed defect neither fixed nor filed is a **blocking** review finding | — untested |

6.3 is not a preference: an MCP server does not reliably connect in a dispatched session, and a run
that ended with "please file this manually" left the finding unfiled.

## Repo-specific behaviour

| # | Assertion | Test |
|---|---|---|
| 7.1 | An unconfigured run names no project-specific build system in any prompt | `test-repo-specifics-are-config.mjs` |
| 7.2 | `verify.steps` are the only source of extra verification | `test-repo-specifics-are-config.mjs` |

7.1 greps every prompt of a full simulated run. It exists because the workflow shipped one project's
Xcode schemes to every user for as long as it had users.

## Known gaps

- 1.4, 5.2 and 6.4 are unasserted, and 5.2 and 6.4 are correctness properties rather than cosmetics.
- No test runs the workflow against a real repo; `sim.mjs` stubs the runtime, so every assertion above
  is about **what an agent is told**, not what it does. That is the right layer for prompt bugs and
  the wrong one for everything else.
