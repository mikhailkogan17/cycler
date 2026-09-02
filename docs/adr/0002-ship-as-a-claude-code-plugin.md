# 0002 — Ship as a Claude Code plugin, not a CLI or an npm package

**Status:** Accepted
**Date:** 2026-09

## Context

cycler is two halves: a poller that must run under launchd, and a harness — workflow, skills, hooks,
docs — that must be loaded by a Claude Code session. The obvious packaging is npm: Node is already a
hard requirement, and `npx cycler init` is a familiar shape.

But `npx cycler init` only *copies* the harness into a repo. Every repo then holds its own divergent
copy, a fix means a copy-paste into each one, and there is no way to tell which copies are stale.
That is vendoring with extra steps.

There was also a smaller question: an npm bin plus slash commands is **two** install surfaces to
document, keep in sync and debug.

## Decision

Ship as a Claude Code plugin, installed at user scope. The five slash commands are the entire user
interface:

```
/plugin marketplace add mikhailkogan17/cycler
/plugin install cycler@cycler
/cycler:setup · :start-polling · :stop-polling · :start <KEY> · :doctor
```

No CLI, no npm package, no global binary.

## Consequences

**Better:** one copy on disk. A repo consuming cycler holds only what is genuinely its own — its
`cycler.yaml` and its gate. Upgrading the harness is `/plugin` and affects every repo at once.

**Better:** user scope means the same plugin reaches interactive CLI sessions, poller-dispatched
background sessions, and the desktop app, from one install.

**Worse:** every path inside the harness had to be re-rooted to `${CLAUDE_PLUGIN_ROOT}`, and shell
scripts additionally derive it from their own location so they work with no env var set. That was a
real edit pass across hooks, skills, docs and the workflow.

**Worse:** plugin skills are namespaced. `/task` became `/cycler:task`, and the poller had to be
changed to dispatch the namespaced form — a bare `/task` sends a session a literal string with no
skill behind it, which fails silently and looks exactly like a session that ignored its prompt.

**Worse:** macOS-only for now, because `/cycler:start-polling` writes a launchd job. Nothing else in
the design is platform-specific; a systemd unit would be the port.

## What would change this

If plugins could not express something the loop needs — a background process, say — the poller half
would have to ship separately, and then npm returns as the answer for that half only.
