# Spec 002 — the cycler config

One file: **`~/.config/cycler/config.yaml`**.

Read by `lib/yaml.mjs`; exposed to bash hooks by `harness/read-config.mjs`; passed whole to the
workflow by the `/cycler:task` skill (`read-config.mjs --json`).

There used to be two — a committed `cycler.yaml` at the repo root plus `~/.cycler/config.json` for
the OAuth credentials. Splitting a config by secrecy split it by nothing else: `repo.base` and
`client_secret` are both things you type once at setup and never think about again, and every
question about cycler started with "which file?". One file, outside any repo, so the client secret is
never one `git add .` from a public history.

`~/.cycler/` still exists and holds **no config** — only state the poller writes: `token.json`,
`processed.json` and the launchd logs. A file a program rewrites every 24 hours cannot also be the
file you hand-edit.

## Location and precedence

| # | Assertion | Test |
|---|---|---|
| 1.1 | `$CYCLER_CONFIG` wins if set, even when the file does not exist | `test-yaml.mjs` |
| 1.2 | Otherwise `$XDG_CONFIG_HOME/cycler/config.yaml`, else `~/.config/cycler/config.yaml` | — untested |
| 1.3 | A missing config yields `{}`; every key falls back to its default | `test-poller-config.mjs` |
| 1.4 | A **malformed** config yields `{}` and never throws | — untested |

1.1 fails loudly rather than silently: a path given explicitly and then ignored because it does not
exist is how you debug the wrong file for an hour.

1.4 is deliberate. A poller that dies on config stops dispatching silently, which is worse than one
running on defaults and saying so in the log.

## Parsing

The parser is a documented subset, not YAML. It handles what `cycler.example.yaml` uses.

| # | Assertion | Test |
|---|---|---|
| 2.1 | Nested maps by indentation | `test-yaml.mjs` |
| 2.2 | Scalars: string, quoted string, integer, boolean, null | `test-yaml.mjs` |
| 2.3 | Inline lists `[a, b]` | `test-yaml.mjs` |
| 2.4 | Block lists `- a` | `test-yaml.mjs` |
| 2.5 | Block lists of maps `- key: value` plus indented siblings | `test-yaml.mjs` |
| 2.6 | Folded block scalars `>` — lines joined with spaces | `test-yaml.mjs` |
| 2.7 | Literal block scalars `\|` — newlines preserved | `test-yaml.mjs` |
| 2.8 | A key following a block scalar is not swallowed | `test-yaml.mjs` |
| 2.9 | **The shipped example parses into usable values** | `test-yaml.mjs` |
| 2.10 | A key resolves in snake_case, camelCase **or** kebab-case | `test-yaml.mjs` |
| 2.11 | An exact match wins over a folded one, and an absent key stays absent | `test-yaml.mjs` |

2.9 is the assertion that earns its place. Before it existed, `>` was unsupported, so
`dispatch.command` in the shipped example parsed as the literal `">"` — every user copying the
example unchanged would have had the poller try to spawn a process named `>`. Five unit cases were
green at the time. Parse the artefact you ship.

2.10 exists because the keys renamed to snake_case in the same release that merged the two files. A
key spelled the old way must not read as *absent*: `dispatch.pathPrepend` silently unread means a
dispatched session running on launchd's bare `PATH`, which stalls asking a human where `node` is.
2.11 is the other direction — a lookup that returned the first value for everything would pass 2.10
on its own.

Anything outside this subset — anchors, multi-document files, flow maps, tags — is unsupported. A
config that needs them has outgrown being config.

## Keys

Canonically snake_case. Every key is optional and the default is the value that works; the example
file ships only the sections worth setting.

### `linear` — the OAuth application

| key | default | meaning |
|---|---|---|
| `linear.client_id` | none | Client ID of the Linear application named `Claude` |
| `linear.client_secret` | none | its Client secret |

Both come from Linear → Settings → API → Applications. **Required in practice**: without them the
poller can authorise once but cannot refresh, so it works for 24 hours and then stops with a 401 that
reads like a network fault.

An OAuth *application*, not a personal API key. A personal key authenticates as **you**, and the
poller selects issues by `delegate` — a field that holds an agent. The app is what puts the name
"Claude" on the board (`actor=app`) and what the delegate filter matches. A personal key would need a
different trigger entirely.

### `repo` — where sessions run

| key | default | meaning |
|---|---|---|
| `repo.path` | `~/your-repo` | where dispatched sessions are started; `~` is expanded |
| `repo.base` | `main` | PR base branch |
| `repo.branch_prefix` | `claude/` | branches are `<prefix><ISSUE-KEY>` |

`repo.path` is the one key with no useful default — the placeholder exists so a missing config
degrades to a comment on the issue rather than a silent stall. `REPO_PATH` overrides it.

### `workflows` — routing

| key | default | meaning |
|---|---|---|
| `workflows.default` | `/cycler:task` | the workflow for an issue with no matching label |
| `workflows.<label>` | `research: /cycler:research` | a Linear label, mapped to the workflow it dispatches |

`default` is the only reserved key; every other key **is** a Linear label, matched
case-insensitively, first match in file order winning. Setting any label key replaces the built-in
`research` route rather than adding to it — so a config with `workflows` but no `research:` line has
no research route, which is the point of writing it out.

This replaced `routes.default` plus a `routes.byLabel` list of `{label, workflow, why}` — three keys
and a nesting level to say what `research: /cycler:research` says on one line. The `why` field went
with it; the dispatch comment now reports the reason as the label that matched, which is the same
information and cannot go stale against the route beside it.

### `dispatch` — the command

| key | default | meaning |
|---|---|---|
| `dispatch.command` | the working `claude --background` invocation | template: `{workflow} {issue} {title} {url} {session}` |
| `dispatch.path_prepend` | `~/.local/bin ~/bin /opt/homebrew/bin /usr/local/bin` | prepended to the child's `PATH` |
| `dispatch.start_grace_seconds` | `300` | how long a session has to post its start marker before it is declared dead |
| `dispatch.max_attempts` | `3` | how many times one issue is re-dispatched before the poller gives up and says so |

The template is split like a shell would but **without** a shell, and placeholders are substituted
*after* the split — so an issue title can never introduce an argument. `--print` must never appear:
it conflicts with `--background`, `claude` exits 1, and it looks exactly like the agent never saw the
issue. `CLAUDE_BIN` overrides `argv[0]`, because launchd needs an absolute path and that is a machine
fact rather than a project one.

Spawning a session is not the same as the session running: `claude --background` returns an id
immediately and a session can still die on its first turn — an expired login does exactly that, in
under a second, and from the board that is indistinguishable from a healthy run that has not
commented yet. `start_grace_seconds` is the window; below the time your first skill step actually
takes, healthy runs are declared dead and duplicated. `max_attempts` bounds the retry so a
permanently broken dispatch cannot loop.

`path_prepend` exists because launchd hands a job `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and the
spawned session inherits it. An interactive session never sees this, which is why it only shows up
once dispatch is automated.

### `verify` — checks the gate leaves out

| key | default | meaning |
|---|---|---|
| `verify.steps[]` | none | `{when, run, notes?}` — `when` is the path prefix that makes the step apply |

Omit the section and the verify agent is told about no extra steps at all. `notes` matters as much as
`run`: the case this replaced needed "there is no such scheme, it is a test target" to avoid a
run-killing typo.

### `worktree` — what a fresh worktree needs

| key | default | meaning |
|---|---|---|
| `worktree.link_workspace` | `false` | give the worktree a real `node_modules` whose workspace packages point at **it** |
| `worktree.bootstrap` | none | one advisory command a fresh worktree needs before anything can build |

Only an npm-workspace repo needs `link_workspace`, and only that repo knows it is one. Unset, a
worktree gets no `node_modules` step at all — correct for a Go, Python or Rust repo. Sharing the main
checkout's `node_modules` instead makes the worktree compile its own `src/` against the **main**
checkout's copy of every workspace package; three issues each lost a fix round to it.

`bootstrap` is advisory by design — a failure is reported and the run continues, because a diff that
never touches that toolchain must not be blocked by it.

### `escape_hatch` — inline vs the full workflow

| key | default | meaning |
|---|---|---|
| `escape_hatch.max_files` | `8` | past this many contract files, run the full workflow, not inline |
| `escape_hatch.paths[]` | none | path prefixes expensive enough to work inline that they always take the workflow |

One driver session carrying a large change grows its context monotonically and re-reads every earlier
tool result. APL-41 ran inline past this limit: 331 turns, $8.68, context peaking at 216k, 61% of it
in cache reads.

### `launchd` — the polling job

| key | default | meaning |
|---|---|---|
| `launchd.label` | `dev.cycler.linear` | job label **and** plist filename |

`launchctl` addresses jobs by **label**, so the two must match; every cycler command derives the
filename from this one value so they cannot drift.

## Behaviour of each key

| # | Assertion | Test |
|---|---|---|
| 3.1 | `linear.client_id` / `client_secret` drive the OAuth authorise flow | `test-oauth-callback.mjs` |
| 3.2 | The same two keys drive the 24h token refresh | `test-poller-live.mjs` |
| 3.3 | `verify.steps` reach the verify prompt; absent, nothing is added | `test-repo-specifics-are-config.mjs` |
| 3.4 | A step's `notes` reach the prompt with its `run` | `test-repo-specifics-are-config.mjs` |
| 3.5 | `worktree.link_workspace` unset ⇒ no linking step at all | `test-repo-specifics-are-config.mjs` |
| 3.6 | `worktree.link_workspace: true` ⇒ the step, **with** its prohibition | `test-repo-specifics-are-config.mjs` |
| 3.7 | `worktree.bootstrap` appears only when set, and is described as advisory | `test-repo-specifics-are-config.mjs` |
| 3.8 | `escape_hatch.paths` blocks a matching one-file contract | `test-escape-hatch-hook.mjs` |
| 3.9 | The **same** contract is allowed when `escape_hatch.paths` does not list it | `test-escape-hatch-hook.mjs` |
| 3.10 | `escape_hatch.max_files` bounds the contract's file count | `test-escape-hatch-hook.mjs` |
| 3.11 | A configured `workflows.<label>` route is dispatched, and a later one is reachable | `test-poller-config.mjs` |
| 3.12 | An unlabelled issue gets `workflows.default` | `test-poller-config.mjs` |
| 3.13 | `launchd.label` names both the job and its plist | — untested (commands are prose) |
| 3.14 | `dispatch.max_attempts` bounds the retries, and the default still retries | `test-dispatch-liveness.mjs` |
| 3.15 | `dispatch.start_grace_seconds` widens the window; the same record then goes unjudged | `test-dispatch-liveness.mjs` |
| 3.16 | The command set is exactly `start` / `stop` / `issue` / `doctor`, both directions | `test-command-names.mjs` |

Every conditional key is asserted in **both** directions. A test that only checks the configured case
passes against a hardcoded implementation; one that only checks the unconfigured case passes against
a feature that was deleted.

Writing this table is what surfaced a `linear.mode` key that the example documented and nothing
implemented. It has been removed. A config key that does nothing is worse than no key: it is a
promise the code does not keep.
