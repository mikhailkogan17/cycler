# Spec 001 — the poller

`poller/poller.mjs`. Runs under launchd every 180s. Never calls a model.

## Authentication

| # | Assertion | Test |
|---|---|---|
| 1.1 | OAuth uses `actor=app`, so board comments come from the agent, not the user | — untested (needs a live Linear app) |
| 1.2 | Scopes are `read,write,app:assignable,app:mentionable` | — untested |
| 1.3 | The callback binds `localhost:8787` only while the flow is open | — untested |
| 1.4 | On `AUTHENTICATION_ERROR`, the token is refreshed once and the query retried | — untested |
| 1.5 | A refresh response is **merged** into the stored token, never replaces it | — untested |

1.5 is load-bearing. Linear access tokens expire in 24h (`expires_in: 86399`) and a refresh response
may omit `refresh_token`; dropping it makes the *next* refresh impossible, so the poller works for a
day and then stops with a 401 that reads like a network fault.

## Selection

| # | Assertion | Test |
|---|---|---|
| 2.1 | Issues are selected by `delegate`, never `assignee` | — untested |
| 2.2 | Issues in a `completed` or `canceled` state are skipped | — untested |
| 2.3 | An issue already in `processed.json` is not dispatched again | — untested |
| 2.4 | A dispatch that **failed** is not marked processed, so it retries next poll | — untested |

2.1 is the trap that wastes the most time: `linear-cli` exposes only `--assignee`, which changes a
different field, looks correct in the UI and dispatches nothing.

## Routing

| # | Assertion | Test |
|---|---|---|
| 3.1 | The first `routes.byLabel` entry matching a label wins, case-insensitively | `test-poller-config.mjs` |
| 3.2 | A **later** configured route is reachable, not only the first | `test-poller-config.mjs` |
| 3.3 | An issue with no matching label gets `routes.default` | `test-poller-config.mjs` |
| 3.4 | `CYCLER_WORKFLOW` overrides all routing | — untested |
| 3.5 | The chosen route **and the reason** appear in the dispatch comment | — untested |

## Dispatch

| # | Assertion | Test |
|---|---|---|
| 4.1 | The command comes from `dispatch.command`, defaulting to the working invocation | `test-poller-config.mjs` |
| 4.2 | `--print` never appears; it conflicts with `--background` and exits 1 | `test-poller-config.mjs` |
| 4.3 | Placeholders are substituted **after** splitting, so no issue title can introduce an argument | `test-poller-config.mjs` |
| 4.4 | `PATH` is prepended with `dispatch.pathPrepend` before spawning | `test-poller-config.mjs` (loaded, not asserted) |
| 4.5 | The session id is parsed from the `backgrounded · <id>` line | — untested |
| 4.6 | The working directory is `repo.path` | — untested |

4.3 is a security property, not a formatting one: issue titles are attacker-influenced text in any
shared workspace. 4.4 exists because launchd hands a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so the
dispatched session cannot find `node`, `gh`, `claude` or `lin` and stalls asking a human.

## Reporting

| # | Assertion | Test |
|---|---|---|
| 5.1 | Every dispatch posts a comment with the session id, route and reason | — untested |
| 5.2 | Every **failed** dispatch posts a comment too | — untested |
| 5.3 | The poller writes no issue **status**; that is the workflow's ([ADR 0005](../adr/0005-status-writes-belong-to-the-workflow.md)) | — untested |

5.2 matters because without it a failed dispatch is indistinguishable from an issue the agent never
saw — which is precisely how the `--print`/`--background` conflict hid for a week.

## State

| # | Assertion | Test |
|---|---|---|
| 6.1 | State lives in `$CYCLER_HOME`, default `~/.cycler` | `test-state-dir.mjs` |
| 6.2 | Every shipped script resolves the **same** directory | `test-state-dir.mjs` |
| 6.3 | The shell CLIs honour `CYCLER_HOME` | `test-state-dir.mjs` |

## Known gaps

Most of §1, §2, §4 and §5 is untested: it needs a Linear API double, which does not exist yet. This
is the largest gap in the repo and the honest reason to be cautious about the poller half — the
bugs found in it so far were all found by running it, not by the suite.
