---
name: workflow-review
description: Independently review an existing GitHub PR with configurable Claude, Codex or DeepSeek reviewers; publish line comments and verify implementer replies. Works standalone without Linear or an implementation run.
---

# Independent GitHub review

Resolve cycler's installation root from `CYCLER_ROOT`, `CLAUDE_PLUGIN_ROOT`, or this skill's
path (`../..`). Do not assume a Claude Workflow tool or Linear connection exists.

Given a PR URL or number, run:

```bash
node "$CYCLER_ROOT/harness/review.mjs" --cwd "$PWD" --pr '<PR>' --publish
```

This starts independent sessions for bugs, contract/scope and regression coverage. Configure
`review.runtime`, `review.model`, or `review.lenses` in cycler's YAML for cross-model review.
The harness fetches a detached snapshot of the PR head, verifies blocking findings against
actual code, checks inline locations, and publishes a GitHub COMMENT review. This works when
the authenticated account also authored the PR. The body says whether changes are required;
it does not forge a GitHub APPROVED state.

Publication is part of this workflow. An empty review means all reviewers ran and found no
blocking issues. A missing reviewer, stale head, invalid location or GitHub error is a failure,
not approval. Report it and stop. Never substitute your own review for a failed independent lens.
Without `--publish`, the helper returns a local report for an explicitly requested draft review.

For a requested fix, use the existing PR branch, fix verified findings, run the repo gate,
commit and push. Read each returned thread; write a JSON array of `{id, body}` with a concrete
explanation of the fix and test, or evidence for disagreement. Publish replies in those threads:

```bash
node "$CYCLER_ROOT/harness/review.mjs" --cwd "$PWD" --pr '<PR>' --replies /path/to/replies.json --commit '<full pushed SHA>'
```

Then run the review again against the new head. Never merge, resolve threads on the author's
behalf, or claim a fix without inspecting it. Link the PR and mention any failed publication.
