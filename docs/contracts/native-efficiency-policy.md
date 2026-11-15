# Native efficiency policy — frozen implementation contract

## Requirements

- [user] Portable Cycler runs perform branch, commit, push, PR and cleanup administration deterministically, with explicit receipts and errors and no merge.
- [user] A failed portable stage resumes from persisted stage outputs, preserving the contract, worktree, workflow thread, code, and review history. Prior side effects are not replayed.
- [user] Gate or audit evidence for changed content cannot be reused. Missing audit or review output cannot mean clean.
- [user] A PR gets one initial independent Sol review and at most two Luna repeats. A repeat follows batched disposition of every prior finding and a green gate. A concrete complex blocker may receive a targeted Sol check.
- [user] Quota, auth, API, stage, scope, missing-output, and stale-head stops are typed, with partial results retained. Interrupted calls do not count as completed reviews.
- [user] Existing live Cycler delivery stays stopped through implementation and verification. Tests use isolated fixtures and do not dispatch real issues.
- [inferred] Preserve legacy Claude workflow behavior where the portable runner is not used, and keep existing managed state and runtime adapters readable.

## Paths and boundaries

- `workflows/run.mjs`: portable stage execution, persistent receipts, deterministic administrative dispatch and stop classification.
- `workflows/task-orchestration.js`: invoke deterministic administrative stages via portable runner; enforce repeat preconditions and review policy without changing native legacy behavior.
- `harness/review.mjs`: independent review invocation policy and durable review budget where needed.
- `lib/runtimes.mjs`: preserve runtime errors with typed classification at the runner boundary.
- `harness/tests/`: integration checks for mechanical no-model stages, resume and side-effect suppression, review budget and failed-review partials.
- `docs/specs/005-runtimes.md`: document portable semantics and limitations.
- Do not edit `external/`, any submodule, personal data, or user logos/assets. No live poller activation or real issue dispatch.

## Acceptance

1. Isolated tests prove administrative stages invoke no model, fail with an exact command, and never merge.
2. A failed stage resumes using its saved contract/worktree/thread and completed receipts. Changed tree invalidates audit/gate evidence.
3. Review ledger persists by PR, counts successful complete reviews, refuses a third repeat, and requires all earlier findings addressed plus a green gate before a repeat.
4. Interrupted reviews preserve partial findings and typed operational failure; absent results never produce approval.
5. `node --check` all JS/MJS, `bash -n` all shell scripts and `node harness/tests/run.mjs` pass. An independent read-only review examines the exact head.
