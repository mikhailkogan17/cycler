# Spec 002 — `cycler.yaml`

Read by `lib/yaml.mjs`; exposed to bash hooks by `harness/read-config.mjs`.

## Location and precedence

| # | Assertion | Test |
|---|---|---|
| 1.1 | `$CYCLER_CONFIG` wins if set | `test-yaml.mjs` |
| 1.2 | Otherwise `$CLAUDE_PROJECT_DIR/cycler.yaml`, else `$CYCLER_HOME/cycler.yaml` | — untested |
| 1.3 | A missing config yields `{}`; every key falls back to its default | `test-poller-config.mjs` |
| 1.4 | A **malformed** config yields `{}` and never throws | — untested |

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

2.9 is the assertion that earns its place. Before it existed, `>` was unsupported, so
`dispatch.command` in the shipped example parsed as the literal `">"` — every user copying the
example unchanged would have had the poller try to spawn a process named `>`. Five unit cases were
green at the time. Parse the artefact you ship.

Anything outside this subset — anchors, multi-document files, flow maps, tags — is unsupported. A
config that needs them has outgrown being config.

## Keys

| key | default | meaning |
|---|---|---|
| `repo.path` | `~/your-repo` | where sessions are started |
| `repo.base` | `main` | PR base branch |
| `repo.branchPrefix` | `claude/` | branches are `<prefix><ISSUE-KEY>` |
| `routes.default` | `/cycler:task` | workflow when no label matches |
| `routes.byLabel[]` | `research → /cycler:research` | `{label, workflow, why?}` |
| `dispatch.command` | the working `claude --background` invocation | template: `{workflow} {issue} {title} {url} {session}` |
| `dispatch.pathPrepend` | `~/.local/bin ~/bin /opt/homebrew/bin /usr/local/bin` | prepended to the child's `PATH` |
| `verify.steps[]` | none | `{when, run, notes?}` — checks the gate leaves out |
| `worktree.linkWorkspace` | `false` | npm-workspace `node_modules` linking |
| `worktree.bootstrap` | none | one advisory command a fresh worktree needs |
| `escapeHatch.maxFiles` | `8` | past this, run the full workflow, not inline |
| `escapeHatch.paths[]` | none | paths expensive to work inline |
| `launchd.label` | `dev.cycler.linear` | job label **and** plist filename |

## Behaviour of each key

| # | Assertion | Test |
|---|---|---|
| 3.1 | `verify.steps` reach the verify prompt; absent, nothing is added | `test-repo-specifics-are-config.mjs` |
| 3.2 | A step's `notes` reach the prompt with its `run` | `test-repo-specifics-are-config.mjs` |
| 3.3 | `worktree.linkWorkspace` unset ⇒ no linking step at all | `test-repo-specifics-are-config.mjs` |
| 3.4 | `worktree.linkWorkspace: true` ⇒ the step, **with** its prohibition | `test-repo-specifics-are-config.mjs` |
| 3.5 | `worktree.bootstrap` appears only when set, and is described as advisory | `test-repo-specifics-are-config.mjs` |
| 3.6 | `escapeHatch.paths` blocks a matching one-file contract | `test-escape-hatch-hook.mjs` |
| 3.7 | The **same** contract is allowed when `escapeHatch.paths` does not list it | `test-escape-hatch-hook.mjs` |
| 3.8 | `escapeHatch.maxFiles` bounds the contract's file count | `test-escape-hatch-hook.mjs` |
| 3.9 | `launchd.label` names both the job and its plist | — untested (commands are prose) |

Every conditional key is asserted in **both** directions. A test that only checks the configured case
passes against a hardcoded implementation; one that only checks the unconfigured case passes against
a feature that was deleted.

Writing this table is what surfaced a `linear.mode` key that the example documented and nothing
implemented. It has been removed. A config key that does nothing is worse than no key: it is a
promise the code does not keep.
