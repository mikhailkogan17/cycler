# Claude Code, Codex and DeepSeek Harness

One config, one workflow, three execution runtimes. `dispatch.runtime` selects `claude` (legacy
default), `codex`, or `dsh`. `CYCLER_RUNTIME` overrides it. The label-to-workflow map is unchanged.
The OAuth application's display name is independent of the selected runtime.

Claude keeps its background-session implementation, keychain preflight and resume behavior.
Codex and dsh use detached Node workers executing the same `task-orchestration.js` with real
CLI-backed agents. Feedback on an existing PR continues the same branch with the saved contract in a fresh worker;
merged/closed PRs stop being followed. Worker state lives under `$CYCLER_HOME/jobs` (default `~/.cycler/jobs`), with
ownership in `managed.json`; these runtimes never call Claude's registry or keychain. A blocked
workflow retains its worktree and requires continuation instead of blind implementation retries.
The Node runner performs a deterministic audit and gate before every commit stage, and detects
contract/gate mutations at stage boundaries. Claude's
PreToolUse hooks are not installed into Codex/dsh: runtime permission policies still govern tools.

## Setup

1. Install/authenticate the selected CLI. DSH package verified: `@deepseek-ai/dsh@0.2.1-rc.2`.
2. Set `dispatch.runtime` and `runtimes.<runtime>.bin` (absolute path under launchd).
3. Remove `dispatch.command` when switching from Claude. Managed runtimes use the portable runner,
   not Claude's background-command template. `runtimes.<runtime>.args` is an argv list (no shell).
4. Run `node /path/to/cycler/harness/install-skills.mjs --repo /path/to/repo`.
   Both Codex and dsh discover `.agents/skills/cycler-*`; existing unrelated skills are preserved.
5. Invoke `$cycler-workflow-feature` in Codex, or the shared skill in dsh. Claude retains
   `/cycler:workflow-feature`. Start/stop/delegate/doctor also have shared skill wrappers.

For desktop-visible Codex work, set `runtimes.codex.transport: app-server` and
`runtimes.codex.thread_mode: workflow`. Ordinary stages resume one named chat (`Cycler APL-147`),
including when they move into the task worktree. Audit, verification and independent reviewers use
fresh ephemeral contexts, so they do not inherit implementation history or create sidebar entries.
Their compact results appear in subsequent workflow turns and the final status turn, including on
blocked runs. No-write runs also receive a final status turn. `state.json` retains `workflowThreadId`
and per-session stage history in `codexThreads`; managed PR-feedback continuations reuse that thread.
`thread_mode: stage` preserves the older separate stage chats. Existing stage chats are not merged
or deleted automatically. The legacy `exec` adapter remains available but its non-interactive sessions
are excluded from the usual interactive history list. `codex resume --all --include-non-interactive`
can inspect those older sessions.

Claude schema-bearing requests use the CLI's native `--output-format json --json-schema` mode.
The adapter validates `structured_output`, rather than parsing the human-facing `result` prose.
Provider errors, missing structured output and invalid values fail closed without a blind paid retry.
Plain-text Claude requests retain text mode.

Set `runtimes.codex.usage_reserve_percent: 20` to prevent a new Codex stage when either included-usage
window is 80% used. The adapter reads `account/rateLimits/read` before starting/resuming a thread,
without a model call. Unavailable data or ordinary-usage denial also holds work. Worker state records
`quotaHold` for the controller; resumption requires a fresh allowed snapshot, not an inferred reset.
This controls stage admission, not the tokens spent by an already admitted turn, so keep headroom
and bounded workflow rounds. No extra credits or reset purchases are made.

Git keeps `.git` read-only inside the ordinary workspace-write sandbox. Unattended Git stages need
an explicit approval route: `runtimes.codex.approvals: auto-review` asks Codex's own reviewer to judge
each escalation. The default `deny` will report blocked Git operations rather than disable isolation.
Get authorization for this setting before enabling it. No client-side blanket approval is implemented.

The portable entry point is an internal helper used by skills and the poller:

```sh
node /path/to/cycler/workflows/run.mjs --runtime codex --cwd /repo --task 'Implement the requested change'
node /path/to/cycler/workflows/run.mjs --runtime dsh --cwd /repo --workflow workflow-bug --task 'ABC-123'
```

`--contract` reuses a contract; `--no-commit` skips commit/PR/review. Research and intake use their
existing skill instructions without requiring a Claude Workflow or ToolSearch tool.

## DeepSeek credentials and model routing

The verified headless CLI is `dsh --profile headless <task>`. It opens no listening port. Its
headless profile disables stored GUI credentials by default: use the provider's launch environment,
project `.env`, or `$DSH_HOME/.env`. Never put provider secrets in committed cycler config.
To use an existing saved DeepSeek sign-in, supply a Cordis overlay via `runtimes.dsh.patch`:

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
```

A model is selected by a Cordis overlay, not a `--model` flag:

```yaml
- id: agent-default-model
  config:
    provider: <your configured provider ID>
    model: <its model ID>
```

Use `runtimes.dsh.model_patches` to map model-route names to overlay paths. Set `review.model` or
a lens's `model` to that route name. An unknown model route fails before starting a session.
Keep any required authentication rows in each overlay; a model overlay replaces the default
`runtimes.dsh.patch` selection. DSH is in preview; inspect the installed CLI before upgrading.

## Independent GitHub review

`/cycler:workflow-review` (Codex: `$cycler-workflow-review`) works without Linear, a contract,
or an implementation run. It reviews an existing PR, using its title/body when no contract is given.

```sh
node /path/to/cycler/harness/review.mjs --cwd /repo --pr https://github.com/owner/repo/pull/123 --publish
```

Configure `review.runtime`, `review.model`, and `review.lenses.<bugs|contract|test-gaps>` with
`runtime`/`model` overrides. Each lens runs in a fresh session over a detached snapshot of the PR
head. Blocking claims get an independent verification. Missing results, malformed output,
unavailable/truncated diff patches, invalid inline locations, changed PR heads and publication
errors fail closed. Omit `--publish` for a local report.

Publication uses GitHub COMMENT reviews (also works for your own PRs), with file/line comments,
provider/lens attribution and a visible idempotency key. A clean report is not a formal APPROVED
review. Fix rounds publish implementer replies to the original threads, citing the pushed commit
and verification, then review the new head. No merging or automatic thread resolution.

## Verification limits

### Codex desktop transport assertions

The optional `runtimes.codex.transport: app-server` adapter uses the official local stdio protocol,
not a listener or a modification of Codex's state database. Each Codex agent stage gets a fresh,
named persistent thread; its ID, model and working directory are recorded in the managed worker state. A completed
worker must retain those thread records so a failure remains inspectable in desktop.

`runtimes.codex.approvals: auto-review` routes requests through Codex's approval reviewer with an
`on-request` policy and a `workspace-write` sandbox. It never grants requests by replying "accept"
from cycler. The default `deny` policy permits no escalation. Read-only review always uses `deny`
and `read-only`, regardless of the write-stage setting. An unhandled approval request, failed turn,
interrupted turn, missing final answer or invalid structured result is a failure.

These are checked against a real fake-server process in `test-codex-app-server.mjs`. The live check
must additionally prove desktop visibility and successful Git worktree creation; a passing model-free
protocol test does not establish either.

The deterministic suite uses fake CLIs and GitHub responses, including failure cases. A successful
mock test does not prove a live model completed the issue-to-PR loop. Live execution needs each
CLI's authenticated account, repository permissions, and a working local gate.

Sources: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/),
[DSH CLI](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli),
[DSH headless](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/apps/headless).
