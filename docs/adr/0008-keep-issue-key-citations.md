# 0008 — Keep the original issue-key citations in comments

**Status:** Accepted
**Date:** 2026-09

## Context

The comments throughout this codebase cite issue keys from the project cycler grew in: `APL-41`,
`APL-48`, `APL-9`. A public reader cannot resolve them. The obvious move before publishing was to
strip them.

## Decision

Keep them.

Every citation is followed by the finding it refers to, in the same paragraph. The key is a citation
marker; the measurement is the content. The README explains this once.

## Consequences

**Better:** the rules keep their evidence. "More than 8 files goes through the full workflow" is a
rule with an obvious exception waiting to be argued. "APL-41 ran inline past this limit: 331 turns,
$8.68, context peaking at 216k, 61% of it in cache reads" is not a rule anyone talks themselves out
of at 2am.

This matters more than usual here, because the readers are partly **models**. A constraint with a
mechanism attached survives contact with a model looking for a reason to deviate; a bare constraint
does not.

**Worse:** it reads as internal at first glance, and a reader may assume the docs were dumped rather
than written. The README paragraph is the mitigation, and it is a weak one.

**Worse:** a reader who wants the full history cannot get it. They get the finding, not the thread.

## What would change this

If someone came to the code and could not follow it because of the keys — as opposed to merely
noticing them — that is the signal. Rewriting each citation as a plain description ("an earlier run
that went inline past this limit") is a mechanical change available at any time; it trades a little
concreteness for a little polish.
