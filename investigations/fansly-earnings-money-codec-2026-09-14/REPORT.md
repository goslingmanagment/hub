# Fansly earnings money codec

Audit finding 13: use the existing shared codec for integer-mills sums and
projection conversions while preserving the supported input/output contract.
No incorrect production amount has been established. No new production read,
data rewrite, parser-version bump or flag is included. D329 records the scope.

The change leaves the existing safe-integer and whole-observation refusal
checks in place. `sumMills` accumulates bigint via `millsFromInteger` and
`millsToNumber` returns to the existing numeric event/repository boundary.
Projection's prior truncation and null defaults remain unchanged for stored JSON
values. Added cases exercise both safe-integer limits and negative adjustments.

Full `pnpm check` passed 3,423 unit tests in 304 files, nine existing skips,
with strictness, lint and build passing. Four serial mandatory Docker-Postgres
suites passed all 26 cases: earnings identity, projection, projection-audit
reconciliation and the read-only audit. These retain observation ordering,
legacy receipts, A→B→A replay identity and projection parity. Exact commands,
compressed logs and stable source hashes are in `validation/`.

Independent review found no actionable correctness or readability findings.
No production action or measurement was performed. The supplied audit and
local boundary checks do not establish that any production amount was wrong.
