# 0004 — Route by label, not by classifier

**Status:** Accepted
**Date:** 2026-09

## Context

Not every issue should get the same treatment. An issue whose deliverable is a decision has no diff
to gate, no contract to audit and nothing to review; running the implement-and-gate workflow on it
spends a full run to produce a comment.

The tempting design is a small model that reads the issue and picks. It is one prompt, it needs no
setup, and it handles issues nobody labelled.

## Decision

Route by **label**, first match wins, from `cycler.yaml`:

```yaml
routes:
  default: /cycler:task
  byLabel:
    - label: research
      workflow: /cycler:research
```

No model is involved in routing.

## Consequences

**Better:** a label is a decision a human already made and already recorded. Inferring it again is
paying a model to reproduce, less reliably, information that is sitting right there.

**Better:** it is auditable. The dispatch comment names the route and the reason.

**Worse:** an unlabelled issue gets the default, which for a research question means a wasted run.
The fix is labelling the issue, which is cheap and permanent.

**The hazard this design is alert to:** a router that returns the default for everything is
**indistinguishable from a working one** until something checks its choices. That is not
hypothetical — this poller shipped exactly that state, dispatching one workflow for every issue while
a routing table sat in the docs describing behaviour that no automated path implemented. The table
was advice; advice loses.

## What would change this

If a large share of issues arrived unlabelled and mislabelling proved expensive, a classifier could
be added as a *fallback for the unlabelled case only* — never overriding a label a human set.
