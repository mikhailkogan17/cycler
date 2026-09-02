---
description: One-time cycler setup — Linear OAuth app, token, cycler.yaml, and a verified first poll.
---

Set this repo up for cycler. Work through the steps in order and stop at the first one that fails —
a half-configured poller dispatches nothing and says nothing, which is the failure mode hardest to
diagnose later.

## 1. The Linear OAuth application

Ask the user to create it (you cannot — it needs their browser and their workspace):

> Linear → Settings → API → Applications → **New application**
> - **Name:** `Claude` — this is the name that appears on the board as the agent
> - **Callback URL:** `http://localhost:8787/callback`
> - **Webhooks:** leave OFF. cycler polls; nothing needs to reach your machine from outside.
> - Then copy the **Client ID** and **Client secret**.

Write them to `~/.cycler/config.json` (create the directory; `chmod 600` the file):

```json
{ "clientId": "...", "clientSecret": "..." }
```

Never put these in `cycler.yaml` — that file is committed.

## 2. Authorise

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs" auth
```

A browser opens. The user approves. The token lands in `~/.cycler/token.json`.

Linear access tokens expire after 24h; the poller refreshes them itself, so this is genuinely
one-time unless the token is revoked.

## 3. cycler.yaml

Copy `${CLAUDE_PLUGIN_ROOT}/cycler.example.yaml` to the repo root as `cycler.yaml` and fill in
`repo.path` (this repo's absolute path) and `repo.base` (the PR base branch). Ask the user before
changing anything else — the defaults are the values that work.

## 4. Enable the hooks

The four `PreToolUse` hooks ship with the plugin and load automatically. Confirm they are active by
checking that this prints a path:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/harness/hooks/"
```

## 5. The gate

cycler does not own your gate — it always depends on the repo and the stack. Check which one
resolves:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/harness/gate.sh" --fast --base "$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.base main)"
```

The first stderr line says whether it used the repo's own `.claude/harness/gate.sh` or cycler's
default. If it used the default and the repo has real checks to run, tell the user to copy
`${CLAUDE_PLUGIN_ROOT}/harness/gate.default.sh` to `.claude/harness/gate.sh` and add them.

## 6. Verify one poll

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs"
```

It should print `poll ok: N delegated, M processed total`. That is the whole loop's heartbeat.

Then tell the user how to use it: **delegate** an issue to Claude in Linear (delegate, not assign —
assigning looks right and dispatches nothing), and run `/cycler:start-polling` to have it picked up
automatically every 180 seconds.
