# Architecture decision records

One file per decision that would otherwise be re-litigated. Each records what was decided, what it
cost, and **what would make it wrong** — that last part is the one people skip, and it is what makes
an ADR readable years later by someone who wants to change it.

An ADR is written when a choice closes off alternatives that a reasonable person would otherwise
pick. Not every change needs one; most do not.

| # | Decision | Status |
|---|---|---|
| [0001](0001-poll-instead-of-webhook.md) | Poll Linear outbound instead of receiving webhooks | Accepted |
| [0002](0002-ship-as-a-claude-code-plugin.md) | Ship as a Claude Code plugin, not a CLI or npm package | Accepted |
| [0003](0003-the-gate-belongs-to-the-repo.md) | The gate belongs to the consuming repo | Accepted |
| [0004](0004-route-by-label-not-classifier.md) | Route by label, not by classifier | Accepted |
| [0005](0005-status-writes-belong-to-the-workflow.md) | Issue status is written by the workflow, not the poller | Accepted |
| [0006](0006-enforcement-outside-the-agent.md) | Enforce the process with hooks, not prose | Accepted |
| [0007](0007-index-independent-gate-marker.md) | The gate marker hashes content, not index state | Accepted |
| [0008](0008-keep-issue-key-citations.md) | Keep the original issue-key citations in comments | Accepted |

## Format

```markdown
# NNNN — Title

**Status:** Accepted | Superseded by NNNN
**Date:** YYYY-MM

## Context
What forced a choice.

## Decision
What was chosen, in one or two sentences.

## Consequences
What this costs, including the parts that are worse.

## What would change this
The observation that would make this decision wrong.
```
