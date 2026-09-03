# Spec 001 — the poller

`poller/poller.mjs`. Runs under launchd every 180s. Never calls a model.

## Authentication

| # | Assertion | Test |
|---|---|---|
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
| 3.1 | The first `routes.byLabel` entry matching a label wins, case-insensitively | `test-poller-config.mjs` |
| 3.2 | A **later** configured route is reachable, not only the first | `test-poller-config.mjs` |
| 3.3 | An issue with no matching label gets `routes.default` | `test-poller-config.mjs` |
| 3.4 | `CYCLER_WORKFLOW` overrides all routing | `test-poller-live.mjs` |
| 3.5 | The chosen route **and the reason** appear in the dispatch comment | `test-poller-live.mjs` |

## Dispatch

| # | Assertion | Test |
|---|---|---|
| 4.1 | The command comes from `dispatch.command`, defaulting to the working invocation | `test-poller-config.mjs` |
| 4.2 | `--print` never appears; it conflicts with `--background` and exits 1 | `test-poller-config.mjs` |
| 4.3 | Placeholders are substituted **after** splitting, so no issue title can introduce an argument | `test-poller-config.mjs`, `test-poller-live.mjs` |
| 4.4 | `PATH` is prepended with `dispatch.pathPrepend` before spawning | `test-poller-config.mjs` (loaded, not asserted) |
| 4.5 | The session id is parsed from the `backgrounded · <id>` line | `test-poller-live.mjs` |
| 4.6 | The working directory is `repo.path` | `test-poller-live.mjs` |

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
