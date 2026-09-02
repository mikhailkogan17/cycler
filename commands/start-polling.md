---
description: Install and load the launchd job that polls Linear every 180 seconds.
---

Install the poller as a launchd agent so delegated issues are picked up without anyone watching.

## Preconditions

Refuse to continue, with the reason, if either is missing:
- `~/.cycler/token.json` exists (else: run `/cycler:setup`)
- `cycler.yaml` exists at the repo root, or `~/.cycler/cycler.yaml` does

## Write the plist

Resolve absolute paths first — **launchd has a minimal PATH and will not find these by name**:

```bash
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude)"
REPO="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" repo.path "$PWD")"
```

Write `~/Library/LaunchAgents/dev.cycler.linear.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.cycler.linear</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE_BIN</string>
    <string>PLUGIN_ROOT/poller/poller.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_BIN</key><string>CLAUDE_BIN</string>
    <key>REPO_PATH</key><string>REPO</string>
    <key>CLAUDE_PROJECT_DIR</key><string>REPO</string>
  </dict>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>HOME/.cycler/poller.log</string>
  <key>StandardErrorPath</key><string>HOME/.cycler/poller.err</string>
</dict>
</plist>
```

Substitute the real values for `NODE_BIN`, `CLAUDE_BIN`, `PLUGIN_ROOT`, `REPO` and `HOME`.

**The `Label` is `dev.cycler.linear` and it is NOT the filename.** `launchctl` addresses jobs by
label; a mismatch fails with a 501 that reads like "not running" and costs an hour.

## Load it

```bash
mkdir -p ~/.cycler
launchctl unload ~/Library/LaunchAgents/dev.cycler.linear.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/dev.cycler.linear.plist
launchctl list | grep dev.cycler.linear
```

`RunAtLoad` means it polls immediately. Confirm with:

```bash
sleep 5 && tail -3 ~/.cycler/poller.log
```

Report the last `poll ok` line. If the log is empty or shows an error, say so — do not report success
because the job loaded. A loaded job that fails every poll looks identical to a working one from
`launchctl list`.
