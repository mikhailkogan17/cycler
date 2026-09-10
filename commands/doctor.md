---
description: Diagnose a cycler install — config, token, launchd job, paths, repo, workflow, routes, gate and leftovers.
---

Run every check below and report each as OK or the specific failure. Do not stop at the first
failure; a partial diagnosis sends people to fix the wrong thing.

These are the nine things that have actually broken, not a generic checklist.

## 0. The config file

```bash
node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/yaml.mjs').then(m=>console.log(m.configPath()||'NONE'))"
```

There is exactly one, `~/.config/cycler/config.yaml`, and everything else here reads from it. `NONE`
means every value below is a default — `repo.path` is `~/your-repo`, and the poller has no
credentials to refresh a token with. Report which file was found, by path.

Also check the credentials parse out of it — an empty value here is a poller that works until the
first token expiry and then stops:

```bash
node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" linear.client_id MISSING
node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" linear.client_secret MISSING
```

Report whether each is present. **Do not print the secret** — say `present` or `MISSING`.

## 1. Token — the 24h cliff

```bash
node -e "const t=require(require('os').homedir()+'/.cycler/token.json');console.log(Object.keys(t).join(','))"
```

`access_token` AND `refresh_token` must both be present. Access tokens last ~24h; **without the
refresh token the poller stops dispatching a day after setup and the symptom is a 401 that reads
like a network fault.** If `refresh_token` is missing, re-run `/cycler:start`.

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

Must resolve to a git repo.

## 5. The workflow is installed in the repo

```bash
ls -l "$REPO/.claude/workflows/task-orchestration.js"
```

Must exist. The `Workflow` tool refuses a script it cannot already read, so a plugin path does not
work and this copy is what makes the escape hatch reachable. Missing it means a run told to use the
full workflow has no way to comply — and the one time that happened, the run waived the guard.

If it is missing, `/cycler:start` step 4 installs it. Also compare it with the plugin's copy and say
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

## 7. Every configured route names a workflow that exists

```bash
node -e '
  const { readdirSync } = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const cfg = JSON.parse(execFileSync("node", [root + "/harness/read-config.mjs", "--json"], { encoding: "utf8" }) || "{}");
  const have = new Set(readdirSync(root + "/skills"));
  const routes = Object.entries(cfg.workflows || {}).filter(([, v]) => typeof v === "string");
  if (!routes.length) { console.log("routes:   none configured — the built-in defaults apply"); process.exit(0) }
  for (const [label, wf] of routes) {
    const name = wf.replace(/^\/cycler:/, "");
    console.log((have.has(name) ? "OK    " : "STALE ") + "  " + label + ": " + wf);
  }
'
```

Every route must print `OK`. A route naming a workflow that does not exist dispatches a slash command
with nothing behind it: the session starts, finds no skill, and improvises — the board shows a run,
and nobody learns the route was dead.

This is the check the `workflow-` rename needed and did not have. The `task`, `research` and
`intake` skills became `workflow-feature`, `workflow-research` and `workflow-intake` in 0.2.0, and a
config written before that upgrade still routes to the old names. **An installed plugin is pinned to
its version**, so until the version string changes the old skills are still on disk and the stale
route resolves anyway — it breaks on the upgrade, not on the config edit that caused it. If a route
is stale, say which line of the config to change, and to what.

## 8. A leftover repo-local config

```bash
node -e '
  const { existsSync, readFileSync } = require("node:fs");
  const { execFileSync } = require("node:child_process");
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const repo = process.argv[1];
  const found = ["cycler.yaml", "cycler.yml", ".cycler.yaml"]
    .map((n) => repo + "/" + n).filter(existsSync);
  if (!found.length) { console.log("repo config: none — the one config is the only config"); process.exit(0) }
  const live = JSON.parse(execFileSync("node", [root + "/harness/read-config.mjs", "--json"], { encoding: "utf8" }) || "{}");
  for (const f of found) {
    const src = readFileSync(f, "utf8");
    const keys = [...src.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
    const stranded = [...new Set(keys)].filter((k) => live[k] === undefined);
    console.log("LEFTOVER  " + f + " — read by nothing");
    console.log("          keys: " + [...new Set(keys)].join(", "));
    if (stranded.length) console.log("          MISSING from the live config: " + stranded.join(", "));
    for (const [pat, was] of [[/^routes:/m, "routes: (now workflows:)"], [/\/cycler:(task|research|intake)\b/, "a 0.2.0 workflow name"], [/^\s*mode:/m, "linear.mode (removed; it did nothing)"]])
      if (pat.test(src)) console.log("          pre-migration marker: " + was);
  }
' "$REPO"
```

There is **one** config and it is `~/.config/cycler/config.yaml` ([spec 002](../docs/specs/002-config.md)).
A `cycler.yaml` at a repo root is what that file replaced, and nothing has read one since. It is the
worst kind of stale: it looks authoritative, it is version-controlled, and every key in it is
silently a default at runtime.

Report the stranded keys by name and say they are not in effect. `worktree.link_workspace` is the
one with teeth — without it a worktree compiles its own `src/` against the **main** checkout's copy
of every workspace package, and an export added in the worktree appears not to exist. Three issues
each lost a fix round to that before anyone noticed the config was not being read.

The fix is to move the keys into the live config and delete the file. Say both, in that order — a
delete that loses `verify.steps` costs more than the stale file did.

## Report

One line per check. End with a single sentence saying whether the loop is currently able to run.
