---
description: Unload and remove the launchd polling job.
---

```bash
LABEL="$(node "${CLAUDE_PLUGIN_ROOT}/harness/read-config.mjs" launchd.label dev.cycler.linear)"
PLIST=~/Library/LaunchAgents/"$LABEL".plist
```

The plist is named after the label on purpose. `launchctl` addresses jobs by **label**, and a label
that does not match what you loaded fails with a 501 that reads like "not running".

```bash
launchctl unload "$PLIST" 2>/dev/null
rm -f "$PLIST"
launchctl list | grep "$LABEL" || echo "stopped"
```

Confirm the grep found nothing. Leave `~/.cycler/` alone — the token and the processed-issue list
belong to the user, and deleting them means re-authorising and re-dispatching every issue that was
already handled.
