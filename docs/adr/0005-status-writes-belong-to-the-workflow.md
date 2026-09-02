# 0005 — Issue status is written by the workflow, not the poller

**Status:** Accepted
**Date:** 2026-09

## Context

The loop is only a loop if the board reflects what happened. Something has to move an issue to *In
Progress* when work starts and to *In Review* when a PR opens.

The poller is the tempting place to do it. It already runs every 180 seconds, it already knows which
issues it dispatched, and it can watch whether a session is still alive — so it can write status for
**any** workflow, including one it knows nothing about. An earlier version of this repo did exactly
that, and it was the wrong call.

## Decision

Status transitions belong to the workflow. `task-orchestration.js` plans them —
`linearSync('started' | 'open-questions' | 'pr-opened' | 'approved' | 'blocked-<stage>')` — and the
`/cycler:task` skill performs them with `lin issue update --state`, made idempotent by an HTML marker
comment.

The poller writes exactly two things: a dispatch comment, and a failure comment.

## Consequences

**Better:** the workflow knows the **outcome**. A poller watching process liveness knows only that a
process ended — which is true of a successful run, a crash, a budget stop and a user hitting Ctrl-C
alike. Reporting "the session ended" as if it meant "the work is done" is a green report on an
unknown result, which is the one thing this whole system exists to prevent.

**Better:** the states are meaningful. *Blocked at gate* and *open questions posted* are distinctions
only the workflow can draw.

**Worse:** a workflow that does not implement `linearSync` writes no status at all. cycler's do; a
user's custom workflow must opt in. That is the honest trade — the alternative is a dumber layer
overwriting a better-informed one.

**Worse:** if a session dies hard, the issue can sit in *In Progress* with nothing running. The
dispatch comment carries the session id, so `claude logs <id>` says what happened; `/cycler:doctor`
does not yet detect this case.

## What would change this

A reliable, outcome-bearing signal from a dead session — an exit status the poller could read, rather
than mere liveness — would make a poller-side fallback safe for the crash case. It would still not
justify moving the normal path there.
