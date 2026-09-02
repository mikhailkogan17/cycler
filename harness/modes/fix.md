<!-- mode: fix — issues labelled Bug -->

# Fix mode

A bug is a claim that behaviour differs from intent. Establish the difference **before** changing
anything: a fix for a bug you cannot demonstrate is a guess with a diff attached.

## 1. Reproduce first

Get the failure to happen on demand — a failing test, a script, a command with its output. Put the
exact reproduction in the contract's Acceptance section.

**If you cannot reproduce it, stop and say so.** Post what you tried and what you observed instead.
APL-49 is the cautionary case in the other direction: 559 identical failures sat in
`memory/apply-logs` for weeks because nothing ever asserted the success path existed.

## 2. Root cause, not symptom — but find it with an agent

Locating a root cause is exactly the "read a lot, keep a little" shape that belongs in a subagent.
Send one: *"Trace how X reaches Y; return `file:line` and what each hop does."* Keep the answer, not
the files. APL-20 traced a dead browser page inline across 39 reads and cost 13.34M cache-read tokens
for a two-file fix.

State in the contract *why* the code produced the wrong result, citing `file:line`. "Added a null
check" is a symptom fix; "the delegate never exposed `resolveNode`, so every call threw" is a cause.

If the root cause turns out to be wider than the issue describes, say so in the contract's Risks and
keep the diff to the issue's scope. File the rest as follow-ups.

## 3. The regression test is the deliverable

A bug fix without a test that fails before it and passes after is not finished. The test belongs in
the contract's Acceptance checks as an exact command.

## Review lenses for this mode

**bugs** and **contract**. Add **test-gaps** only if the fix adds logic beyond the regression test.
A one-line fix with a test covering it does not need a third lens.
