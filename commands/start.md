---
description: Start cycler — set up whatever is not set up yet, then load the launchd polling job.
---

Start cycler in this repo. There is one command for both the first run and every run after it: on a
fresh machine this is the full setup, and on a configured one it is "make sure the loop is on".

**Work out what is already done before doing anything.** Run this first and let the answers pick
which steps below you actually need — re-running a step that is already done is safe for every step
here, but reporting "set up" for a step you skipped blindly is not.

```bash
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/cycler/config.yaml"
LABEL="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" launchd.label dev.cycler.linear)"
echo "config:   $([ -f "$CFG" ] && echo "$CFG" || echo MISSING)"
echo "client:   $(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" linear.client_id '' | grep -q . && echo present || echo MISSING)"
echo "token:    $([ -f ~/.cycler/token.json ] && echo present || echo MISSING)"
echo "workflow: $([ -f .claude/workflows/task-orchestration.js ] && echo installed || echo MISSING)"
echo "job:      $(launchctl list | grep -q "$LABEL" && echo loaded || echo "not loaded")"
```

Never print the client secret — say `present` or `MISSING`.

- Everything present and the job loaded → say so, confirm the loop is alive by tailing the log
  (step 8), and stop. Do not re-authorise; a fresh `auth` run replaces a working token.
- Anything missing → do the steps that cover it, in order, and stop at the first failure. A
  half-configured poller dispatches nothing and says nothing, which is the failure mode hardest to
  diagnose later.

Steps 1–3 are skipped entirely when `config`, `client` and `token` are all present. Step 8 always
runs: this command's job is to leave the loop switched on.

## 1. The Linear OAuth application

Ask the user to create it (you cannot — it needs their browser and their workspace):

> Linear → Settings → API → Applications → **New application**
> - **Name:** `Claude` — this is the name that appears on the board as the agent
> - **Callback URL:** `http://localhost:8787/callback`
> - **Webhooks:** leave OFF. cycler polls; nothing needs to reach your machine from outside.
> - Then copy the **Client ID** and **Client secret**.

It must be an **application**, not a personal API key. A personal key acts as the user, and an issue
is *delegated to an agent* — the app is what makes "Claude" a name the delegate field can hold.

## 2. The config file

**One file, and it is not in the repo:**

```
~/.config/cycler/config.yaml
```

Copy `${CLAUDE_PLUGIN_ROOT}/cycler.example.yaml` there (`mkdir -p ~/.config/cycler` first), then fill in:

- `linear.client_id` and `linear.client_secret` from step 1
- `repo.path` — this repo's absolute path
- `repo.base` — the PR base branch

`chmod 600` it: it holds the client secret. Ask the user before changing anything else — the
defaults are the values that work.

There is deliberately no second config. Everything cycler reads is in this file; `~/.cycler/` holds
only state the poller *writes* (the refreshing token, the processed-issue list, the logs).

## 3. Authorise

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs" auth
```

A browser opens. The user approves. The token lands in `~/.cycler/token.json`.

Linear access tokens expire after 24h; the poller refreshes them itself, so this is genuinely
one-time unless the token is revoked.

## 4. Install the workflow into the repo

```bash
mkdir -p .claude/workflows
cp "${CLAUDE_PLUGIN_ROOT}/workflows/task-orchestration.js" .claude/workflows/task-orchestration.js
```

**This copy is not optional and not vendoring by preference.** The `Workflow` tool only runs a script
it can already read — the working directory, or a directory the session has been given — so a path
inside the plugin is refused outright:

```
scriptPath must be a script path this tool returned, or a file you can already read
(the working directory or a directory you have added): .../cycler/workflows/task-orchestration.js
```

Without this file, the escape hatch prints an instruction no run can follow, and a blocked run's only
remaining move is to waive the guard. That happened.

Commit it, or gitignore it and re-run `/cycler:start` after each plugin upgrade — but say which, and
tell the user, because a stale copy here is a workflow that silently differs from the plugin's.

## 5. Enable the hooks

The four `PreToolUse` hooks ship with the plugin and load automatically. Confirm they are active by
checking that this prints a path:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/harness/hooks/"
```

## 6. The gate

cycler does not own your gate — it always depends on the repo and the stack. Check which one
resolves:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/harness/gate.sh" --fast --base "$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.base main)"
```

The first stderr line says whether it used the repo's own `.claude/harness/gate.sh` or cycler's
default. If it used the default and the repo has real checks to run, tell the user to copy
`${CLAUDE_PLUGIN_ROOT}/harness/gate.default.sh` to `.claude/harness/gate.sh` and add them.

## 7. Verify one poll

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs"
```

It should print `poll ok: N delegated, M processed total`. That is the whole loop's heartbeat. Do not
continue to step 8 until it does: installing a launchd job around a poll that fails gives you a job
that fails every 180 seconds and looks, from `launchctl list`, exactly like one that works.

## 8. Install the launchd polling job

Resolve absolute paths first — **launchd has a minimal PATH and will not find these by name**:

```bash
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude)"
REPO="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.path "$PWD")"
LABEL="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" launchd.label dev.cycler.linear)"
PLIST=~/Library/LaunchAgents/"$LABEL".plist
```

The plist is named after the label on purpose. `launchctl` addresses jobs by **label**, and a label
that does not match what you loaded fails with a 501 that reads like "not running".

Write `$PLIST`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE_BIN</string>
    <string>PLUGIN_ROOT/poller/poller.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_BIN</key><string>CLAUDE_BIN</string>
    <key>REPO_PATH</key><string>REPO</string>
    <key>CLAUDE_PROJECT_DIR</key><string>REPO</string>
  </dict>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>HOME/.cycler/poller.log</string>
  <key>StandardErrorPath</key><string>HOME/.cycler/poller.err</string>
</dict>
</plist>
```

Substitute the real values for `LABEL`, `NODE_BIN`, `CLAUDE_BIN`, `PLUGIN_ROOT`, `REPO` and `HOME`.

**The `Label` inside the plist must equal `$LABEL` exactly.** `launchctl` addresses jobs by label,
not by filename; a mismatch fails with a 501 that reads like "not running" and costs an hour.

Load it:

```bash
mkdir -p ~/.cycler
launchctl unload "$PLIST" 2>/dev/null
launchctl load  "$PLIST"
launchctl list | grep "$LABEL"
```

`RunAtLoad` means it polls immediately. Confirm with:

```bash
sleep 5 && tail -3 ~/.cycler/poller.log
```

Report the last `poll ok` line. If the log is empty or shows an error, say so — do not report success
because the job loaded. A loaded job that fails every poll looks identical to a working one from
`launchctl list`.

## Done

Tell the user how to use it: assign an issue to Claude in Linear, and the poller picks it up
within 180 seconds.

`/cycler:delegate <KEY>` dispatches one now. `/cycler:stop` unloads the job.
`/cycler:doctor` diagnoses it.
