# 0007 — The gate marker hashes content, not index state

**Status:** Accepted
**Date:** 2026-09

## Context

`require-green-gate.sh` must distinguish "the gate passed" from "the gate passed, then somebody
edited". It does this with a marker: the gate writes a hash of the tree it judged, and the hook
recomputes that hash and compares.

The original hash was the concatenation of `git diff HEAD`, `git diff --cached`, and the untracked
file list. All three change when you run `git add`: an untracked file leaves the `--others` list, and
a tracked one appears in `--cached` where it was absent.

So the ordinary sequence — run the gate, stage, commit — **could never pass**. The hook reported
"the tree changed since the last green gate" every time, for a tree where nothing had changed.

Worse, the gate and the hook each carried their own copy of the computation, so the two could drift
independently. They did.

## Decision

One script, `harness/tree-fingerprint.sh`, called by both gates and by the hook. It takes every path
that differs from HEAD or is untracked, sorted, and hashes the path plus its **working-tree
content**.

Staging is not an edit. Only content is.

## Consequences

**Better:** `gate → add → commit` works, which is the sequence every human and every workflow
actually uses.

**Better:** one implementation. A fingerprint that disagrees with itself blocks every commit for no
reason and is miserable to diagnose, because the message describes an edit rather than a mismatch.

**Worse:** it reads the content of every changed file, where the old version read a diff. On a
change with large binary files this is slower. Not measurable at the sizes seen so far.

**Worse:** a repo gate that predates this keeps its own copy and disagrees with the hook. That is a
real migration hazard, and it is why the consuming repo's gate delegates to the plugin's script with
the inline computation only as a fallback.

## What would change this

If the content read became a bottleneck, hashing `git hash-object` per path would be equivalent and
cheaper — the property that matters is index-independence, not the specific hash.
