# 0006 — Enforce the process with hooks, not prose

**Status:** Accepted
**Date:** 2026-09

## Context

The harness is a process: write a contract, implement inside its allowed paths, gate, then commit.
Written as instructions, every step of that is negotiable by the model executing it — not through
disobedience, but through ordinary reasoning. *This change is small, the contract is overhead. The
gate is slow and the change is obviously safe.* Each is locally plausible, and the result is an
unverified diff in a PR that reads as verified.

## Decision

The four load-bearing rules are `PreToolUse` hooks, which deny the tool call:

| hook | denies |
|---|---|
| `require-contract.sh` | an edit before a contract exists for this issue |
| `require-green-gate.sh` | a commit when the gate has not passed on **this** tree |
| `require-escape-hatch.sh` | inline editing past the configured size or paths |
| `confine-to-worktree.sh` | a write outside the session's worktree |

## Consequences

**Better:** the rules hold for a session that never read the docs — including one dispatched
unattended at 4am, which is the case that matters.

**Better:** a hook cannot be argued with. Prose describing a script is a *claim* about the script,
and nothing checks it. This repo's own docs asserted a Swift gate did not exist while the script ran
it, and asserted there was no scope-creep review lens while the workflow dispatched one.

**Worse:** hooks fire on the session's working directory, not on the repo a command happens to touch.
Driving a second repo from a session rooted in the first means the first repo's gate marker governs
the commit. Correct behaviour, surprising the first time.

**Worse:** a hook that is subtly wrong blocks everything. See
[0007](0007-index-independent-gate-marker.md) — a marker that changed when files were staged made the
ordinary `gate → add → commit` sequence impossible, and said so in a message claiming an edit that
never happened.

**Worse:** they are shell, and shell fails in quiet ways. `set -u` on an unset variable, a `[ -f ]`
test as the last statement in a loop under `pipefail` — both were real, both surfaced as a hook
erroring rather than deciding.

## What would change this

Nothing foreseeable. The one refinement worth making is more coverage of the hooks themselves; every
hook bug so far was caught by a person hitting it, not by a test.
