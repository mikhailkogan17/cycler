# cycler — specification

**cycler turns a Linear board into the queue for Claude Code sessions on your own machine.** Delegate
an issue to the Claude agent in Linear; a poller on your laptop notices, starts a background Claude
Code session in your repo, and that session writes a contract, implements, gates, opens a PR and
reports back on the issue.

This file is the spec: what it contains, how the pieces fit, and what it deliberately does not do.
`README.md` is the user-facing version; this one is for whoever is changing cycler itself.

---

## 1. Why it exists

Linear's agent integration delivers by **webhook**, and a webhook needs a public URL. So the
"self-hosted" options in this space either run their networking layer in someone's cloud or ask you
to tunnel — ngrok, Hookdeck — into your laptop. That is a service dependency, an inbound listener,
and usually a subscription.

cycler polls outbound: an OAuth app in your own workspace, a `fetch` every 180 seconds from a launchd
job. Nothing listens. Nothing runs in anyone's cloud. There is no account.

Target user: solo devs who want the loop without paying for a platform. The poller is plain Node and
never calls a model, so every token is spent by the workflow the user configured.

## 2. The two halves

cycler ships both, because either alone is useless. A poller with no process behind it burns quota
producing nothing; a harness with no trigger is a thing you have to remember to run.

| half | what | where it runs |
|---|---|---|
| **trigger** | `poller/poller.mjs` — OAuth, delegate filter, routing, dispatch, comment | launchd, every 180s, zero tokens |
| **process** | `workflows/`, `skills/`, `harness/` — contract-first implement-and-gate | inside the dispatched session |

## 3. Layout

```
cycler/
  README.md  AGENTS.md  LICENSE  cycler.example.yaml
  .claude-plugin/plugin.json      the plugin manifest
  commands/                       the only user interface — no CLI
    setup.md  start-polling.md  stop-polling.md  start.md  doctor.md
  hooks/hooks.json                the four PreToolUse hooks, plugin-rooted
  lib/yaml.mjs                    the cycler.yaml reader, shared by poller and hooks
  poller/poller.mjs               the poller
  poller/lin  poller/lin-delegate the Linear CLI the harness falls back to
  skills/{task,research,intake}/SKILL.md
  workflows/task-orchestration.js the ten-phase workflow
  harness/
    HARNESS.md ISSUE-PROCESS.md PIPELINE.md ROUTING.md CONTRACT.md  modes/
    gate.sh                       the gate RESOLVER — the one gate command
    gate.default.sh               used only when the repo has no gate of its own
    audit.sh  file-followups.sh  link-workspace.sh  worktree-gc.sh
    read-config.mjs               cycler.yaml, for the bash hooks
    hooks/  tests/
    CLAUDE.reference.md           template CLAUDE.md for a consuming repo
```

## 4. Interface

Slash commands only — no CLI, no npm binary, no second install surface. `/cycler:setup`,
`/cycler:start-polling`, `/cycler:stop-polling`, `/cycler:start <KEY>`, `/cycler:doctor`. They are
command files that instruct the session to run the underlying bash.

## 5. Config

`cycler.yaml` at the repo root, or `~/.cycler/cycler.yaml`. Committed on purpose: the branch prefix,
the PR base and the escape hatch are facts about the repo. Secrets are not in it — the Linear client
id, secret and token live in `~/.cycler/`.

`lib/yaml.mjs` parses the subset actually used: nested maps, scalars, inline lists, block lists, and
block lists of maps. It never throws — a malformed config degrades to defaults rather than stopping a
poll, because a poller that dies on config stops dispatching silently.

Environment overrides exist for the values launchd needs to force without editing a file:
`REPO_PATH`, `CLAUDE_BIN`, `CYCLER_WORKFLOW`, `CYCLER_HOME`, `CYCLER_CONFIG`.

## 6. The poller

- **`actor=app` OAuth**, so comments come from "Claude" rather than from the user.
- **Token refresh.** Linear access tokens expire in 24h (`expires_in: 86399`). On
  `AUTHENTICATION_ERROR` the poller refreshes once and retries, **merging** the response into the
  stored token — a refresh response may omit `refresh_token`, and dropping it makes the *next*
  refresh impossible, turning a self-healing poller into one that dies a day later.
- **Delegate, not assignee.** `issues(filter: { delegate: { id: { eq: viewer.id } } })`. Assigning is
  a different field that looks right and dispatches nothing; `poller/lin-delegate` exists for that.
- **Routing** is a lookup on a label a human already wrote — `research` → `/research`, everything
  else → `routes.default`. Deliberately not a classifier: a model would infer, less reliably,
  something already recorded, and a router that returns the default for everything is
  indistinguishable from a working one until something audits its choices.
- **Dispatch** is a configurable template (`dispatch.command`), split like a shell would but
  **without** a shell — issue titles contain quotes, backticks and `$`. Placeholders are substituted
  after splitting, so a title can never introduce an argument. `--print` must never appear alongside
  `--background`: they conflict, `claude` exits 1, and it looks exactly like the agent never saw the
  issue.
- **`dispatch.pathPrepend`** exists because launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin`. The
  session inherits it and cannot find `node`, `gh`, `claude` or `lin`. An interactive session never
  sees this, which is why it only appears once dispatch is automated.
- **Every dispatch and every failure posts a comment.** Without the failure comment, a failed
  dispatch is indistinguishable from an issue the agent never saw.
- **Idempotent** via `processed.json`; completed and canceled issues are skipped; a failed dispatch
  is not marked processed, so it retries on the next poll.
- **Not the poller's job: issue state.** Transitions belong to the workflow, which knows the
  *outcome* — `linearSync('started' | 'open-questions' | 'pr-opened' | 'approved' | 'blocked-<stage>')`,
  performed by the `/task` skill. A poller watching process liveness only knows a process ended.

## 7. The harness

Ten phases: `Contract → Branch → Implement → Audit → Verify → Commit → PR → Review → Follow-ups →
Cleanup`.

- **Contract first**, with `[user]` / `[paraphrase]` / `[inferred]` provenance on requirement lines.
- **Enforcement outside the agent** — four `PreToolUse` hooks: `require-contract.sh` (no edits before
  a contract), `require-green-gate.sh` (no commit on a red gate), `require-escape-hatch.sh` (a large
  change runs the full workflow instead of inline), `confine-to-worktree.sh` (no writes outside the
  session's worktree).
- **Audit is arithmetic before judgement.** `audit.sh` checks paths, scope, secrets and whether the
  run edited its own contract; then exactly one agent answers the question a script cannot.
- **Four review lenses** in parallel; refuters only for blocking findings; only the lens that raised
  one is re-run after a fix.
- **Follow-ups become issues** — verified only, losable only, at most 3 per run, filed via
  `poller/lin`, because an MCP server does not reliably connect in a dispatched session.
- **Model tiering.** Cheap models for branch, commit, PR, cleanup, follow-ups and the test-gaps lens.
  Verify, audit and refute are deliberately **not** downgraded — they are the checks.
- **`.claude/**` is not a forbidden path.** A run may work on the harness and still pass its own
  audit. What stays forbidden is a run editing the contract that governs it or the gate that judges
  it — that is moving the goalposts, and `audit.sh` checks for it.

The rule underneath all of it: **green is only evidence if the check could have gone red.** Six
checks in this harness's history were found incapable of failing on the input they judged — a
predicate returning literal `true`, a count/slice pairing no test could reach, a cross-language check
matching its own doc comment, a Swift gate that skipped Swift, a contract hook satisfied by renaming
a file, and routing that dispatched the same workflow for everything. Each looked green for weeks.

## 8. The gate is repo-local

`harness/gate.sh` is a **resolver**, and it is the one gate command:

1. `$CLAUDE_PROJECT_DIR/.claude/harness/gate.sh` — the repo's own. Wins whenever it exists.
2. `harness/gate.default.sh` — lint/build/test autodetected from `package.json`.

It `exec`s, so the chosen gate's output and exit status pass through unchanged and every caller sees
the same output contract. It prints which gate it chose **to stderr, never stdout**: stdout is the
output contract, and a resolver that quietly always picked the default would look identical to a
working one.

The default reports **FAIL**, not a vacuous pass, when it finds no script to run.

## 9. Verification

- `node --check` every `.mjs`/`.js`; `bash -n` every shell script.
- `node harness/tests/run.mjs` — the harness's own suite ships with it.
- The resolver must be able to go red: it must pick the repo's gate in a repo that has one and the
  default in a repo that does not.
- End to end in a repo that is not the one it grew in — that is the only test of the claim.

## 10. Non-goals

- No cloud, no account, no tunnel, no inbound listener.
- No tokens spent by the poller; routing stays a label lookup.
- No poller-side status writes — the workflow owns those.
- No Slack, GitHub or GitLab triggers.
- No genericising the harness into an empty framework. It ships opinionated and working.
