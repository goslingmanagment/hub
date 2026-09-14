A0's hot-table counter cannot distinguish archive-only readable heads from a preferred pending/deleted archive copy. Add a bounded pre-apply classifier using Agent transcript precedence and scoped tombstones, and preserve the original hot counter/query. Seven nullable scalar counters keep legacy/resumed evidence unknown; flag `none` adds no reads. Both queries share one read-only repeatable-read snapshot and the remaining query allowance.

Migration 0194 adds a fixed EXECUTE-only `read_only` EXPLAIN seam for the new query. Applied 0192 is unchanged. Decision 335 and the runbook document the scope, rollback and measurement limits. Polling, candidate stop, business writes and cadence stay unchanged.

Validation on `5f247b4312ea60ab2b81625a4ca49bd8046fb3cf`, based on main `4d9cac4a`:

- `pnpm check` passed: 3762 unit tests, 9 existing skips, 327 files; typecheck ratchet, lint and dashboard build passed.
- Docker-Postgres integration passed 84/84 across 8 serial suites with `ALLOW_MISSING_TEST_PREREQUISITES=0` and `--no-file-parallelism`: reader state, both cost probes, A0 shadow, actual conversation sweep, Agent window/tombstones, migration history and migration runner.
- Coverage includes actual-reader parity, all four pre-apply states, page/group/current-binding fences, immutable read snapshot, decreasing query timeout, legacy unknowns, flag-off zero reads, unchanged business/HTTP outcomes, privileges and SQL fidelity.

Initial failures are retained: restored the existing flat-scalar cursor invariant, corrected cold-event fixture vocabulary and removed a test's incorrect expectation that a metadata sweep inserts message bodies. An initial undefined loop binding was fixed after typecheck. [Exact logs, commands and scope](investigations/fansly-a0-reader-head-state-2026-09-14/REPORT.md).

Independent review: [clean source/docs and evidence review](investigations/fansly-a0-reader-head-state-2026-09-14/REVIEW.md); no open findings.

Production cost for the new query remains unmeasured. Pool checkout is not cancellable by this helper; it is not an end-to-end five-second deadline. These exact-ID observations do not certify full transcript parity, restart/retrocredit the A0 window, meet the seven-day gate or prove savings/latency. No production action was taken for this PR.
