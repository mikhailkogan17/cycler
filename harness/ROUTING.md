# Which harness runs this issue

Three ways to work an issue: `/research`, `/task`, and just doing it. Picking wrong is
expensive in both directions — a one-line fix through the full harness pays for a contract, an audit,
a gate and a review panel; a macOS feature done by hand skips all four.

## The table

**First clear match wins.** Read top to bottom.

The first two rows are **enforced, not advisory**: `poller/poller.mjs` reads the issue's
labels and dispatches the workflow `routes.byLabel` names — `/cycler:research` for `Research` by
default — falling back to `routes.default`, and names the route
it chose in the dispatch comment. Until that existed the poller ran `/task` for everything, so this
table was advice the only automated path ignored. The rest of the table is still judgement — it
depends on things no label records, like whether an issue is too thin to contract from.

| The issue is… | Route | Why |
|---|---|---|
| labelled `Research`, or its deliverable is a decision rather than a diff | **`/research`** | Nothing to gate, nothing to audit, no diff to review. ~80-120k. |
| a one-line fix, a typo, a version bump | **do it directly** | Contract + audit + review costs more than the change. The gate hook still applies. |
| too thin to state acceptance checks without guessing | **stop and ask** | Documented in `ISSUE-PROCESS.md`. A guess costs more than a question. |
| a `Bug` with a reproducible symptom | **`/task`** | `modes/fix.md`. The regression test is the deliverable. |
| a `Feature` / `Improvement` / `Tech Debt` with a clear spec | **`/task`** | `modes/build.md`. |
| >8 files, or touching `apps/macOS/**` | **`/task` with `worktree: true`** | The escape hatch in `ISSUE-PROCESS.md`. macOS needs `--full` or a hand-run Swift suite either way. |

Whatever the route: **`gate.sh` gates the commit.** That is not a routing decision, it is a hook.

And whatever the route, **the way to start work on an issue is `"${CLAUDE_PLUGIN_ROOT}/poller/lin-delegate" APL-N`**, not a
locally-spawned agent. The poller turns a delegation into a real session and records it on the issue;
a subagent records nothing outside the conversation that spawned it. `PIPELINE.md` has the details,
including why `--assignee` is the wrong field and dispatches nothing.

This does **not** apply to the workflow's own audit and review stages. Those are subagents too, and
they are the point: a reviewer that did not write the diff. A run that skips them is not a cheaper
run, it is an unreviewed one — and it must say so.

## Why this is a table and not a classifier

An LLM router for this would cost a call per issue to reproduce a decision that is already a lookup
on the issue's own label. The label is written by a human who read the issue; a classifier would be
inferring, less reliably, something already recorded.

It would also be the fifth check this repo has found that cannot fail. A router that picks `/task`
for everything is indistinguishable from a working router until you audit its choices — and nothing
here audits them. A table is wrong in public: you can read it, disagree, and point at the row.

Where a classifier does earn its cost is when the signal is genuinely unstructured — no label, no
key, free-form prose. Worth noting that flow-next's own router, the closest thing the ecosystem has,
is also a matrix of named starting states with "first clear match wins" — a decision table with a
model reading it, not a model deciding on its own.

So: if the labels stop being reliable, fix the labels. That is cheaper than a router, and it fixes
the board at the same time.

## Cost, measured

From one night of real runs, whole-agent tokens:

| route | issue | cost |
|---|---|---|
| `/research` | APL-27 testing strategy | 83k |
| `/research` | APL-25 legal exposure | 117k |
| `/task`-shaped, TypeScript | APL-55 reply-sweep | 134k |
| `/task`-shaped, macOS | APL-19 chart window | 123k |
| `/task`-shaped, macOS + tooling | APL-57 snapshot baseline | 163k |
| investigation ending in won't-do | APL-56 | 80k |
| flow-next (removed; kept as the measurement) | APL-16 | 596k (4 scouts + gap analyst + 2 workers + reviewer) |

Two things fall out of that. Flow-next's fan-out costs roughly 4-5x a direct `/task`-shaped run, and it
earned it on APL-16 by finding constraints nothing else did — so it is worth it on thin or
high-stakes issues and wasteful on clear ones. And an investigation that ends in "don't build this"
(APL-56, 80k) is among the cheapest useful outcomes available; routing such an issue to `/task` would
have spent several times that before reaching the same conclusion.
