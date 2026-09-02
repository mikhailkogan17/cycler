<!-- version: harness-issue-process-5 — history and rationale live in HARNESS.md, not here -->

You are working a Linear issue in a git worktree. This repo uses a **contract-first harness**.
Follow the process below. Do not improvise an investigate-then-edit loop.

Read the issue with `~/bin/lin issue view <ISSUE>` — title and description are the spec. Below,
`<ISSUE>` means that identifier (e.g. `APL-49`) and `<BASE>` the PR base branch, `main` unless the
issue says otherwise. Run every command from the worktree root.

## Pick your mode first

The steps below are common to every issue. What differs by issue type lives in one small file — read
**exactly one** of these, chosen by the issue's labels, and follow it alongside this process:

| labels | mode file |
|---|---|
| `Bug` | `${CLAUDE_PLUGIN_ROOT}/harness/modes/fix.md` |
| `Feature`, `Improvement`, `Tech Debt` | `${CLAUDE_PLUGIN_ROOT}/harness/modes/build.md` |
| none of the above, or the issue is too thin to contract from | `${CLAUDE_PLUGIN_ROOT}/harness/modes/scope.md` |

Read one, not three. They are split so that a bug fix does not carry a feature's process and a
feature does not carry a bug's — and so that neither pays for the other's words on every turn.

## Before anything

Read `${CLAUDE_PLUGIN_ROOT}/harness/HARNESS.md`.

## 1. Contract (you write it, no agent)

Copy `${CLAUDE_PLUGIN_ROOT}/harness/CONTRACT.md` to `.claude/harness/contracts/<ISSUE>-<slug>.md` and
fill it in from the issue above: Goal, Non-goals, Allowed paths, Forbidden paths, Files expected to
change, Acceptance checks (exact commands), Risks.

The Acceptance checks are the point — they are what audit and review judge against. Vague checks make
every later stage useless.

**If the issue is too thin to contract from** — you cannot state acceptance checks without guessing —
stop here, post the specific open questions as your reply, and do not implement. A guess costs more
than a question.

**Escape hatch:** if the contract's "Files expected to change" exceeds ~8 files, or touches
`apps/macOS/**`, do NOT continue inline. Run the full workflow instead and skip to step 7:

```js
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/task-orchestration.js", args: {
  contractPath: "<the contract you just wrote>", cwd: process.cwd(),
  issueId: "<ISSUE>", branch: "<BRANCH>", prBase: "<BASE>",
  worktree: false, linear: false
}})
```

## 2. Implement (you, no agent)

Minimal diff, only within the contract's Allowed paths. Add or update tests as the contract requires.
Do not touch the gate config (`eslint.config.js`, `.yamllint`, `dangerfile.js`), `package.json`,
`config*.yaml`, `.env*`, or generated dirs.

Never re-link `node_modules` by hand — use `${CLAUDE_PLUGIN_ROOT}/harness/link-workspace.sh`. Symlinking the main
checkout's copy is the bug APL-48, APL-50 and APL-53 each lost a fix round to (AGENTS.md →
*Worktree hazard*).

**When you find something real but out of scope, write it down — do not fix it.** Keep a running
`## Follow-ups` list in the contract: what it is, `file:line`, why it is out of scope. You file these
in step 5. Fixing them is scope creep the auditor rejects; saying nothing loses them.

### Delegate reading — an agent is a context you throw away

Spawn an agent for two reasons, not one. Independence is the obvious one. The other is **context
disposal**: whatever an agent reads dies with it, while whatever *you* read is re-read on every one of
your remaining turns.

Measured on two issues that merged the same night:

| | APL-20 | APL-54 |
|---|---|---|
| agents | 4 | **8** |
| `Read` calls in the driver | 39 | 24 |
| peak driver context | **197K** | **132K** |
| cache-read tokens | **13.34M** | **7.32M** |

APL-20 changed **two files** and still cost nearly twice as much, because it investigated inline. More
agents came out cheaper, which is the opposite of what this harness originally assumed.

So: **any investigation that needs more than ~3 file reads goes to an agent**, and that agent returns
*findings* — `file:line`, the answer, the shape of the problem — never file contents. Ask "where is X
handled and what does it do", not "read these seven files". You keep the conclusion; the bytes stay in
a context that is discarded.

This does not apply to files you are about to edit. Read those directly.

### Keep tool output small — this is the second cost driver

Same arithmetic, applied to output you cannot delegate. Every tool result stays in your context for
**all remaining turns**: a 10k-token dump on turn 20 of a 150-turn run is re-read 130 times. On APL-41,
83% of the run's cost was context and cache reads alone were 61% — output tokens were 16%.

So: never dump a whole file, a whole diff, or a whole test log. Read the range you need, `grep` for the
symbol, pipe long output to a file and search it. `gate.sh` and `audit.sh` already truncate; do the
same by hand for everything else. This is worth more than any number of deleted agents.

## 3. Gate (you run a script, no agent)

```bash
CONTRACT_PATH=<your contract> bash ${CLAUDE_PLUGIN_ROOT}/harness/gate.sh --fast --base <BASE>
```

One line per passing check; only failures print detail; the last line is `GATE: PASS|FAIL`. Red → fix
the code and re-run. **Max 2 fix rounds**, then stop and report BLOCKED with the exact command and
output.

Do not invent your own check list, and never run `danger` bare — it exits 0 even when it fails the
build, so a bare run reads as a pass.

## 4. Audit (a script, then ONE small agent)

Run the deterministic half first — it is arithmetic, not judgement:

```bash
CONTRACT_PATH=<your contract> bash ${CLAUDE_PLUGIN_ROOT}/harness/audit.sh --base <BASE>
```

It checks files outside Allowed paths, anything in Forbidden paths, generated or secret files, whether
the contract itself was edited by the run it governs, and scope against the contract's file list. One
line per check; `AUDIT: CLEAN|DIRTY`. Fix any DIRTY and re-run before spending an agent.

Then spawn **one** `Task` agent for the only question a script cannot answer. Give it the contract path
and `git diff` — not your reasoning, not your summary, not what you intended:

> You are the AUDITOR. Read the contract at `<path>` and `git diff` in the worktree root.
> `audit.sh` has already verified paths, scope, secrets and contract integrity — do not re-check those.
> Answer one question: **are the contract's acceptance checks genuinely met by this diff?** Quote the
> check and the code that satisfies it, or name the gap. Do not fix anything.

`audit.sh` caches a CLEAN result against a hash of (diff + contract), so re-running it on an
unchanged tree is free. The same rule applies to you: **do not re-spawn the audit or a review lens
while the diff is byte-identical to what it last judged.** An agent given the same input returns the
same verdict, at full cold-start price.

Dirty → fix and re-audit. **Max 2 rounds**, then report BLOCKED.

## 5. Commit, push, PR (you)

```bash
git add <only the contract's listed files> && git commit && git push
gh pr create --base <BASE> --head <BRANCH>
```

Commit message: what changed and **why**, referencing <ISSUE>. Body ends with
`Closes <ISSUE>.` **Never merge** — opening the PR is where your authority ends.

Contracts are gitignored; never commit `config.local.yaml`, `memory/profiles/`, `memory/cvs/` or
`memory/apply-logs/`.

### File the follow-ups

**Leave them in the contract — do not try to file them yourself.** The `linear` MCP server never
reliably connect in a dispatched session, and APL-54 discovered that the hard way — it ended its
report with "please file this manually" and the finding then sat unfiled.

Use `~/bin/lin` instead, which is a plain CLI and cannot half-connect:

```bash
lin issue create --team APL --title '<the defect, stated>' --description '<evidence, file:line, why out of scope>'
```
Your job is to make each entry a self-contained sentence — what it is, `file:line`, why it was out of
scope — because that sentence becomes the issue title and body.

If a Linear tool IS available in your session, filing them yourself is fine; the watcher searches
first and skips anything already there.

`HARNESS.md` → *Follow-ups become issues, not PR prose* has the three rules that keep this from
producing a board nobody reads: verified only, losable only, at most 3 per run. Read it there.

List every issue you created, with URLs, in your final report — or say "none" explicitly.

## 6. Review (2-3 agents, parallel)

Spawn `Task` agents in ONE message, each with the contract + `git diff <BASE>...HEAD` and
nothing from you:

- **bugs** — correctness, edge cases, error handling
- **contract** — acceptance checks genuinely met; scope matches; **and every out-of-scope defect
  visible in the diff or named in the implementer's notes has a Linear issue filed for it**
- **test-gaps** — the diff adds logic that nothing tests. Mechanical enough to run on Haiku:
  `Task(..., model: "haiku")`. It is looking for uncovered branches, not exercising judgement.

- **scope-creep** — edits outside the contract's scope, unrelated changes, dead code,
  over-engineering. `audit.sh` already computes the file-count and forbidden-path half mechanically,
  so this lens is for the half a number cannot see: a change that stays inside Allowed paths and
  still does more than the contract asked for.

This file used to claim "there is no scope-creep lens". That was false — `task-orchestration.js:1062`
defines one and round 1 dispatches all four. It is the second doc-vs-code contradiction found in one
session, after this repo's gate doc claiming the gate never tested Swift. Both understated what runs,
which is the dangerous direction: prose describing a script is a *claim* about the script, and
nothing checks it.

**Your mode file says which of these to run.** Do not run more.

Each returns findings with `severity: blocking | non-blocking`.

The contract lens is given the list of issues you filed. A **confirmed defect that was silently
dropped** — neither fixed nor filed — is a **blocking** finding: the harness's whole claim is that
nothing real gets lost between "noticed" and "tracked". A non-blocking nit needs no issue.

Only **blocking** findings need adversarial verification — spawn one refuter per blocking finding that
tries to *disprove* it. A non-blocking nit costs an agent to confirm and changes no verdict; carry
those through unrefuted and label them as such.

Confirmed blocking findings → fix, push to the same PR, then **re-run only the lenses that raised a
blocking finding** — not the whole panel. A lens that came back clean on the diff has no verdict to
revise on a fix that addresses someone else's finding, and re-running it costs a full cold start to
be told the same thing twice. APL-33 spent three agents re-reviewing every lens when one had
objected. **Max 2 rounds.**

## 7. Report

- The PR URL, and `done` or `blocked`
- If blocked: which stage, the exact failing command or finding, and what you tried
- Non-blocking findings, labelled as unverified
- **Linear issues you filed**, with URLs — or an explicit "none" 
- Anything a cap cut short — a truncated review must never read as a complete one

State what actually happened. A green report on a red gate is the one outcome this whole process
exists to prevent.
