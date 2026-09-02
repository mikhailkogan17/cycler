# Specs

Each spec states the **observable behaviour** of one part of cycler as numbered assertions, and names
the test that proves each one. If an assertion has no test, it says `— untested`, out loud.

This is the point of writing them down. A spec that only describes intent is a wish; the value is in
being able to run `grep -c untested docs/specs/*.md` and see the size of the gap.

| spec | covers |
|---|---|
| [001-poller](001-poller.md) | trigger: auth, selection, routing, dispatch, reporting |
| [002-config](002-config.md) | `cycler.yaml`: keys, defaults, parsing |
| [003-gate](003-gate.md) | gate resolution, the output contract, the pass marker |
| [004-harness](004-harness.md) | the ten phases, the hooks, review and follow-ups |

## How a change is made here

1. **Say what should be true.** Add or amend a numbered assertion in the relevant spec. If the change
   closes off an alternative a reasonable person would pick, write an [ADR](../adr/) too.
2. **Write the test, and watch it fail.** A test that has never been red is not evidence. Assert both
   directions of anything conditional — a check that only asserts presence passes against a hardcoded
   implementation, and one that only asserts absence passes against a feature that was deleted.
3. **Write the code**, until the test is green and `harness/tests/run.mjs` is green.
4. **Gate it:** `bash harness/gate.sh --fast --base main`.
5. **Update the spec's test column** so the assertion and its proof stay linked.

## The rule the whole repo is built on

**Green is only evidence if the check could have gone red.**

Not a slogan. Checks that had shipped here and could not fail on the input they judged:

- a predicate returning a literal `true`
- a count/slice pairing no test could reach
- a cross-language check matching its own doc comment
- a Swift gate that skipped Swift
- a contract hook satisfied by renaming a file
- routing that dispatched the same workflow for everything
- a config-driven test whose config was never loaded, hiding three `ReferenceError`s

Each looked green for weeks. When you add a check, the question is not "does it pass" — it is
"what would make this fail, and have I seen it fail?"
