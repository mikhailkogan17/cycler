# Harness — applygent

Strict contract-first harness so even the cheapest executor model behaves reliably.

**The orchestrator is the frontier model and decides for itself.** All task work runs in ONE workflow,
`task-orchestration` (`${CLAUDE_PLUGIN_ROOT}/workflows/task-orchestration.js`, invoked via `Workflow({ scriptPath: '<repo root>/${CLAUDE_PLUGIN_ROOT}/workflows/task-orchestration.js', args })`). The orchestrator dispatches each
stage to any available model **lower than its own** via `args.executorModel`; omit to inherit.

**Available models, ordered strong → weak:** `opus` → `sonnet` → `haiku`/`fable`.
"Lower than current" = any weaker entry in this list. Caveat: if `CLAUDE_CODE_SUBAGENT_MODEL` is set it
silently overrides `args.executorModel`.

## The flow (all inside `task-orchestration`)

`/task` → one workflow run:

```
contract → implement → audit → verify → commit → PR → review
```

| Stage | Agent(s) | Output / gate |
|---|---|---|
| Contract | contract author | `.claude/harness/contracts/<slug>.md` (skipped if `contractPath` passed) |
| Implement | implementer | minimal diff + command journal |
| Audit | auditor (independent context) | clean / issues — loops back to Implement |
| Verify | gate planner → check runners (parallel, long xcodebuild isolated) → reporter | final-gate report (pre-commit) |
| Commit | committer | commit + push of contract-listed files; skipped on `noCommit` |
| PR | pr-opener | `gh pr create --base <prBase>` (default `main`); never merges |
| Review | 4 lenses (bugs / scope-creep / test-gaps / contract) → adversarial refuters → synthesis | blocking issues → Implement (fixes pushed to the PR) or APPROVED |

## Self-correcting loop

Two gates. **Pre-commit:** audit → verify run after every Implement round; any failure returns to
**Implement** with the exact issues/blockers until clean (clean audit + green gate). **Post-commit:** the
diff is committed, pushed, and a PR opened to `prBase` (default `main`); **Review** then runs against the
committed diff (`git diff <prBase>...HEAD`). Blocking review issues return to **Implement**; each fix round
is committed, pushed to the SAME PR, and re-reviewed. The harness never merges — merging is the user's call.

Caps: the two loops have **separate budgets** (APL-9) — `args.gateFixMax` for the pre-commit loop and
`args.reviewFixMax` for the post-commit review loop, each defaulting to `args.fixMax` (default **2**).
They used to share one counter, so a task needing both gate rounds opened its PR with zero review rounds
left and returned `blocked` on the review loop's first iteration. Each loop now counts only its own rounds
(`fixLog` stays one chronological record; the blocked result carries both `gateFixMax` and `reviewFixMax`). The run returns `blocked` at the failing stage
(audit / verify / review — there is never a `repair` stage) only if the cap is exhausted
(`roundsExhausted: true` + `lastFailure`), or the implementer/contract stage failed. `fixLog` records every
fix round (stage, issues, fix summary). Review-fix rounds skip the heavy verify gate; the review's
contract/scope-creep lenses cover compliance.

## Rules

- **Contract first.** No code before the contract contains acceptance checks. Every stage reads the SAME
  contract file.
- **Contract is read-only after stage 1.** No agent (implementer, committer) may modify the
  contract file or the gate tooling (`dangerfile.js`, `eslint.config.js`, `.yamllint`,
  `package.json`) — changing the gate or contract to dodge a red check is itself a blocking scope
  violation. The auditor verifies the contract file is unchanged. Gate tooling and tests are in the
  CONTRACT.md default Forbidden paths.
- **One workflow, always.** No ad-hoc parallel subagents, no per-stage workflows. `/task` calls
  `task-orchestration` once. This constrains the shape of a single run; it does not forbid running
  several independent `/task` runs at the same time — see **Concurrency** below for the terms.
- **One tree, one run.** (APL-45) A working tree may host exactly one run. Enforced, not trusted: a
  shared-tree run takes an exclusive lock and a second one is refused with the holder named; a
  `worktree: true` run gets its own directory, and git itself refuses to check the same branch out twice.
  The harness never `--force`s past that refusal, because two runs on one branch is precisely the
  corruption the rule exists to prevent.
- **PRs, never merges.** The harness pushes the branch and opens a PR to `prBase`; it never merges, never
  force-pushes, and never rewrites the base. `noCommit: true` stops before commit for manual review.
- **Harness edits go through the loop like anything else.** `.claude/**` is not a forbidden path, so a
  run that changes the harness can pass its own audit. The one thing that stays forbidden is a run
  editing the contract that governs it, or the gate that judges it — that is not self-improvement, it is
  moving the goalposts, and `audit.sh` checks for it.
- **Independent context.** Auditor and reviewers get the contract + `git diff`, never the implementer's
  narration.
- **Hard gate.** Any red → `BLOCKED` with the exact command + output. Never "should work". A missing tool
  is a `BLOCKED` with install instructions, not a pass. (Check agents are mechanical: run one command,
  report exit code + last lines.)
- **The gate is a script.** `${CLAUDE_PLUGIN_ROOT}/harness/gate.sh` — one command, one line per check, detail only on
  failure. Verify runs it; it no longer plans a gate per round. See `PIPELINE.md`.
- **Deterministic diff review.** `gate.sh` stages the task's changed files
  (`git add <changed-files>`), then runs `CONTRACT_PATH=<contract> danger local --staging --base main`
  (`dangerfile.js`) — so the secrets/forbidden-paths/generated-files net reviews the TASK's own diff, not
  the previous commit. danger is optional — skipped if not installed. The staged task files then feed the
  review + commit stages.
- **Memory, not chat history.** After a run save only `decision` / `constraint` / `failure` records.
- **No security hooks** (git push / `.env` blocking) — user amendment 2026-08-07.
- **Generated dirs stay out of git:** `dist/`, `.test-results/`, `.mastra/`, `xcuserdata/`.
- **Task contracts stay out of git:** `.claude/harness/contracts/` is gitignored — contracts are
  single-run working artifacts, never committed.

## Mid-run sign-off

The workflow cannot take user input mid-run by design (single-shot). Three controls:
- `noCommit: true` — the workflow stops before committing; you review the diff, then commit manually.
- author a contract manually (`.claude/harness/contracts/` via the CONTRACT.md template) and pass
  `contractPath` — the workflow uses it as-is.
- `stopAtContract: true` (plan mode) — the workflow stops right after the contract stage and returns
  `{ status: 'plan', stage: 'contract', contractPath, openQuestions }`. The orchestrator presents the
  contract as the plan (writes it to the plan file, calls `ExitPlanMode`), then re-invokes with
  `contractPath` on approval. Plan-mode detection is soft: the orchestrator reads the "Plan mode is
  active" reminder in its own context — there is no env var. A deterministic signal would come from a
  hook's `permission_mode: "plan"` written to a file the skill reads (not currently wired).

## Escalation (orchestrator's call)

Reach for a stronger model / extra care on: auth/security, multi-repo changes, migrations, production
incidents, or two consecutive `BLOCKED` verifications.

## Worktrees (APL-10)

Findings from closing the leak, since the original issue guessed wrong about the source:

- `task-orchestration.js` does **not** use `isolation: 'worktree'`, and the deprecated `/implement` skill
  never created worktrees either. Every worktree under `.claude/worktrees/` comes from `EnterWorktree`,
  and every one of them **is** correctly registered with git — checked 1:1 against `.git/worktrees/`.
  There is no "creates an unregistered worktree" bug to fix.
- The actual leak is that **nothing removes a worktree when the session ends**. They pile up *registered*,
  so a `git worktree list` sanity check shows nothing wrong, and the moment one is renamed or its admin
  record goes stale `git worktree prune` deregisters it and the directory becomes an orphan. That is
  exactly the shape of the 826 MB `t3-telegram-notifications.old-<epoch>` — a renamed worktree.
- Since `.claude/worktrees/` is gitignored, orphans now regrow **silently**. That is why this needs a
  tool rather than a one-off cleanup.

```
${CLAUDE_PLUGIN_ROOT}/harness/worktree-gc.sh              # report only (dry run — the default)
${CLAUDE_PLUGIN_ROOT}/harness/worktree-gc.sh --delete     # remove what it reported
```

It removes registered worktrees that are clean and fully pushed, and deletes directories git does not
know about. It never touches the worktree you are in, one with uncommitted changes, or one holding commits
that are not on any remote — and in a repo with no remote-tracking refs it keeps every worktree, because
"fully pushed" is not a question that can be answered there. When in doubt it keeps the directory: a stale
20 MB worktree costs disk, a deleted unpushed branch costs work.

**Rule:** finish a worktree session by running the GC, and never `mv` or rename a worktree directory —
renaming is what turns a tracked worktree into an orphan.

### Worktree `node_modules` — the shadowing bug (APL-48 / APL-50 / APL-53)

The Branch stage used to run `ln -s "$P/node_modules" "$W/node_modules"`. That is the thing `AGENTS.md`
forbids by name under *"Worktree hazard: never symlink root node_modules"* — this table said it was
normal while `AGENTS.md` said it was forbidden, and the harness implemented the forbidden one. **All
three tasks in the first parallel batch lost a fix round to it**, each independently re-diagnosing the
same failure.

This repo is an npm workspace, so `$P/node_modules/@applygent/*` are symlinks into `$P/packages/*`.
Sharing that directory makes a worktree compile its own `src/` against the MAIN checkout's copy of every
workspace package, so an export added in the worktree appears not to exist:

```
Module '"@applygent/shared"' has no exported member 'memoryPath'
```

...which reads as a code bug, is not one, and cannot be fixed from inside a contract's Allowed paths.

**The cause is deeper than the symlink.** Worktrees live *inside* the repo
(`<main>/.claude/worktrees/<name>`), so Node's upward module resolution walks out of a worktree and finds
the main checkout's `node_modules` even when the worktree has none at all. A missing or partial
`node_modules` is shadowed just as badly as a symlinked one.

`${CLAUDE_PLUGIN_ROOT}/harness/link-workspace.sh <worktree> [main]` gives the worktree a real `node_modules`:
third-party packages symlinked from the main checkout (~790 links, no re-download), workspace packages
pointed at the worktree's own `packages/*`, names read from `package.json`'s `workspaces` so a new
package cannot silently keep resolving to the main checkout. Idempotent, and self-healing for the part that
matters: the workspace links are re-pointed unconditionally rather than trusted, and a scope directory
that is itself a symlink is replaced rather than written through (writing through it repoints the MAIN
checkout at the worktree — the same corruption, inflicted on the wrong tree). Third-party entries are
NOT re-verified: an existing entry is left as-is.

`AGENTS.md` prescribes a full per-worktree `npm install` for the same end. That also works and remains
the right manual fix; the script is the harness's version because it takes about a second.

Note that the first bullet above is now historical: as of APL-45 `task-orchestration.js` **does** create
a worktree of its own when `worktree: true` is passed. It creates it with `git worktree add` (registered,
never an orphan) and removes it on a clean finish, so it does not reintroduce the leak this section
describes. The GC still exists for `EnterWorktree` sessions and for worktrees kept by blocked runs.

## Concurrency (APL-45)

Several `/task` runs may execute at once, on these terms.

**Isolation is opt-in, safety is not.** Pass `worktree: true` and the run works in
`.claude/worktrees/<branch-slug>` with every stage pointed there. Omit it and the run works in the shared
checkout — but takes an exclusive lock first (`.claude/worktrees/.task-shared-tree.lock`, created with
`mkdir`, the atomic test-and-set). A second shared-tree run is **refused**, naming the branch that holds
the lock and its start time. A lock older than 6 hours is treated as a corpse and broken, loudly.

**The branch is the real lock.** Git will not check one branch out in two worktrees. The harness surfaces
that refusal as a block and never passes `--force`, so "two runs on one branch" is unreachable rather than
merely discouraged.

**What worktrees buy, exactly:**

| | shared tree | `worktree: true` |
|---|---|---|
| concurrent runs | one, others refused | many, one per branch |
| macOS gate | contended — one generated `Applygent.xcodeproj` | isolated; xcodegen writes per-worktree, so DerivedData paths differ |
| `node_modules` | present | a REAL per-worktree dir built by `link-workspace.sh` (never a symlink) |
| on `done` | lock released | worktree removed, lock n/a |
| on `blocked` | lock released | **worktree kept**, path in `result.worktree` |

**What they do NOT buy:** the Workflow runtime's token budget is a *shared* pool across concurrent
workflows. Each run's `budgetExhausted()` guard reads that shared pool, so N runs each see "plenty" and
collectively overshoot. When batching, pass an explicit budget — and remember the guards are inert
entirely when no budget is set (`budget.total` is `null` → `remaining()` is `Infinity`).

**Cleanup is reported, never assumed.** A cleanup agent that dies returns `null`, and the run says the
lock *may still be held* rather than reporting it released — same discipline as APL-7. If a result comes
back with `lockHeld: true`, remove the lock directory by hand before the next shared-tree run.

## Harness tests

`${CLAUDE_PLUGIN_ROOT}/harness/tests/` simulates the workflow runtime (`sim.mjs` stubs `agent`/`parallel`/`pipeline`/
`budget`), so orchestration control flow is testable without spawning a single agent. Run:

```
node ${CLAUDE_PLUGIN_ROOT}/harness/tests/run.mjs
```

Any change to `task-orchestration.js` should come with a test that fails on the old file
(`WF=<old copy> node ${CLAUDE_PLUGIN_ROOT}/harness/tests/test-x.mjs`) and passes on the new one.

## Unattended runs (APL-37)

`args.unattended: true` is the "type one line and walk away" mode. What it guarantees, and what it
cannot:

**Never stops to ask.** `stopAtContract` is forced off (requesting both is contradictory; unattended wins
and logs that it did). A stage with a question writes it to the tracker and exits — see the round-trip
section. An unattended run with no issue key is logged up front as having *nowhere* to report a failure.

**Bounded cost.** Fan-out is capped (APL-8) and both fix loops now stop at the `BUDGET_FLOOR`, not just
Review — a task that kept failing its gate could previously spend the whole turn before Review was ever
reached. A budget stop is reported as `budgetStopped: true` with `roundsExhausted: false`: different
failure, different remedy, and the result must not blur them. With no `budget.total` set,
`remaining()` is `Infinity` and none of this triggers.

**Honest terminal state.** Every result carries `terminal`, exactly one of `pr-opened` / `no-pr`. A `done`
run with `no-pr` (noCommit, or `gh` unavailable) is a real outcome, not a silent success.

**Resumable.** Re-invoke `Workflow` with `{ scriptPath, resumeFromRunId }` — completed agent calls with
unchanged prompts return from cache, so a crashed run resumes rather than restarting from the contract.
Same script + same args → full cache hit. This is the caller's move, not something the script does.

### Permissions — the one guarantee this script cannot enforce

An unattended run stalls forever on a permission prompt with nobody watching, so every command the gate
issues must be pre-approved in the **tracked** `.claude/settings.json`. Today the only allowlist is
`.claude/settings.local.json`, which is user-local and gitignored — it exists on exactly one machine, and
auditing it against `PIPELINE.md` turns up real gaps: `npm test` (`npm run:*` does not match it), `npx
eslint`, `npx danger`, `swiftformat`, `swiftlint`, and `yamllint` are all missing, and each one stalls an
unattended run at Verify.

The fix is a tracked `.claude/settings.json` granting exactly the gate's command set:

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(git:*)", "Bash(gh pr:*)",
      "Bash(npm run:*)", "Bash(npm test:*)",
      "Bash(npx tsc:*)", "Bash(npx vitest:*)", "Bash(npx eslint:*)", "Bash(npx danger:*)",
      "Bash(swiftformat:*)", "Bash(swiftlint:*)", "Bash(xcodegen:*)", "Bash(xcodebuild:*)",
      "Bash(yamllint:*)"
    ]
  }
}
```

`.claude/settings.json` now EXISTS and is tracked. It carries that allowlist plus the enforcement hooks
below. (The prohibition on an agent writing its own permission grants still stands in spirit — this file
was written deliberately, reviewed in a PR, and grants only the gate's own command set.)

## Follow-ups become issues, not PR prose

An implementer that finds a second bug while fixing the first has three options, and two of them are
bad. Fixing it is scope creep the auditor rejects. Mentioning it in the PR body loses it the moment
the PR is merged — that is how APL-48 shipped a dead `escapeHtml()` carrying a comment that claims a
caller which does not exist, and how `@applygent/rr-render`'s build script still swallows its own
`tsc` failures.

So the third option is enforced: **record it, then file it.**

- The implementer keeps a `## Follow-ups` list in the contract (what, `file:line`, why out of scope).
- A separate **Follow-ups stage** — one haiku agent, after Review — triages that list against the three
  rules below and runs `${CLAUDE_PLUGIN_ROOT}/harness/file-followups.sh`, which files the survivors into **Triage**
  tagged `<!-- filed-by-harness:<ISSUE> -->`. It is a separate agent on purpose: the implementer is the
  party with an interest in its own list surviving, so asking it to judge its own follow-ups is asking
  the author to review the author. And the *script*, not the model, is what talks to Linear — a
  hallucinated issue URL cannot reach the report.
- Contracts are gitignored, so an unfiled follow-up is not "written down", it is lost. A `FAIL` line
  from the script is surfaced in the run result and on the Linear comment rather than rounded down.
- The **review contract lens** is given that list. A **confirmed defect that was neither fixed nor
  filed is a blocking finding** — the harness's claim is that nothing real is lost between "noticed"
  and "tracked", and that claim has to be checked by something other than the agent that made it.

Three rules keep it from producing a board nobody reads: **verified only** (reproduced, or cite the
line — not a suspicion or a style preference), **losable only** (already-open issues and anything
obvious from the diff need nothing), and **at most 3 per run** — needing a fourth means the contract
was wrong, which is worth saying rather than filing around.

## Enforcement, not instruction (PreToolUse hooks)

Everything above tells an agent what to do. A dispatcher's prompt hook tells an agent to run the harness.
Both are **requests**, and the first real dispatched run demonstrated what a request is worth: it ignored the
harness entirely and hand-explored instead.

Two `PreToolUse` hooks in `.claude/settings.json` make the important parts non-negotiable. Claude Code
loads project settings (`settingSources: user, project, local`), so they apply to any agent working in
this repo — including one spawned by the Linear poller.

| hook | fires on | denies unless |
|---|---|---|
| `hooks/require-contract.sh` | `Edit` / `Write` / `MultiEdit` | a contract exists for this issue |
| `hooks/require-green-gate.sh` | `Bash` matching `git … commit` | `gate.sh` passed **on this exact tree** |

The second is the chokepoint. However the bytes arrived — Edit, Write, or a shell redirect that slipped
past the first hook — they do not become a commit without a green gate. `gate.sh` writes
`.test-results/gate/last-pass` containing a fingerprint of the tree that passed, and clears it on red;
the hook recomputes and compares, so editing after a green run and then committing is refused. Otherwise
an unverified change reaches a PR looking verified.

**Scope: `/task` worktrees only** (`.claude/worktrees/...`). Interactive work in the main checkout is
untouched — an edit hook firing on every local keystroke would be switched off within a day, and a
disabled hook enforces nothing.

**The honest ceiling.** A hook gates tool calls. An agent with `Bash` can still write a file by shell
redirect, so this is not a cryptographic guarantee. What it does is make *drift* impossible while leaving
*deliberate circumvention* possible — and the commit hook means circumvention still cannot produce a
committed, PR'd change that skipped the gate.

**Rule:** when you add a check to `PIPELINE.md`, add its command to `.claude/settings.json` in the same
change, or the next unattended run hangs on it.

## Review narrowing on fix rounds (APL-42)

Review was the largest stage in the run — all four lenses re-read the whole branch diff every round. On
rounds after the first:

- **Scope** — each lens reads the *fix* diff (`<last reviewed commit>..HEAD`), not the branch diff. The
  fix is where a regression would come from, so this concentrates attention. Lenses keep full repo access
  and are told to open surrounding code when a changed line implicates it.
- **Lens selection** — re-run every lens that had findings last round, plus `bugs` and `contract` always.
  Those two are the lenses whose miss ships a defect rather than a style problem. When `scope-creep` /
  `test-gaps` are skipped, the contract lens is explicitly given their duty over the fix diff.

Every narrowing is reported: `reviewCoverage` in the result (one entry per round — lenses run, lenses
skipped, diff scope, reason), a note appended to the review notes, and a `log()` line. The synthesizer is
told what was not re-examined so its verdict cannot read as a fresh four-lens review. Without a commit
hash to scope from, the round falls back to the full branch diff and says so.

This makes the typical run cheaper (4 lenses/round → 2), not the worst case: when every lens is live, all
four still run.

## Tracker-driven tasks (APL-35)

`/task` accepts a Linear issue URL or a bare key (`APL-12`, `apl-12`) in place of a description. The key is
resolved from `args.issueId`, then a Linear URL, then a key in the request text, then a whole-request bare
key — and it drives four things: the branch (`claude/APL-12`), the contract filename
(`apl-12-<slug>.md`), the commit subject, and `Closes APL-12.` in the PR body.

When the request is **only** a reference, there is no description to contract from, so the CONTRACT AUTHOR
resolves the issue itself through the Linear MCP (`get_issue`) and contracts from its title + description —
Goal / Evidence / Acceptance map onto the contract template directly, which is why issues are worth writing
that way. The `/task` skill resolves it up front when it has the Linear tools; the in-workflow path is the
fallback. An issue too thin to contract from produces `openQuestions`, which stops the run and comments
back on the issue (see the round-trip section).

A request that merely *mentions* a key is not a reference-only request: its own text stays the spec.

## Linear round-trip (APL-36) — planned by the workflow, PERFORMED by the caller

When the run has a Linear issue key (`args.issueId`, or one parsed out of the task text) the workflow
plans a write at every meaningful transition and returns them, in order, as `result.linearWrites`:

| Harness event | planned write |
|---|---|
| branch created | status → In Progress, assigned (only if unassigned) |
| contract has open questions | comment the questions and **stop before implementing** |
| PR opened | PR attached, status → In Review |
| run finishes approved | comment with the gate report, PR link, and anything the caps dropped |
| any `blocked` return | comment the stage + reason + `lastFailure` + `fixLog`, status → Todo |

**The workflow does not perform them.** It used to spawn a cheap agent per write — 3–4 agents per run
at ~39k tokens each, for zero code value — and it did not work: this session exposes more than one
Linear MCP, a subagent resolved to the unauthenticated one, and in the first real batch **every write
failed** (APL-46). APL-46 answered with a probe agent that pinned the server; APL-47 added a breaker so
a dead channel stopped costing money. Both treated the symptom.

The cause was that a subagent is the wrong actor. The orchestrator already holds a working Linear
connector — it is what files these issues. So the workflow plans, the caller performs. Zero subagent
tokens, and the auth problem stops existing rather than being probed around. **The APL-46 probe and the
APL-47 breaker are both deleted**: there is nothing left to spend, so nothing to break the circuit on.

### The caller's obligation

Whoever invokes the workflow MUST walk `result.linearWrites` and perform each entry, honouring:

1. **Never fail the task over Linear.** A board outage must not turn a green run red.
2. **Never duplicate.** Every write carries an HTML-comment `marker` and leads its `body` with it.
   Call `list_comments` and skip a write whose marker is already present with identical text, so a
   resumed or re-run workflow does not spam the issue.
3. **Never hardcode workflow state names.** Each entry gives a `stateType` (`started` / `unstarted` /
   `completed`) and an optional `statePreference`. Resolve with `list_issue_statuses` and match by TYPE.
4. **Never move the issue to Done.** The harness does not merge, so only the human who merges can
   honestly close it.

An entry with `skipped: true` carries a `note` saying why nothing was planned (`args.linear: false`, or
no issue key) — a disabled round-trip and "no transitions happened" must not look the same.

If the caller does not perform the writes, the board is stale and nobody was told. That is now the
caller's failure, not a silent harness one — which is the honest place for it, since the caller is the
only actor that can actually reach Linear.

- `args.linear: false` disables planning entirely; `args.stopOnOpenQuestions: false` implements despite
  open questions (they are still planned as a comment).


## Gate tooling (repo root)

- `danger local` — deterministic diff review (Dangerfile). Requires `CONTRACT_PATH`.
  **It exits 0 even when it fails the build** — it prints `Failing the build, there is 1 fail.` and
  returns success. `gate.sh` greps for that and treats it as FAIL. Until then danger was ADVISORY: its
  secrets / forbidden-paths / generated-files checks could not block a run. Never invoke it bare; go
  through `gate.sh` (or `npm run gate:diff`, which delegates).
- `swiftformat --lint apps/macOS`, `swiftlint lint apps/macOS`
- `eslint <changed TS files>`, `yamllint config*.yaml apps/macOS/project.yml`
- `npm run build` / `npm test` — TypeScript typecheck + tests
- Applygent build/test via xcodegen + xcodebuild (see AGENTS.md; prefer `-only-testing:ApplygentTests/<Suite>`)

## Why this harness and not flow-next (decided, 2026-09)

flow-next was trialled head to head on APL-16 and then removed. The record, because the reasoning is
worth more than the verdict:

**It was better at deciding WHAT to build.** Its scout fan-out is keyed to a depth tier and forbids
cherry-picking, so it read things a judgement-driven search skips: ADR 0031's counting rule,
`AGENTS.md`'s no-disclosure position, and APL-57 making a snapshot test a trap. None were in the
issue; our own contract for the same issue found none of them. Its provenance tags
(`[user]`/`[paraphrase]`/`[inferred]`) then caught the issue's own stated cause being wrong — that
idea now lives in `CONTRACT.md`.

**It lost on everything else that binds here.** Measured: 596k tokens for APL-16 against 123-163k for
a comparable `/task` run. It cannot dispatch — its tracker bridge is projection-only, spec → tracker,
so nothing in it reads a Linear delegation. It has no Linear round-trip. Its headline claim, that the
model writing the diff never reviews it, needs a second vendor's CLI that is not installed here, so
`review.backend: host` was same-vendor anyway. And its gate is a model reading a diff, which can be
argued with, where `require-green-gate.sh` cannot.

**What we kept:** the provenance tags. **What we gave up:** the scout fan-out, which is the one real
loss and is a *phase* rather than a framework — portable later if it earns its ~250k.
