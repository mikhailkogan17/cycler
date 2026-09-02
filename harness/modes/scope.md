<!-- mode: scope — issues too thin to contract from -->

# Scope mode

The issue does not yet say enough to build from. **Do not implement anything.** The deliverable is a
contract and a set of answerable questions, nothing else.

This mode exists because the alternative is worse: an implementer who guesses produces a diff that
passes its own acceptance checks — because it wrote them — while solving a problem nobody had.

## What to produce

1. **A contract** at `.claude/harness/contracts/<ISSUE>-<slug>.md`, filled in as far as the evidence
   allows. Leave Acceptance checks blank rather than inventing them.
2. **The open questions**, posted as your reply on the issue. Each one specific enough to answer in a
   sentence — not "what should this do?" but "when a run has no profile, should it fail or fall back
   to the default?"
3. **What you found while looking** — the files involved, with `file:line`, so whoever answers the
   questions does not start from zero.

## What not to do

- No code changes. No PR. No branch work beyond the contract file.
- Do not answer your own questions by picking the most likely option and building it.
- Do not file follow-up issues; the scoping answer may dissolve them.

## When you are done

Report `scoped`, list the questions, and stop. Once the issue is answered it comes back as a fix or
build run with a real contract.
