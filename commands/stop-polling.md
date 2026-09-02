---
description: Unload and remove the launchd polling job.
---

```bash
launchctl unload ~/Library/LaunchAgents/dev.cycler.linear.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/dev.cycler.linear.plist
launchctl list | grep dev.cycler.linear || echo "stopped"
```

Confirm the grep found nothing. Leave `~/.cycler/` alone — the token and the processed-issue list
belong to the user, and deleting them means re-authorising and re-dispatching every issue that was
already handled.
