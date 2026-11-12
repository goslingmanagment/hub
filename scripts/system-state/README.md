# The Mac's reporter of «Система → Состояние»

Every 5 minutes `report.py` reads, without changing anything, what works by itself on the Mac and sends Hub one
batch of routines and one of copies (`PUT /api/v1/agent/system/routines`, `…/copies`, an agent key with
`write:system_state`):

- launchd agents: `launchctl print` (running, runs since load, last exit code); the run's time from its log's mtime,
  and Hub dates a run itself when the `runs` counter moves;
- the agent gateway's cron jobs: OpenClaw's state database opened read-only (`?mode=ro`), the latest run receipts
  of each job; the gateway is never called, restarted or reconfigured;
- the desktop app's scheduled tasks: the newest dispatch any account recorded in
  `~/Library/Application Support/Claude/claude-code-sessions/*/*/scheduled-tasks.json`. How a task ended is written
  nowhere it can be read reliably (`~/.claude/scheduled-tasks/` holds only the prompts), so they go with no result
  and Hub shows «итог не виден»;
- copies: the newest dated folder under each configured `~/Backups/<name>/`, its `manifest.json` when there is one.

What to report lives on the Mac only, `~/.config/agency/system-state.json` (titles of jobs name people: never in
this repository). `system-state.example.json` shows its shape with invented names.

```bash
python3 scripts/system-state/generate-config.py --out ~/.config/agency/system-state.json   # draft from what is installed, then review
python3 scripts/system-state/report.py --dry-run                                           # the two batches, nothing sent
python3 scripts/system-state/report.py                                                     # send (prints one JSON line)
bash scripts/system-state/install-launchd.sh                                               # every 5 minutes (--uninstall)
```

The key: `hub.credentials` in the config names an env file with `HUB_AGENT_KEY` and `HUB_BASE_URL` (a dedicated
key with only `write:system_state` is best; `--credentials`/`--hub-url` override). It is never printed.

In the review: `"skip": true` on what should not be watched; on a job whose «nothing to do» means its input is empty
(an inbox nobody forwards to), `"skipped": "empty_input"` and `"emptyThresholdSeconds"`. A routine the reporter no
longer sends is retired in Hub (kept, no longer watched).

Hub judges: silent after twice the period and 10 minutes without a run; failing after two failed runs in a row;
empty input past the threshold; a copy older than 36 hours; the reporter itself silent for 30 minutes inside the
Mac's hours (settings `SYSTEM_MAC_HOURS_FROM`/`_TO`, Moscow) — then the Mac's lines read «не проверено». Each is a
matter for the owner that closes itself.
