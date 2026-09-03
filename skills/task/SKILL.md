---
name: task
description: Run a task end-to-end in ONE workflow (task-orchestration): contract → implement → audit → verify → commit → PR → review (fixes pushed to the PR). Auto-commits, opens a PR, never merges — unless you pass noCommit.
---

# /task — full task lifecycle in a single workflow

## Inputs

- The user's request (the current message) — or an existing contract path.
- The request may be **a Linear issue URL or bare key instead of a description** (see below).
- READ `${CLAUDE_PLUGIN_ROOT}/harness/HARNESS.md` first.

## Actions (in order)

1. Run `git status --short` (respect in-flight changes — do not touch them).
2. **If the argument is a Linear reference** — a `https://linear.app/<workspace>/issue/APL-1/...` URL or a
   bare key like `APL-12` — resolve it before invoking the workflow:
   - Read it with `"${CLAUDE_PLUGIN_ROOT}/poller/lin" issue view <KEY>` — one Bash call, no tool schema to load. Prefer this
     over the Linear MCP: `ToolSearch` + `get_issue` costs a schema load and a tool round-trip, and the
     MCP server is not always connected (in dispatched sessions the Linear MCP never finished connecting, so the
     follow-up-filing step there was unsatisfiable by construction).
   - `lin` is `linear-cli` reading the OAuth token the Linear poller keeps refreshed. Do not use a
     pinned `LINEAR_API_KEY` or `.linear.toml`: Linear access tokens expire every 24h, so a copied one
     works for a day and then fails with a 401 that reads like a network fault.
   - Pass the issue's **title + full description** as `task` (e.g.
     `task: 'APL-1 — <title>\n\n<description>'`). The description is the spec: the issues in this
     workspace are written with Goal / Evidence / Acceptance sections, which map almost directly onto the
     contract template. Do not paraphrase or summarise the acceptance criteria — pass them through.
   - Pass the key as `issueId`. It drives the branch (`claude/APL-1`), the contract filename
     (`apl-1-<slug>.md`), the commit subject, and the PR body's `Closes APL-1.`
   - If `lin` fails (no token, revoked app), pass the reference through as-is: the workflow's CONTRACT AUTHOR
     resolves a reference-only request itself as a fallback. Say which path you took.
   - A **non-Linear argument is unaffected** — pass the request verbatim exactly as before.
3. **Post a start comment before invoking the workflow** (Linear reference only):

```bash
"${CLAUDE_PLUGIN_ROOT}/poller/lin" issue comment list <KEY> | grep -q 'harness:<KEY>:dispatched' \
  || "${CLAUDE_PLUGIN_ROOT}/poller/lin" issue comment add <KEY> --body '<!-- harness:<KEY>:dispatched -->
🔧 Harness run started — contract → implement → audit → gate → PR → review. Next comment lands when the PR opens.'
```

   Every other Linear write in this skill happens in step 5, *after* the workflow returns — which is 20-40
   minutes later. Without this one the board shows nothing at all for the whole run, and a delegated issue
   sitting silent is indistinguishable from a dispatch that never fired. That ambiguity is what the poller's
   own failure comment exists to remove; the run itself needs the same. The marker makes it idempotent, and
   a failure here is never a reason not to start the workflow.

4. **Read `cycler.yaml` first**, so the run uses this repo's settings rather than defaults:

```bash
node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.base main
node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.branchPrefix claude/
node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.path ""
```

   Pass those as `prBase`, `branchPrefix` and `cwd` below. A repo with no `cycler.yaml` gets the
   defaults, which are the values shown in those commands — nothing breaks, nothing is silently
   shaped like somebody else's repo.

5. Call the single workflow:

```js
Workflow({ scriptPath: '.claude/workflows/task-orchestration.js', args: {
  task: '<the user request verbatim — or, for a Linear reference, the resolved issue title + description>',
  cwd: '<repo root>',
  executorModel: '<lower Claude model id like "sonnet"/"haiku", or omit to inherit>',
  noCommit: <true if the user wants to review before commit; omit for full automation>,
  stopAtContract: <true when plan mode is active; omit otherwise>,
  prBase: '<repo.base from cycler.yaml, default "main"; pass the previous task\'s branch when stacking tasks>',
  branchPrefix: '<repo.branchPrefix from cycler.yaml, default "claude/">',
  issueId: '<the tracker issue key when the task is driven from one, e.g. "APL-10" — sets the branch name>',
  branch: '<explicit branch override; omit unless you need to force a specific name>',
  models: <per-stage overrides, e.g. { verify: 'haiku' }; omit to use the defaults below>,
  worktree: <true to run in a dedicated git worktree — REQUIRED when launching runs in parallel>
}})
```

   - If a contract already exists and the user wants to use it, pass `contractPath` instead of `task`.
   - When the user invokes `/task <ISSUE-KEY>` (e.g. `/task APL-10`), pass that key as `issueId`. The
     workflow also parses an uppercase `ABC-123` key out of the task text, so this is belt-and-braces —
     but pass it explicitly whenever you know it. It determines the branch name (`<branchPrefix><ISSUE_ID>`).
6. **Perform the Linear writes the workflow planned.** The result carries `linearWrites[]` — the
   workflow no longer performs these itself (it used to spend 3-4 subagents per run on writes that
   failed against an unauthenticated MCP; see HARNESS.md -> Linear round-trip). You hold a working
   Linear connector, so you do them:
   - Walk the array in order. Each entry has `kind`, `issue`, `marker`, `stateType`,
     `statePreference`, `assignSelf`, `links[]`, `body`.
   - **Use `${CLAUDE_PLUGIN_ROOT}/poller/lin`, not the Linear MCP** (see step 2 for why): `lin issue comment list <KEY>` to
     check, `lin issue comment add <KEY> --body '...'` to write, `lin issue update <KEY> --state
     '<name-or-type>'` to move state.
   - **Idempotency:** list the comments first and skip a write whose `marker` is already present with
     identical text. `body` always leads with `marker`. A resumed or re-run workflow must not spam.
   - **States by TYPE:** `lin issue update` takes a state by name *or type*, so pass `statePreference`
     when set and fall back to `stateType` (`started`/`unstarted`/`completed`). Never hardcode a name
     that only exists in one team.
   - **Never move the issue to Done** — the harness does not merge, so only the human who merges can
     honestly close it. Never reassign an issue that already has an assignee.
   - **Never fail the task over Linear.** If a write errors, report it and move on; the task's own
     outcome is unaffected. Entries with `skipped: true` need no action — the `note` says why.
   - Tell the user which writes you performed, and which failed.
7. Read the returned structured result:
   `{ status, stage, branch, branchCreated, worktree, lockHeld, cleanupNote, contractPath, changedFiles[], summary, commandJournal[], audit, report, confirmed[], notes, fixLog[], commit, commits[], pr, linearWrites[] }`.
   `worktree` is `null` once removed, or a path still on disk. `lockHeld: true` means the shared-tree
   lock could NOT be released — remove it by hand (path in `cleanupNote`) or the next shared-tree run
   refuses to start.
   Note: the workflow self-corrects — audit/verify/review failures loop back to the implementer with the
   exact issues, up to `args.fixMax` (default 2). A `blocked` result means the loop gave up at the failing
   stage (`fixLog` + `lastFailure`), or the implementer/contract stage failed. On `done`, `pr.prUrl` is the
   opened pull request (never merged by the harness).

## Plan mode: contract-as-plan

Detect plan mode from your own context: a "Plan mode is active" reminder is present and the `ExitPlanMode`
tool is available. (No env var exists — detection is reading your context; a deterministic alternative via
a hook's `permission_mode` is documented in HARNESS.md.) When active, pass `stopAtContract: true`.

The workflow then returns `{ status: 'plan', stage: 'contract', contractPath, openQuestions }` instead of
implementing. Present the contract as the plan:

1. Read the `contractPath` file; append any `openQuestions`.
2. Write it to the plan file path from your plan-mode reminder — that file is the ONLY file you may write
   in plan mode.
3. Call `ExitPlanMode` — the user reviews the contract as the plan.
4. Approved → re-invoke the SAME workflow with `contractPath: <path>` and WITHOUT `stopAtContract`; the
   implement → audit → verify → review → commit stages run normally.
5. Rejected → do not re-invoke. The user edits the contract file (or re-runs `/task`); they may then pass
   `contractPath` to continue.

If you set `stopAtContract` but `ExitPlanMode` is unavailable (not actually in plan mode), present the
contract in a normal message and ask for approval before re-invoking.

## Output

- Relay to the user: stage reached, status (`done` / `blocked`), the gate report, the review verdict
  (when a review ran), any fix rounds (`fixLog`), the commit hash(es), and the opened PR url if one was
  created.

## Stop conditions

- `status === 'plan'` → present the contract as a plan and re-invoke with `contractPath` on approval
  (see Plan mode section). Do NOT start implementing without that approval.
- `status === 'blocked'` → relay the blockers verbatim (with the stage: contract / implement / audit /
  verify / review). Do NOT auto-retry in a loop. The user fixes or re-runs.
- `status === 'done'` → show the summary + commit hash + PR url (if opened). Then save memory: only
  `decision` / `constraint` / `failure` records — never chat history.

## Notes

- **Models are routed per stage**, not one model for the whole run. `contract` runs on `opus` (one agent,
  but every later stage reads it, and its Non-goals are what let the auditor catch scope creep); the
  mechanical stages `branch`/`commit`/`pr` run on `haiku` (fixed command sequences whose success the
  workflow re-checks itself); `review:test-gaps` and `followups` run on `haiku`. Everything else inherits
  `executorModel`. `verify`, `audit` and `refute` are deliberately NOT downgraded — verify *plans* the
  gate before running it, audit is what catches leaked secrets, and a refuter defaults to `isReal:false`
  when unsure, so a weak one silently drops real findings. Override any stage with `args.models`
  (`{ verify: 'haiku' }`), or pass `null` for a stage to force it back to `executorModel`.
- **The contract author answers its own questions** (APL-47). `openQuestions` blocks the run and waits
  for a human, so it is reserved for genuine PREFERENCE decisions — a product stance, a trade-off only
  the user can price. Anything OBSERVABLE (how the code is structured, what copy the feature already
  uses, what the current screen looks like) the author resolves itself: by reading, or for macOS UI
  questions by building and running the app and taking a screenshot. Resolved-by-looking decisions are
  recorded in the contract's Risks & assumptions so a reviewer can challenge the observation. This is
  what keeps `stopOnOpenQuestions: true` (the default) affordable — before it, a well-specified UI issue
  still cost two round-trips.
- **Parallel runs need `worktree: true`** (APL-45). Without it a run works in the shared checkout and
  takes an exclusive lock; a second concurrent run is refused outright, naming the branch that holds the
  lock — loud, not interleaved. With it, the run gets its own worktree under `.claude/worktrees/` and
  every stage is pointed there, so several `/task` runs on different branches are safe at once. Two runs
  on the SAME branch are still impossible: git refuses to check one branch out in two worktrees, and the
  harness will not `--force` past that. A clean run removes its worktree; a **blocked run keeps it** and
  reports the path in `result.worktree` — inspect it, then
  `git worktree remove --force <path>`. Two things worktrees do NOT fix: the token budget is shared
  across concurrent workflows (pass an explicit budget when batching, or each run's guard sees a pool the
  others are also spending), and each run still costs up to ~70 agents.
- A **Branch stage** runs before the implementer: it creates or reuses `claude/<ISSUE_ID>` off an
  up-to-date `prBase`, and refuses to run if that branch would equal `prBase`. The harness therefore never
  commits onto the base branch. See `${CLAUDE_PLUGIN_ROOT}/harness/PIPELINE.md` for the naming convention (and why it
  differs from Linear's suggested `feature/apl-N`).
- A `blocked` result carrying `fatal: true` means a gate stage **did not run** (an agent returned no
  result — usually a terminal API error), not that the diff failed. Never re-read it as a pass; re-run.
- The workflow commits the gated diff, pushes the branch, and opens a PR to `prBase` (default `main`). It
  NEVER merges — merging is the user's call. Review-fix rounds add commits to the same PR.
- The workflow cannot take user input mid-run by design (single-shot). To keep sign-off control, either
  pass `noCommit: true` (review the diff, commit/push/PR later manually), or author a contract first and
  pass `contractPath`.
- Full automation is the default: it commits, opens the PR, and pushes review fixes to it.
