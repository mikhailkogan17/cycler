# Task Contract — <slug>

> Every task starts by writing a contract. `/intake` fills this in BEFORE any code is written.
> `/implement`, `/verify`, `/review` all read the SAME file — the contract is the single source
> of truth. Copy to `.claude/harness/contracts/<slug>.md`.

## Goal

<One or two sentences: what must be achieved, from the user's own words.>

## Non-goals

- <Explicitly out of scope. If none, write "None — but say so explicitly.">

## Allowed paths

- <Paths that may be edited. Default: the files under "Files expected to change" plus their test companions.>

## Forbidden paths

- <Paths that must NEVER be touched. Defaults that apply to every repo: **the contract file itself**,
  `.claude/harness/contracts/`, the gate config your repo lints with (`eslint.config.js`, `.yamllint`,
  `dangerfile.js` or their equivalents), `package.json`, `package-lock.json`, `config*.yaml`, `.env*`,
  generated dirs (`dist/`, `.test-results/`, build output), `external/` and any submodule, and **any
  test file NOT listed under "Files expected to change"**. Add your repo's own secrets and generated
  paths. Changing the gate or the contract to dodge a red check is itself a blocking violation.

  Note `.claude/**` is NOT forbidden by default: an implementer may work on the harness itself.>

## Files expected to change

- [ ] <path> — <why>
- [ ] <path> — <why>

## Acceptance checks

Commands or manual verifications that MUST pass before this task is done.

**Tag every check with where it came from.** One of:

| tag | means |
|---|---|
| `[user]` | stated in the issue or by the user, in their words. Quote it. |
| `[paraphrase]` | the user's intent, reworded to be checkable. The meaning is theirs; the wording is yours. |
| `[inferred]` | neither — you decided this. It came from reading the code, a convention, or an ADR. |

The tag is not bookkeeping, it is the check on you. An acceptance check you invented reads exactly
like one the user asked for once it is written down, and an auditor cannot tell them apart. Tagging
forces the question "did they actually ask for this?" while there is still time to answer it — and it
makes a run that quietly widened its own scope visible in the diff.

It also catches the opposite failure, which is worse. On APL-16 the issue said "the header must
follow the active segment". Tagging it `[user]` meant checking the code, and the code disagreed: the
header was already correct and the real bug was elsewhere. Implementing the issue as written would
have shipped a regression. **A `[user]` check whose premise the code contradicts is a finding, not an
instruction** — say so in Risks and state the outcome the user actually wants instead.

`[inferred]` checks are where scope creep lives. Each one needs a reason in Risks, and if most of the
list is `[inferred]`, the issue was too thin to contract from — go ask.

- [ ] `[user|paraphrase|inferred]` <exact command or manual check>
- [ ] ...

## Risks / assumptions

- <assumption, risk, or open question to confirm with the user>
