---
name: research
description: Answer a RESEARCH issue — investigate, decide, post findings to Linear. No code, no contract, no gate. Use for issues labelled Research, or any question whose deliverable is a decision rather than a diff.
---

# /research — investigation whose deliverable is a decision

`/task` is for changing code. This is for the issues where the output is a **recommendation** — the
`RESEARCH:` issues on the APL board, "should we use X", "what is our exposure to Y".

Running those through `/task` is waste: no contract to write, nothing for `gate.sh` to gate, no diff
to audit or review. Two research runs done this way cost **83k and 117k tokens** and produced cited,
decisive answers. The same questions through the full harness would have paid for a contract stage,
an audit, a gate and a review panel, all of which would have had nothing to judge.

## Inputs

An issue key (`APL-27`), a Linear URL, or a bare question.

## 1. Do not duplicate — check first

```bash
~/bin/lin issue view <KEY>
```

**Read the existing comments before doing anything.** A prior run may already have answered this: a
rate limit killed an agent mid-session and its recommendation was already posted, so the relaunch
produced a second contradicting comment on the same issue and a human had to reconcile them.

- Substantive answer already there → **do not re-run it**. Either add only what is genuinely missing,
  or reply saying it already covers the ground. Say which you did.
- Partial answer → extend it, naming what you are adding.
- Nothing → proceed.

## 2. Ground it in this repo before reaching for the web

The value of these answers is that they are about **this** codebase, not the topic in general.
Anyone can summarise a topic; only you can say what `outcome-store.ts:153` actually does.

- Read what the issue is about — real files, real line numbers.
- **State which claims you verified in code and which you assumed.** APL-25's most useful output was
  not the legal summary; it was noticing that `config.yaml` asks for LinkedIn credentials nothing
  reads, which fell out of reading the code to describe the tool accurately.
- Web research (`ToolSearch` → `select:WebSearch,WebFetch`) is for facts outside the repo: terms of
  service, prior art, what a library actually does. Cite URL and access date.

## 3. Decide

**A research issue exists because nobody has chosen. Returning a survey leaves it exactly where it
was.**

- Lead with the recommendation in one sentence.
- Say what to **stop** doing, not only what to start. "Pick one approach instead of three" means two
  get deleted, and naming which is the whole job.
- Where you are choosing between real options, say what the loser costs.
- **A named gap beats a plausible guess.** "I could not find authoritative information on X" is a
  valid finding and more useful than a confident sentence you cannot support.
- Contradict the issue when the evidence contradicts it. APL-27's premise — that the gate had no
  Swift coverage — was false, and saying so changed the conclusion. That correction was worth more
  than the recommendation it came wrapped in.

## 4. Post it

```bash
~/bin/lin issue comment add <KEY> --body-file <file>
```

Use `--body-file` for anything long: a body with backticks, newlines and code spans gets mangled
through a shell argument.

Structure: recommendation first, then reasoning, then what to stop. Every claim about this repo
carries `file:line`. Every claim about the world carries a URL and a date. Mark inferences as
inferred.

## 5. Report

The recommendation in 3-4 sentences, the comment URL, whether you found a prior comment, and your
token usage.

## Depth

Default **shallow**: read what the issue names, decide, post. Most research issues are one focused
question and a shallow pass answers them for well under 100k tokens.

Go deeper only when the question genuinely spans surfaces — several platforms, several subsystems.
`/research <KEY> --deep` is that signal. Deep means more reading, **not** a fan-out of subagents: an
agent per sub-question costs a cold start each and returns prose you then have to reconcile. Both
research runs that worked were single agents.

## Rules

- **No code changes. No branch. No PR.** If the answer implies a code change, say what the change is
  and file it as its own issue — do not start writing it.
- Do not run `gate.sh` or `audit.sh`. Both judge a diff, and there is no diff. Running them on an
  empty tree is a check that cannot fail.
- Keep tool output small: read ranges, grep for symbols, never dump whole files. The context you
  accumulate is re-read on every later turn of your own run.
- File genuinely out-of-scope defects you trip over as Triage issues (`~/bin/lin issue create --team
  APL --title '...' --description-file <file> --state triage`), at most 3, each verified. Both
  research runs found real bugs this way.
