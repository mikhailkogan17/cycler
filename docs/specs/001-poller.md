# Spec 001 — the poller

`poller/poller.mjs`. Runs under launchd every 180s. Never calls a model.

## Authentication

| # | Assertion | Test |
|---|---|---|
| 1.0 | The client id and secret come from `linear.client_id` / `linear.client_secret` in the one config file | `test-oauth-callback.mjs`, `test-poller-live.mjs` |
| 1.1 | OAuth uses `actor=app`, so board comments come from the agent, not the user | — untested (needs a live Linear app) |
| 1.2 | Scopes are `read,write,app:assignable,app:mentionable` | — untested |
| 1.3 | The callback binds `localhost:8787` only while the flow is open | — untested |
| 1.6 | `state` is a per-run nonce and a callback that does not carry it is refused | `test-oauth-callback.mjs` |
| 1.7 | `token.json` is written mode 0600 | `test-oauth-callback.mjs` |
| 1.4 | On `AUTHENTICATION_ERROR`, the token is refreshed once and the query retried | `test-poller-live.mjs` |
| 1.5 | A refresh response is **merged** into the stored token, never replaces it | `test-poller-live.mjs` |

1.6 was a real weakness. `state` was the constant string `cycler` and the callback read only `code`,
so it was neither a nonce nor verified — while the comment beside it called it an anti-CSRF nonce.
`localhost:8787` answers a request from whatever page the browser is on for as long as the flow is
open, so an unchecked callback lets someone else's `code` be exchanged and stored: the poller then
holds a token for **their** workspace, and every issue it dispatches comes from a board they control.

1.5 is load-bearing. Linear access tokens expire in 24h (`expires_in: 86399`) and a refresh response
may omit `refresh_token`; dropping it makes the *next* refresh impossible, so the poller works for a
day and then stops with a 401 that reads like a network fault.

## Selection

| # | Assertion | Test |
|---|---|---|
| 2.1 | Issues are selected by `delegate`, never `assignee` | `test-poller-live.mjs` |
| 2.2 | Issues in a `completed` or `canceled` state are skipped | `test-poller-live.mjs` |
| 2.3 | An issue already in `processed.json` is not dispatched again | `test-poller-live.mjs` |
| 2.4 | A dispatch that **failed** is not marked processed, so it retries next poll | `test-poller-live.mjs` |

2.1 is the trap that wastes the most time: `linear-cli` exposes only `--assignee`, which changes a
different field, looks correct in the UI and dispatches nothing.

## Routing

| # | Assertion | Test |
|---|---|---|
| 3.1 | The first `workflows.<label>` entry matching a label wins, case-insensitively | `test-poller-config.mjs` |
| 3.2 | A **later** configured route is reachable, not only the first | `test-poller-config.mjs` |
| 3.3 | An issue with no matching label gets `workflows.default` | `test-poller-config.mjs` |
| 3.4 | `CYCLER_WORKFLOW` overrides all routing | `test-poller-live.mjs` |
| 3.5 | The chosen route **and the reason** appear in the dispatch comment | `test-poller-live.mjs` |

## Dispatch

| # | Assertion | Test |
|---|---|---|
| 4.1 | The command comes from `dispatch.command`, defaulting to the working invocation | `test-poller-config.mjs` |
| 4.2 | `--print` never appears; it conflicts with `--background` and exits 1 | `test-poller-config.mjs` |
| 4.3 | Placeholders are substituted **after** splitting, so no issue title can introduce an argument | `test-poller-config.mjs`, `test-poller-live.mjs` |
| 4.4 | `PATH` is prepended with `dispatch.path_prepend` before spawning | `test-poller-config.mjs` (loaded, not asserted) |
| 4.5 | The session id is parsed from the `backgrounded · <id>` line | `test-poller-live.mjs` |
| 4.6 | The working directory is `repo.path` | `test-poller-live.mjs` |
| 4.7 | A **stale** Claude credential limits the poll to one dispatch, so one process refreshes | `test-refresh-race.mjs` |
| 4.8 | A **fresh** credential restricts nothing, and an **unreadable** one restricts nothing either | `test-refresh-race.mjs` |
| 4.9 | The expiry read never throws, whatever the credential store returns | `test-refresh-race.mjs` |
| 4.10 | `poll()` spends the budget — the limit is wired in, not merely computed | `test-refresh-race.mjs` |
| 4.11 | At most `dispatch.max_concurrent` dispatched sessions run at once (default 1) | `test-concurrency.mjs` |
| 4.12 | Only **busy** sessions this poller named count; an unreadable registry restricts nothing | `test-concurrency.mjs` |
| 4.13 | A session that ended on the account usage limit holds the queue until the window resets | `test-cooldown.mjs` |
| 4.14 | Only a limit message holds it; the reset time is read from the message, capped, never negative | `test-cooldown.mjs` |

4.7 is the fix for a race, not for an expiry. The CLI's access token lives 8 hours behind a refresh
token that **rotates**: spending it invalidates it. `dispatch()` awaits only the spawn, so two due
issues produce two sessions seconds apart; against an already-stale access token both try to
refresh, one wins, and the loser presents a token that has been spent. The CLI reports that as
`OAuth session expired and could not be refreshed`, which names the wrong cause, and the session
dies on its first turn — a dispatch that spawned and then went silent. APL-74 and APL-78 died that
way three times each on 2026-09-07, every pair within three seconds.

The expiry is read from the local keychain, so 4.7 costs no network call and no inference call: the
poller still makes exactly one outbound request per poll.

4.11 exists because a dispatched session is not one agent. `/cycler:workflow-feature` runs
`task-orchestration.js`, which fans out to ~5–9 subagents on a normal run and up to ~70 in the worst
case. Two of those at once share one account-level usage pool and neither can see the other spending
it — and the budget guard inside the workflow **cannot** be armed for a dispatched run, because
`--max-budget-usd` only works with `--print` and `--print` conflicts with `--background` (4.2). So
the number of runs the poller starts is the only lever that exists. APL-74 and APL-78 went out in
the same poll on 2026-09-10 and hit the session limit together thirty minutes later, both blocked at
their audit stage with the diff unverified. Serialising costs one poll interval per issue and
nothing else: nothing is dropped, the rest go out on later polls.

4.12 is what keeps 4.11 from becoming a stall. The count comes from `claude agents --json` — a local
read of this machine's session registry, ~0.2s, no network call and no inference call, so the
one-request-per-poll claim above still holds. Only sessions named the way `dispatch()` names them
(`[APL-78] title`) count, so a human's own window never holds the queue, and only while they are
`busy`: the two sessions above sat `idle`/`blocked` for fifteen hours after hitting the limit, and a
poller that counted those would never dispatch again. An unreadable registry restricts nothing, for
the same reason as 4.8.

4.13 exists because 4.11 was not enough, and the gap is worth naming precisely. Serialising stops
two runs from racing; it does not stop them from emptying the same usage window one after the other.
On 2026-09-11 APL-78 ran **alone** for 22 minutes across 14 agents, finished, and APL-74 started
three minutes later into what was left and died at its last stage — eleven straight `holding off`
lines in the log, nothing concurrent at any point. One run of the feature workflow is 14–17 agents;
two do not fit in one window, and no amount of spacing changes that.

What changes it is not starting the second run until the window has reset, and the CLI says when
that is in the message it kills the session with: `You've hit your session limit · resets 9am
(Asia/Jerusalem)`. That message is read from `claude logs <id>` — local, no network call and no
inference call, like the other two guards — once, when a watched session stops being busy.
`running.json` exists for that one reason: `pending.json` is dropped as soon as a session proves it
STARTED, and a limit is hit hours later.

4.14 is the half that keeps 4.13 from becoming a stall. Only a limit message holds the queue, so an
ordinary failure does not; a reset that has already passed today is read as tomorrow rather than as
a hold in the past, which would be no hold at all; a message whose reset cannot be read still holds,
on `dispatch.cooldown_fallback_minutes`, because knowing the window is spent is the load-bearing
half; and every hold is capped at six hours, so a misparse cannot quietly stall the board for a day.

4.8's unreadable case is deliberate and is the half most likely to be "simplified" away. Whether
this process can read the keychain is a property of how it was started, and turning "cannot read"
into "dispatch nothing" would convert a permissions question into a silent stall — the failure mode
every other guard in the poller exists to prevent. Verified in the real path: a launchd-started
poll logs the expiry, not `credential unreadable`.

4.10 exists because every other row here stays green if `poll()` ignores what `dispatchBudget()`
returns. A correct check nothing consults is the exact shape of bug this repo keeps finding.

4.3 is a security property, not a formatting one: issue titles are attacker-influenced text in any
shared workspace. 4.4 exists because launchd hands a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so the
dispatched session cannot find `node`, `gh`, `claude` or `lin` and stalls asking a human.

## Reporting

| # | Assertion | Test |
|---|---|---|
| 5.1 | Every dispatch posts a comment with the session id, route and reason | `test-poller-live.mjs` |
| 5.2 | Every **failed** dispatch posts a comment too | `test-poller-live.mjs` |
| 5.3 | The poller writes no issue **status**; that is the workflow's ([ADR 0005](../adr/0005-status-writes-belong-to-the-workflow.md)) | `test-poller-live.mjs` |

5.2 matters because without it a failed dispatch is indistinguishable from an issue the agent never
saw — which is precisely how the `--print`/`--background` conflict hid for a week.

## State

| # | Assertion | Test |
|---|---|---|
| 6.1 | State lives in `$CYCLER_HOME`, default `~/.cycler` | `test-state-dir.mjs` |
| 6.2 | Every shipped script resolves the **same** directory | `test-state-dir.mjs` |
| 6.3 | The shell CLIs honour `CYCLER_HOME` | `test-state-dir.mjs` |

## Failure modes

| # | Assertion | Test |
|---|---|---|
| 7.1 | A comment failure **after** a successful spawn does not un-process the issue | `test-poller-live.mjs` |
| 7.2 | A missing `repo.path` fails one issue with a comment, not the whole poll in silence | `test-poller-live.mjs` |

7.1 was a real bug. `dispatch()` posted its comment before returning, and the caller marks an issue
processed only when `dispatch()` resolves — so any transient failure on `commentCreate` left a live
session running with the issue still unprocessed, and the next poll spawned a **second** session on
the same issue and the same branch, every 180s, indefinitely. 7.2 was the other half: the
`repo.path` existence check threw from outside the per-issue `try`, aborting the whole poll before
the failure comment, which is precisely the "indistinguishable from never seeing the issue" state
5.2 exists to prevent.

## Known gaps

§1.1–1.3 (the OAuth flow itself) stay untested: they need a live Linear application, not a double.
Everything else in §1, §2, §4 and §5 is now covered by `test-poller-live.mjs`, which replaces only
`fetch` and the `claude` binary and runs the shipped poller as a child process — so token load, the
delegate filter, routing, spawn and the state write are the real code paths.
