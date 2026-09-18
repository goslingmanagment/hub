A successful W0 identity preflight reported cleanup failure because Docker returned lowercase `no such object`. The shared helper now recognizes complete supported absence messages for the exact container name or immutable ID, while preserving ownership checks and rejecting daemon errors, extra diagnostics and identifier near-matches. This also prevents normal `--rm` cleanup from incorrectly stopping continuity before its scheduled gaps.

Adds D337, the cleanup runbook note and regression coverage. Independent correctness/readability review found no actionable issues. This is an operator-launcher fix; it adds no provider retry, runtime flag or deployment.

Validation:
- `pnpm check`: **3821 passed, 9 skipped, 333 files**; typecheck ratchet, lint and dashboard build passed (1897 existing type errors, no new debt).
- `pnpm exec vitest run --no-file-parallelism tests/fansly-probe-context.integration.test.ts`: **16 passed** against Docker PostgreSQL.
- Python launchers: **25 passed** (short 10, continuity 11, binding 4); old helper fails 5 new regression subcases.
- Real local Docker: both automatic removal and owned-container removal confirmed cleanup and absence.
- Initial fullcheck failed because the private log wrapper imposed umask 077 on an existing public-file fixture; the final run uses ordinary child umask 022. Source remained unchanged; both results are retained.

Production evidence: one earlier identity GET returned HTTP 200 and a matching Lilly-1 account ID. Original cleanup failure is preserved; separate read-only exact-name/run-label listings confirmed absence. No repeat GET or Hub socket was started. Fan-out, presence, six-hour continuity and latency remain unverified.
