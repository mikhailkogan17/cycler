---
description: Dispatch one Linear issue now, without waiting for the next poll.
argument-hint: <ISSUE-KEY>
---

Dispatch `$1` immediately.

The issue must be **delegated** to the Claude agent in Linear — that is the field the poller filters
on. Assigning is a different field: it looks right and dispatches nothing. If it is not delegated:

```bash
"${CLAUDE_PLUGIN_ROOT}/poller/lin-delegate" $1
```

Then force a poll rather than waiting out the 180s interval:

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs"
```

If the issue was already dispatched once, the poller skips it — its id is in
`~/.cycler/processed.json`. To deliberately re-run it, remove that one id from the array first and
say that you did.

Report the `routing …` and `dispatched …` lines, including the session id, so the user can
`claude attach <id>`.
