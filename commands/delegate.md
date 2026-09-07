---
description: Hand one Linear issue to the agent and dispatch it now, without waiting for the next poll.
argument-hint: <ISSUE-KEY>
---

Delegate `$1` to the Claude agent and dispatch it immediately.

This is the same thing as assigning the issue to Claude on the board, done from here instead. The
issue has to be on the agent for the poller to see it, so put it there first — this is also the fix
when it was assigned from `linear-cli`, whose `--assignee` writes a different field than the one the
poller reads:

```bash
"${CLAUDE_PLUGIN_ROOT}/poller/lin-delegate" $1
```

Then force a poll rather than waiting out the 180s interval:

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs"
```

If the issue was already dispatched once, the poller skips it — its id is in
`~/.cycler/processed.json` — state, not config. To deliberately re-run it, remove that one id from the array first and
say that you did.

Report the `routing …` and `dispatched …` lines, including the session id, so the user can
`claude attach <id>`.

The work does **not** happen here: the poller starts a separate background session, and that session
is what runs `/cycler:workflow-feature` (or whatever `workflows` routes the issue to).
