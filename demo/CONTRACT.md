# Demo pipeline contract

Source: user request in this session, 2026-11-19. This contract is frozen before implementation.

## Scope

- Only new files under `demo/` and the `<!-- DEMO: 2-min video/GIF -->` block in root `README.md` may change.
- The sandbox setup may mutate only the explicitly named public `cycler-demo` GitHub repository. It must prove the owner/name before closing PRs, force pushing `demo-base` to `main`, or deleting `cycler/*` branches.
- One `demo/run.sh` command creates a real Linear issue, delegates it, waits for a gated open PR, captures the run, renders 25–35 second GIF (at most 8 MB) and 60–90 second 1080p MP4, then cleans up the demo issue/repository unless `DEMO_KEEP=1`.
- Dry run is read-only and prints the execution plan.
- A failed run leaves published output files untouched. Temporary capture files stay outside `demo/out` until all evidence and media checks pass.
- Do not start or restart Cycler delivery until the existing Cycler update has passed full verification, per the user's explicit hold.

## Verification

- Shell and TypeScript syntax, dry run without writes, deterministic unit checks for event/render decisions, and manual artifact inspection.
- Two consecutive live runs after the Cycler activation hold is lifted, both leaving no open demo issues or PRs.
- Independent read-only review on the exact branch head before PR is considered ready. Never merge the PR.

## Evidence rules

- Only report real event times, actual artifact size/duration and real PR URL.
- Missing gate proof, missing PR, stale head, or capture failure is failure, never a green demo.
- No secrets or Playwright storage state in commits, logs, or media.
