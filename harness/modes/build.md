<!-- mode: build — issues labelled Feature, Improvement, or Tech Debt -->

# Build mode

New behaviour, not corrected behaviour. Nothing exists to reproduce, so the contract carries more
weight: it is the only thing standing between "what was asked for" and "what got written".

## 1. Say what you are building, in the contract

Before the Acceptance checks, add a short **Design** paragraph: the approach, the alternative you
rejected, and why. Two or three sentences. If you cannot write it, you do not yet know what you are
building — that is a question for the issue, not a thing to discover mid-diff.

## 2. Follow the surrounding code — survey it with an agent

Ask an agent for the conventions before you write: *"How do modules under X handle errors, naming and
tests? Return the pattern with two `file:line` examples."* A survey read inline sits in your context
for the rest of the run; a survey read by an agent leaves only its conclusion.

Match the conventions already in the files you are touching — naming, error handling, test style.
`AGENTS.md` is the reference. New code that reads like the existing code is reviewable; new code in
a personal style is a second thing to review.

## 3. Tests cover behaviour, not lines

Test what the feature promises, including the edge the issue calls out. Coverage of a happy path
alone means the acceptance check passes and the feature is still broken.

## Escape hatch

If the contract's "Files expected to change" exceeds ~8 files, or touches `apps/macOS/**`, stop
inline work and run the full workflow — see the core process. Big diffs are where fresh-context
agents earn their cost.

## Review lenses for this mode

**bugs**, **contract**, and **test-gaps** (the last on Haiku). Scope is checked by `audit.sh`, not
by an agent.
