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

The deterministic suite uses fake CLIs and GitHub responses, including failure cases. A successful
mock test does not prove a live model completed the issue-to-PR loop. Live execution needs each
CLI's authenticated account, repository permissions, and a working local gate.

Sources: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/),
[DSH CLI](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli),
[DSH headless](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/apps/headless).
