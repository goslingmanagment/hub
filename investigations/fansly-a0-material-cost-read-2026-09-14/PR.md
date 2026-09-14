A0's material-query measurement is blocked because the production read-only
role cannot SELECT the underlying DM tables. Add migration 0192 with an
EXECUTE-only function that selects at most 100 current stored heads for one
Fansly page and runs the existing material query under EXPLAIN ANALYZE/BUFFERS.
The fixed query is pinned to the runtime source; the function requires caller
READ ONLY, REPEATABLE READ and bounded statement/lock timeouts. No table grant,
runtime change or flag is introduced.

Decision 332 and the shadow runbook cover the six-page read, evidence limits
and additive application rollback. This enables a cost measurement; it does
not establish reader completeness, event latency, savings or an A0 gate pass.

Validation on base `4e18d130ea6ca4b834141789265cce8442f8fcae`:

- `pnpm check` passed: 325 files, 3,753 tests, 9 existing skips; typecheck ratchet,
  lint and dashboard build passed.
- `pnpm exec vitest run --no-file-parallelism` with the material-probe, DM-shadow,
  events-measurement, production-migration-history and migrate-runner integration
  suites passed: 45 tests, no skips. The new suite includes 17 real PostgreSQL
  cases for ACLs, limits, SQL quoting, snapshots, transaction guards and timeout.
- Exact commands, validated source hashes and compressed logs are retained in
  `investigations/fansly-a0-material-cost-read-2026-09-14/`.
- Independent source and receipt review found no actionable findings; its exact
  source fingerprints and scope are retained in `REVIEW.md` in that packet.

No production measurement or deployment was performed from this worktree.
