<!--
  A template. Copy the contents into your repo's CLAUDE.md (or append them) so every session — however
  it was started — reads the same process. Replace the bracketed parts.

  This is worth doing rather than relying on whatever dispatched the session: a dispatcher's own prompt
  hooks are not dependable, and one orchestrator here silently stripped the hook its process relied on,
  so that process never reached a single session. What always loads is the repo. Sessions run with
  settingSources ["user","project","local"], so CLAUDE.md reaches every session regardless of who
  launched it.
-->

# [Your project] — agent instructions

`AGENTS.md` is the codebase reference: architecture, commands, conventions. Read it before changing
code. This file covers only *how work is run here*.

## Which harness runs this issue

`${CLAUDE_PLUGIN_ROOT}/harness/ROUTING.md` — one table, first clear match wins. Short version: a
`Research` label means `/research` (a decision, not a diff); a one-liner means just do it. Everything
else is `/task`.

Whatever the route, the gate gates the commit — that is a hook, not a choice.

## Working a Linear issue

**If this session was started from a Linear issue** — dispatched by cycler's poller, a `/task` run, or
a human saying "do ABC-N" — follow the contract-first harness. It is not a style preference: it is
what keeps an unattended run from reporting green on a red gate.

@${CLAUDE_PLUGIN_ROOT}/harness/ISSUE-PROCESS.md

That file routes you to one mode file — `modes/fix.md`, `modes/build.md` or `modes/scope.md` — by the
issue's labels. Read the one it names, not all three.

For anything else — a question, a one-line fix, exploration — just do the work.

## Non-negotiables, whatever the session is

- **The gate is one command:** `bash "${CLAUDE_PLUGIN_ROOT}/harness/gate.sh" --fast --base <base>`,
  with `CONTRACT_PATH` set. It resolves this repo's own `.claude/harness/gate.sh` if there is one.
  Never run an underlying linter bare as a substitute — some of them exit 0 while failing the build,
  so a bare run reads as a pass.
- **Never commit** secrets, local config, or anything under `.claude/harness/contracts/`.
- **Never edit a submodule.** Change the commit reference, or open an upstream PR.
- **Never merge your own PR.** Opening it is where an agent's authority ends.
- **Never spawn a subagent to work a Linear issue. Delegate it instead** — set the issue's *delegate*
  to the Claude agent, and cycler dispatches a real session that leaves a trail on the board. A
  locally-spawned agent leaves none: its worktree, findings and reasoning die with the conversation
  that started it. Note the trigger is the **delegate** field; `--assignee` is a different field and
  dispatches nothing while looking right.
  <!-- [your repo]: add a one-liner here for however you set the delegate. -->

## Repo-specific hazards

<!--
  Put the things that have actually cost this repo a fix round here — the mistake, the symptom, and the
  correct command. This section is the highest-value part of the file and nobody else can write it.
-->

- [e.g. Never symlink the main checkout's `node_modules` into a worktree: Node resolves upward and the
  workspace packages shadow, so the worktree silently builds the other checkout's code.]
