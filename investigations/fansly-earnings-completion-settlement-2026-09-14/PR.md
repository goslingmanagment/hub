A completed Fansly earnings walk could commit its zero cursor, fail to settle
its scheduler generation, and then fetch every spender again on retry. Reuse
the existing completed checkpoint only for the same owned request sequence,
without rewriting its read timestamps. New generations and unfinished cursors
continue normally; daily cadence, provider cooldowns and C2c gates stay unchanged.

A PostgreSQL negative reproduction on original main made both endpoint calls
for both fixture fans twice in one generation. The fix retains one complete
sequence and the original checkpoint. Eight focused cases also cover newer
requests, partial progress, first-fan rejection, absent/lost ownership and a
removed checkpoint. D331 and the runbook document the behavior; no flag or
migration is added.

Validation on composed main 4ecbfc83 plus the final patch and fixture:

- `pnpm check`: passed; 3,580 unit tests, nine existing skips, 315 files;
  strictness, lint and dashboard build passed (45.051s).
- Mandatory Docker-Postgres, `--no-file-parallelism`: 39/39 passed across
  `fan-earnings-completion-settlement`, `fan-earnings-capture`,
  `fan-earnings-receipts` and `page-sync-lease-fencing` (10.419s).
- Original-code reproduction: 2/2 cases passed (4.543s), confirming the gap.

Two independent source/test reviews and an independent main-composition review
are clean. Exact final receipts and compressed logs are retained in
`investigations/fansly-earnings-completion-settlement-2026-09-14/`.
No provider traffic, production repair, measured savings or historical traffic
attribution is claimed.
