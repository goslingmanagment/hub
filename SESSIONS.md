# Session runbook — core

Principles: **one session = one repo** (core edits from a client session are
allowed when the work genuinely needs both sides — commit each repo
separately); **every prompt is restartable** — a session that dies mid-task is
resumed by a fresh session reading the same prompt, the execution log, and the
code. Prompts state goals, hard constraints, and done-criteria — not steps.

## The harnesses

| Prompt | Use |
|---|---|
| `docs/project-kernel/prompts/prompt-4-stage-execution.md` | The (historical) stage-execution harness that ran the 35-stage migration — parameterized `STAGE=NN`; keep for reference and for any remaining stage tails |
| `~/code/workboard` (no prompt file) | Stage 34 standalone-workboard design pass (reopened by #119) — open a fresh session there; its CLAUDE.md + `docs/prd.md` skeleton are the brief. Fills the PRD, STOPS for owner review before any code |
| `docs/prompts/` (map prompts) | Regenerate `docs/generated/` maps after substantive changes |

## Standing rules for any core session

- Green-local before deploy; deploys/prod access are owner-gated with a
  structured confirmation per gate (a generic "go" does not count).
- Commit only your own files by explicit path — the owner parks his own
  changes in the working tree; **never `git add -A`**. `docs/` is gitignored —
  commit docs with `git add -f`.
- Record decisions in `docs/decisions.md` (append-only, numbered) in the same
  change; deviations from a spec are written down, not papered over.
- End-of-session: update the execution log / stage doc / decision log so the
  next session (or the owner) can resume from the docs alone.

## Ops watches (recurring, calendar-gated)

Consult `docs/project-kernel/pass3/execution-log.md` §standing-risks and the
latest decisions.md entries for the live list (release week-watches, invoice
reconciliation, would-deny→enforce flips, tiering cycles).
