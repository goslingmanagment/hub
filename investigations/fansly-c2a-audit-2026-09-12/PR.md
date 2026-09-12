# Verify retained Fansly earnings against their projection

Draft for review; not published. The original C2a PR165 is merged, so publishing
this follow-up requires an exception to the owner's one-stage/one-PR instruction.

The retained earnings census proves parser versions but cannot verify projected
amounts or source receipts: read_only cannot access the projection or its actual
watermark. Add three restricted readers and a local exporter that compare the
latest valid retained snapshot per fan/window with every projected row in one
bounded repeatable READ ONLY transaction.

The audit preserves missing, rejected and unavailable data as explicit failures
of verification. It writes private evidence and hashes and reports success only
after clean session shutdown. No provider request, polling policy or flag changes.
Decision 296 and the existing earnings runbook describe the new read operation.

- `pnpm check`: passed; 3,241 unit tests, nine existing skips, lint/typecheck/build
  green. Strictness debt stays within its existing budget.
- Relevant serial Docker-Postgres regression: eight suites, 44 tests passed,
  zero skips. Covers intermediate A-B-A/stale ordering, real source receipts,
  CAS boundaries, frozen pagination, full projection scope and exporter failure.
- Local PG scale: 120,000 captures in 13,155 ms; 1,000 real projected source
  receipts in 129 ms. These are local timings, excluding SSH and production.
- Independent correctness and code-quality reviews: all findings fixed and
  re-reviewed. Detailed results and logs are in
  `investigations/fansly-c2a-audit-2026-09-12/`.

Production projection parity, HTTP savings and fresh-event latency are still
unmeasured. Compressed captures remain unavailable and prevent acceptance.
Deploy through a release preserving the current production ancestry and applied
0182–0185; this main-based branch is not itself that combined release. Replay,
rebuild and C2b activation keep their separate gates.
