# 0003 — The gate belongs to the consuming repo

**Status:** Accepted
**Date:** 2026-09

## Context

The gate is the load-bearing check: nothing commits without it passing. It is also the most
repo-specific thing in the system. The gate cycler grew from runs `danger`, `xcodegen`,
`swiftformat`, `swiftlint`, `yamllint`, an npm workspace build and an Xcode test suite. None of that
means anything in a Go repo.

Two bad answers were available. Ship that gate and let strangers fight it. Or generalise it into a
configurable check-runner — which sounds right and is how a working, opinionated gate becomes an
empty framework that gates nothing by default.

## Decision

The gate is **resolved**, not owned. `harness/gate.sh` is a resolver:

1. `$CLAUDE_PROJECT_DIR/.claude/harness/gate.sh` — the repo's own. Wins whenever it exists.
2. `harness/gate.default.sh` — cycler's default: `lint`, `build`, `test` autodetected from
   `package.json`.

It `exec`s, so the chosen gate's output and exit status pass through unchanged and every caller sees
the same output contract. It reports which gate it chose **on stderr**, never stdout.

Checks too slow for a gate go in `cycler.yaml` under `verify.steps`, so the verify agent runs them.

## Consequences

**Better:** a repo keeps the gate it already trusts. Adopting cycler does not mean re-litigating what
"green" means.

**Better:** the default is honest about its own limits. A repo with no `lint`/`build`/`test` script
gets **FAIL**, not `GATE: PASS (0 of 0)`. A gate that checked nothing must never read as green.

**Worse:** two gates exist, and they must agree on the pass marker. They did not, once — see
[0007](0007-index-independent-gate-marker.md).

**Worse:** the resolver is a place a mistake hides. A resolver that always returned the default would
look identical to a working one, which is why the provenance line and a both-directions test exist.

## What would change this

If the default gate grew enough autodetection to be genuinely useful across ecosystems, the priority
might invert — default first, repo gate as override. Nothing suggests that yet.
