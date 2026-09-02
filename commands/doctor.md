---
description: Diagnose a cycler install — token, launchd job, paths, gate, and the delegate trap.
---

Run every check below and report each as OK or the specific failure. Do not stop at the first
failure; a partial diagnosis sends people to fix the wrong thing.

These are the six things that have actually broken, not a generic checklist.

## 1. Token — the 24h cliff

```bash
node -e "const t=require(require('os').homedir()+'/.cycler/token.json');console.log(Object.keys(t).join(','))"
```

`access_token` AND `refresh_token` must both be present. Access tokens last ~24h; **without the
refresh token the poller stops dispatching a day after setup and the symptom is a 401 that reads
like a network fault.** If `refresh_token` is missing, re-run `/cycler:setup`.

## 2. launchd label vs filename

```bash
LABEL="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" launchd.label dev.cycler.linear)"
PLIST=~/Library/LaunchAgents/"$LABEL".plist
```

The plist is named after the label on purpose. `launchctl` addresses jobs by **label**, and a label
that does not match what you loaded fails with a 501 that reads like "not running".

```bash
launchctl list | grep "$LABEL"
/usr/libexec/PlistBuddy -c "Print :Label" "$PLIST"
```

The printed `Label` must equal `$LABEL`. `launchctl` addresses jobs by **label, not filename**; a
mismatch fails with a 501 that reads like "not running". Report the configured label by name, so a
user who changed `launchd.label` can see which job was actually checked.

## 3. Absolute binaries

```bash
/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$PLIST"
/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CLAUDE_BIN" "$PLIST"
```

Both must be absolute paths that exist and are executable. launchd's PATH is
`/usr/bin:/bin:/usr/sbin:/sbin` — a bare `node` or `claude` is not found.

## 4. Repo

```bash
REPO="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.path "$PWD")"
git -C "$REPO" rev-parse --show-toplevel
```

Must resolve to a git repo. Also confirm `cycler.yaml` is found:

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/yaml.mjs').then(m=>console.log(m.configPath()||'NONE'))"
```

## 5. The workflow is installed in the repo

```bash
ls -l "$REPO/.claude/workflows/task-orchestration.js"
```

Must exist. The `Workflow` tool refuses a script it cannot already read, so a plugin path does not
work and this copy is what makes the escape hatch reachable. Missing it means a run told to use the
full workflow has no way to comply — and the one time that happened, the run waived the guard.

If it is missing, `/cycler:setup` step 4 installs it. Also compare it with the plugin's copy and say
if they differ: a stale copy is a workflow that silently is not the one you upgraded.

```bash
diff -q "$REPO/.claude/workflows/task-orchestration.js" \
        "${CLAUDE_PLUGIN_ROOT}/workflows/task-orchestration.js" && echo "in sync" || echo "DIFFERS"
```

## 6. Which gate resolves

```bash
bash "${CLAUDE_PLUGIN_ROOT}/harness/gate.sh" --fast 2>&1 >/dev/null | head -1
```

Report the repo's own gate or cycler's default **by name**. A repo with real checks that is silently
running the default gate is passing on less than the user thinks.

## 7. The delegate trap

Compare what is assigned to the agent against what is delegated to it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/poller/poller.mjs" 2>&1 | tail -1
```

`poll ok: N delegated, M processed` — if `N` is 0 while the user believes issues are queued, they
almost certainly **assigned** rather than **delegated**. `lin issue update --assignee` is the wrong
field and dispatches nothing while looking correct. Point them at `/cycler:start <KEY>`.

## Report

One line per check. End with a single sentence saying whether the loop is currently able to run.
