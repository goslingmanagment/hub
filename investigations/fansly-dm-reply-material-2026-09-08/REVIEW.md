# Independent review — pre-A0 reply material

Base: current main `93f50bd6` (PR #157). Reviewer: separate
`review_head_debt` agent, read-only diff/caller review. Tests were run by the
implementation coordinator, not concurrently by the reviewer.

Findings fixed and independently re-reviewed:

- Retained old reply material must repair unknown links beneath a newer sparse
  body without rolling back text/media or their provenance. Independent field
  clocks and a required separate update now provide this.
- Explicit nulls on text-only messages must emit material despite immutable
  ordinary message dedup, and advance clocks so old replay cannot resurrect links.
- Legacy seed lift to the rebuild shadow must preserve reply metadata and clocks.

Final review: all findings closed; no remaining blocking finding. This is a
code review, not production acceptance.

## Validation

- `pnpm check`: passed. Strictness ratchet: 1,908 existing errors within budget
  across 121 files; lint passed; 280 unit files / 3,103 passing tests / 9 existing
  skips; dashboard build passed with the existing chunk-size warning.
- Docker PostgreSQL: 7 files / 55 passing tests / zero skips:
  `fansly-dm-reply-material`, `canonicalize-sweep`, `message-archive`,
  `message-archive-rebuild`, `media-plane-projection`,
  `fansly-purchase-history` integration suites and schema guard.
- ESLint rechecked changed integration fixtures after updating their current
  schema expectations. `git diff --check` passed.

The new integration cases prove retained v5 -> v6 -> serving transcript repair,
unchanged ordinary message counts, idempotent reparse, replay/rebuild convergence,
sparse parent/root merge, explicit clears, stale facts after clear, preserved
fresh text, legacy seed lift, and unchanged OFAPI presence/clear behavior.
Existing suites cover mixed-event/checkpoint append, purchase media coexistence,
archive projection and the staged shadow switch. Local logs are preserved in
`evidence/check.txt` and `evidence/integration.txt`.

## Production read-only evidence

At 2026-09-08 11:44:01 UTC, the original 24-hour diagnostic window still had
994 distinct captured messages with a parent ID. Counts and all six sample IDs
match the original raw evidence. This was a `read_only` PostgreSQL session in
`BEGIN READ ONLY` with a 25-second statement timeout; it made no provider calls.

The copied `diagnostic-reply-serving-check.json` is the earlier diagnostic
snapshot: five missing links of six sampled archive messages, with lilly-2's
existing link preserved. It is explicitly NOT a fresh archive census or proof
of repair. No production deploy, reparse, archive rebuild or recovery was run.
Savings, production repair latency, and added material storage are unmeasured.

Deployment approval includes automatic v6 background reparse; manual replay
and per-page head recovery are separately gated as described in the runbooks.
