# Reproducible Cycler demo

`./demo/run.sh` is the single entry point. `./demo/run.sh --dry-run` prints its plan with no API writes, local checkout changes or model work.

## Prerequisites

- macOS, Node, npm, Git, GitHub CLI (`gh`) authenticated as the owner of a public `cycler-demo` repository, and the existing `linear` CLI authentication (`linear auth whoami`). The script does not create or copy an API token.
- Claude Code with the Cycler plugin, plus `asciinema`, `agg`, `ffmpeg`/`ffprobe` **with `drawtext` enabled**, `gifski`, and Playwright Chromium (`cd demo && npm ci && npx playwright install chromium`). `demo/` has its own lockfile; root dependencies are untouched.
- The complete Cycler update must have passed its tests and independent review before a live run. The Applygent delivery automation remains paused until then. Set `DEMO_CYCLER_VERIFIED=1` only after that verification.
- A separate Cycler config YAML for the disposable sandbox. Set `DEMO_CYCLER_CONFIG` to its path. Its `repo.path` must equal the generated `demo/.work/sandbox` checkout and `repo.branch_prefix` must be `cycler/`. Keep this config outside Git. It uses the existing OAuth app credentials and model subscription; do not paste tokens into the repository.
- `DEMO_STORAGE_STATE`: Playwright storage state JSON for an already signed-in browser session. Keep it outside Git. The capture hides avatars and email addresses before screenshots.
- `DEMO_SESSION_LOG`: path to the existing Cycler session output log for this sandbox run. The runner only tails it; it does not start or restart the poller.
- Cap Desktop is the default raw screen recorder. Grant **Screen Recording** permission to Cap in macOS System Settings once; `cap doctor --json` must report `captureReady: true`. Set `DEMO_CAP_WINDOW` to the ID of a dedicated terminal window from `/Applications/Cap.app/Contents/MacOS/cap-cli targets windows --json`. Cap records and exports to temporary `cap-raw.mp4`; the published montage uses the separately redacted asciinema and Playwright frames. Set `DEMO_CAPTURE=asciinema` only if Cap capture is deliberately disabled.

Required environment variables: `DEMO_TEAM` (Linear team key), `DEMO_GH_OWNER`, `DEMO_CYCLER_CONFIG`, `DEMO_STORAGE_STATE`, `DEMO_SESSION_LOG`, `DEMO_CAP_WINDOW`, and `DEMO_CYCLER_VERIFIED=1`. Optional: `DEMO_KEEP=1` keeps the issue/PR/sandbox for inspection; `DEMO_FONT` selects another Inter or SF font file; `DEMO_CAPTURE=asciinema` skips Cap.

```bash
demo/run.sh --dry-run
demo/run.sh
```

The run records `created`, `delegated`, `in_progress`, `contract_written`, `gate_passed`, `pr_opened`, and `review_done` in `demo/out/events.jsonl`. Only a fully captured, reviewed and gated run replaces `demo/out/cycler-demo.gif` and `demo/out/cycler-demo.mp4`. The GIF target is 25–35 seconds, 960 pixels wide, at most 8 MB. The MP4 target is 60–90 seconds at 1920×1080. The end card uses actual elapsed minutes from the event log. Cap supplies a temporary raw screen recording; the terminal cast is redacted and passed through `agg`, while web frames come from headless Chromium at 1440×900 in light mode.

The run also copies the validated GIF to `docs/assets/cycler-demo.gif` for the demo PR. To make the README's release link live, upload the final MP4 to the current Cycler GitHub release as `cycler-demo.mp4` after two successful consecutive runs and independent exact-head review.

## Cleanup

Normally the `EXIT` trap archives every issue in `DEMO_TEAM` carrying a `demo-run-*` label and resets only the proven public `DEMO_GH_OWNER/cycler-demo` repository: close its open PRs, delete its `cycler/*` branches, force-push `demo-base` to its `main`. To keep the run for inspection: `DEMO_KEEP=1 demo/run.sh`. To clean that up later, set the same environment variables and run `cd demo && node --import tsx cleanup.ts && sandbox/setup-sandbox.sh`.

`linear-cli` 2.5.0 has no issue archive command. With the user's explicit approval, cleanup uses `linear api` for the `issueArchive` mutation after checking the issue's team key and exact demo label. It does not delete issues.

## Known failures

- Missing `linear auth`, browser state, or Cycler update receipt fails before dispatch. `--dry-run` still works.
- Wrong Cycler config path or branch prefix fails before creating the issue, preventing dispatch into a real project.
- Missing session log, contract proof, green gate marker, open PR, or completed review fails after 30 minutes. Published output stays untouched; diagnostics remain in the printed temporary directory.
- `asciinema`/`agg`/`gifski` are external tools; missing binaries or an over-limit GIF fail the run.
- The sandbox reset is destructive **only** inside the identity-checked public `OWNER/cycler-demo` repo. It never touches other repositories.
