# Dashboard rebuild (decision #112)

The owner console is being rebuilt from scratch; the current `apps/dashboard`
is deprecated and serves until the replacement reaches parity, then dies.

- **Launch prompt for the build session:** `../prompts/prompt-dashboard-rebuild.md`
  (process, hard constraints, verified ground truth, repo mechanics).
- **PRD:** `prd.md` in this directory — the skeleton is pre-seeded; the build
  session fills it and STOPS for owner review before writing code.
- Work branches: `kernel/dashboard-rebuild-*`.
