<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.png">
    <img src="docs/assets/logo-light.png" width="620"
         alt="cycler — a loop: the board hands work to the agent, the agent hands a pull request back to the board.">
  </picture>
</p>

<h1 align="center">Delegate a Linear issue to Claude. Get a gated pull request back.</h1>

<p align="center">
  On your machine · your harness · your gate · no cloud, no webhook, no tunnel
</p>

---

## Why cycler

You already write the tickets. Writing them twice — once for your team, once as a prompt — is the
part nobody wants to do. cycler closes the loop: **delegate an issue in Linear and a Claude Code
session starts in your repo, writes a contract, implements it, runs your gate, opens the PR, and
comments the result back on the issue.** You review a PR instead of babysitting a chat.

It is a poller and a launchd job. Nothing listens on your machine; the poller makes one outbound
request every 180 seconds to an OAuth app in your own Linear workspace. It never
calls a model — every token is spent by the session you configured, with the model, the permissions
and the harness you chose.

**What's already out there, and where cycler sits:**

| | |
|---|---|
| [**cyrus**](https://github.com/cyrusagents/cyrus) | A full background-agent *platform* — Linear, Slack, GitHub, GitLab — with its own harness and its own child agents. Powerful, and a lot of surface. cycler is a local service: it dispatches into **your** harness and gets out of the way. |
| [**agent-acp-bridge**](https://github.com/larryhudson/agent-acp-bridge) | Connects Linear/Slack/GitHub to ACP agents and streams progress back. That is the transport. cycler ships the engineering discipline on top of it — contract, gate, audit, review. |
| [**flow-next**](https://github.com/gmickel/flow-next) | Excellent repo-local workflow discipline, but *you* start every run. Nothing binds a Linear agent to it, so the board never hands work over on its own. |
| **Copilot / Codex on Linear** | One click, and execution happens in someone else's cloud on someone else's harness. No choice of gate, no choice of workflow, and your repo leaves your machine. |

cycler is the one where **the board triggers it, the harness is yours, and it all runs on your
laptop.**

<details>
<summary><b>What the session actually does</b> — the part worth reading if you're evaluating the engineering</summary>

`/cycler:task` runs **Contract → Branch → Implement → Audit → Verify → Commit → PR → Review →
Follow-ups → Cleanup**.

- **The contract comes first.** Goal, non-goals, allowed and forbidden paths, and acceptance checks
  written as exact commands. Every requirement line carries a provenance tag — `[user]`,
  `[paraphrase]`, `[inferred]` — so a later reader can tell which constraints came from the issue
  and which the agent invented.
- **The rules are enforced outside the agent.** Four `PreToolUse` hooks: no edits before a contract
  exists, no commit on a red gate, a large change must go through the full workflow rather than
  inline, no writes outside the session's worktree. Prose can be argued with; a hook cannot.
- **Audit is arithmetic before it is judgement.** A script checks paths, scope, secrets and whether
  the run edited its own contract. Only then does an agent answer what a script cannot: are the
  acceptance checks actually met by this diff?
- **Review runs four lenses in parallel** — bugs, contract, test gaps, scope creep. Only blocking
  findings get an adversarial refuter, and only the lens that raised one is re-run after a fix.
- **Follow-ups become tracked issues**, not paragraphs in a PR description nobody reads.
- **It opens pull requests and never merges.** Every change still passes a human.

The rule underneath all of it: **green is only evidence if the check could have gone red.** Eight
checks in this harness's history turned out to be incapable of failing on the input they judged — a
predicate that returned a literal `true`, a cross-language check that matched its own doc comment, a
Swift gate that skipped Swift, a config-driven test whose config was never loaded. Writing the check
is not the work. Watching it go red is.

The reasoning behind the load-bearing choices is recorded as ADRs in [`docs/adr/`](docs/adr/);
[`docs/specs/`](docs/specs/) is the behavioural spec each part is written against.

</details>

---

## Install

**You need:** macOS · Node 18+ · [Claude Code](https://claude.com/claude-code) · a Linear workspace
you can create an OAuth application in.

In Claude Code:

```
/plugin marketplace add mikhailkogan17/cycler
/plugin install cycler@cycler
/cycler:setup
```

`/cycler:setup` is the whole thing: it walks you through the Linear OAuth application, runs the
authorisation, writes the config, installs the workflow into your repo, checks your gate, verifies
one poll and loads the launchd job.

Then, in Linear, **delegate** an issue to the Claude agent. Delegate, not assign — they are
different fields, and assigning dispatches nothing while looking correct.

| command | does |
|---|---|
| `/cycler:setup` | one-time setup, polling included |
| `/cycler:start <KEY>` | dispatch one issue now, without waiting for the next poll |
| `/cycler:stop-polling` | unload the launchd job |
| `/cycler:doctor` | diagnose the eight things that actually break |

> [!IMPORTANT]
> **Anyone who can delegate an issue to the agent can run code on your machine.** The issue becomes
> the prompt of a Claude Code session in your repo, by default with `--permission-mode auto`. Treat
> delegate rights as repository write access plus a shell. On a solo workspace this is a non-issue;
> on a shared one, restrict who can delegate. The mitigations — a shell-free dispatch, contract path
> limits, worktree confinement, and never merging — are real but are not a substitute for trusting
> the people who can delegate.

---

## Config

**One file:** `~/.config/cycler/config.yaml`. Credentials, repo, workflows — all of it. Not in your
repo, so the client secret is never one `git add .` from a public history.

```yaml
linear:
  client_id: ********
  client_secret: ********

repo:
  path: ~/your-repo
  base: main
  branch_prefix: claude/

workflows:
  default: /cycler:task        # contract → implement → audit → gate → PR
  research: /cycler:research   # a decision, not a diff

dispatch:
  command: >
    claude --background --name "{session}" --remote-control "{session}"
    --remote-control-session-name-prefix linear --permission-mode auto
    --append-system-prompt "Started by cycler for {issue}" "{workflow} {issue}"
  path_prepend: [~/.local/bin, ~/bin, /opt/homebrew/bin, /usr/local/bin]
```

Every key is optional and every default is a value that works. `workflows` is a plain
label → workflow map: add a Linear label as a key and issues carrying it route there.

📄 [**Annotated example**](cycler.example.yaml)  ·  📚 [**Full reference — every key, its default,
and when to reach for it**](docs/specs/002-config.md)

### The gate is yours

cycler does not own your gate — it always depends on the repo and the stack. It uses
`.claude/harness/gate.sh` in your repo whenever that exists, and otherwise falls back to `lint`,
`build` and `test` from `package.json`. Copy [`harness/gate.default.sh`](harness/gate.default.sh)
into your repo and replace the checks; what you inherit is the runner. A repo with no gate and no
lint/build/test script reports **FAIL**, not a pass — a gate that checked nothing must not read as
green.

---

## Similar projects

- [**cyrus**](https://github.com/cyrusagents/cyrus) — the Claude Code background agent for Linear,
  Slack, GitHub and GitLab, deployable anywhere
- [**agent-acp-bridge**](https://github.com/larryhudson/agent-acp-bridge) — talk to Claude Code and
  other ACP agents from Linear, Slack and GitHub
- [**flow-next**](https://github.com/gmickel/flow-next) — repeatable agentic engineering: durable
  specs, fresh-context workers, adversarial cross-model review

---

## Author & License

Built by **[Mikhail Kogan](https://github.com/mikhailkogan17)** — iOS/platform engineer, Tel Aviv.
Contributions welcome: [`CONTRIBUTING.md`](CONTRIBUTING.md) explains how a change moves through
spec → test → code here.

MIT — see [`LICENSE`](LICENSE).
