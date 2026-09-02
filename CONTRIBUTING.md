# Contributing to cycler

## How a change moves through here

Spec → failing test → code → gate. In that order.

1. **Say what should be true.** Add or amend a numbered assertion in [`docs/specs/`](docs/specs/). If
   the change closes off an alternative a reasonable person would pick, write an
   [ADR](docs/adr/) too — the format is in `docs/adr/README.md`.

2. **Write the test, and watch it fail.** Run it before the code exists and read the failure. A test
   that has never been red is not evidence; it is a test that passes.

3. **Write the code**, until that test and `node harness/tests/run.mjs` are both green.

4. **Gate it:**
   ```bash
   bash harness/gate.sh --fast --base main
   ```
   `syntax-js`, `syntax-sh`, `syntax-json`, `harness-tests`, `plugin-manifests`. The commit hook
   requires this to have passed on the exact tree you are committing.

5. **Link the assertion to its test** in the spec table, so the two do not drift.

## The rule

**Green is only evidence if the check could have gone red.**

This is not a slogan; it is the specific failure this repo keeps having. Checks that shipped here and
could not fail on the input they judged:

- a predicate returning a literal `true`
- a count/slice pairing no test could reach
- a cross-language check that matched its own doc comment
- a Swift gate that skipped Swift
- a contract hook satisfied by renaming a file
- routing that dispatched the same workflow for everything
- a config-driven test whose config was never loaded — which hid three separate `ReferenceError`s,
  each of which crashed the poller at import time, through a fully green suite

When you add a check, the question is not "does it pass". It is **"what would make this fail, and
have I watched it fail?"**

## Testing conditionals in both directions

Anything that can be on or off needs two assertions:

```js
// off: the feature is absent when nothing configured it
await t('worktree linking is off unless configured', ...)
// on:  it is present, in full, when configured
await t('worktree linking happens when configured', ...)
```

Only the "on" case passes against a hardcoded implementation that ignores config.
Only the "off" case passes against a feature that was deleted.

Where a prompt must *mention* a forbidden thing in order to forbid it, assert the **framing**, not
absence — `test-worktree-node-modules.mjs` checks that every occurrence of the banned command sits
inside a negation. Asserting absence there would pass on a prompt that dropped the warning.

## Test the artefact you ship

`test-yaml.mjs` parses `cycler.example.yaml` itself, and `test-poller-config.mjs` loads it into the
poller. Both exist because five green unit tests coexisted with a shipped example whose
`dispatch.command` parsed as the literal `">"` — which would have made every fresh install spawn a
process named `>`.

If you add a shipped artefact, add the case that loads it.

## Style

Comments explain **why**, with evidence. The codebase cites issue keys (`APL-41`, `APL-48`) from the
project cycler grew in; you cannot resolve them and do not need to, because the finding is always in
the same paragraph. See [ADR 0008](docs/adr/0008-keep-issue-key-citations.md). New comments should
carry their evidence the same way — a measurement, an error message, a cost.

Match the surrounding density. This codebase comments heavily where a mechanism is non-obvious and
not at all where it is.

## Layout

| path | what |
|---|---|
| `poller/` | the trigger: OAuth, polling, dispatch, and the bundled `lin` CLIs |
| `workflows/` | `task-orchestration.js`, the ten-phase workflow |
| `skills/`, `commands/` | what a session and a user invoke |
| `harness/` | gate resolver, default gate, hooks, docs, tests |
| `lib/` | the `cycler.yaml` reader |
| `docs/specs/`, `docs/adr/` | what should be true, and why it was decided that way |
| `.claude/harness/gate.sh` | cycler's own gate — this repo eats its own dog food |

## Scope

cycler does one thing: Linear issue in, gated pull request out, entirely on your own machine.

Out of scope, deliberately: cloud anything, an account, a tunnel, an inbound listener, tokens spent
by the poller, poller-side status writes, and Slack/GitHub/GitLab triggers. Other tools do those.
