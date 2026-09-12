# Verify retained Fansly earnings against their projection

Draft for review; not published. The original C2a PR165 is merged, so publishing
this follow-up requires an exception to the owner's one-stage/one-PR instruction.

The retained earnings census proves parser versions but does not compare the
projected amounts and their exact source receipts. Add three restricted readers
and a local exporter that compare the latest valid retained snapshot per
fan/window with every projected row in one bounded repeatable READ ONLY
transaction, including the actual projection watermark.

The audit preserves missing, rejected and unavailable data as explicit failures
of verification. It writes private evidence and hashes and reports success only
after clean session shutdown. No provider request, polling policy or flag changes.
Decision 312 and the existing earnings runbook describe the new read operation.

The candidate integrates main `c76c6db0`. Decision 312 and migrations 0187–0189
avoid numbers occupied by other release branches. The three SQL bodies and
twelve TypeScript source/test files are unchanged from the original candidate.
All 180 migrations from main are preserved.

Validation on tree `c997d087c00f0c11b1b43d778e98f31dfbfe6e17`:

- `pnpm check`: passed; 3262 unit tests in 297 files, nine existing skips;
  lint, typecheck and build passed. Strictness remains 1901 known errors in
  121 files, within its existing budget.
- Serial Docker-Postgres regression: eight suites, 44 tests passed, zero skips,
  35.83 seconds. Covers intermediate A-B-A/stale ordering, real source receipts,
  CAS boundaries, frozen pagination, full projection scope and exporter failure.
- Historical local scale measurements on `9ddf153c`: 120,000 captures in
  13,155 ms; 1,000 real projected source receipts in 129 ms. These exclude SSH
  and production. The fixtures passed again; those timings were not remeasured.
- Original correctness and quality findings are fixed and re-reviewed. Merge
  review confirms source preservation and numbering; its stale test-label
  finding is fixed. Final packet review is recorded in `REVIEW.md`.
- Source and documentation pass the whitespace check. The unchanged historical
  raw logs retain three warnings and their original hashes. Detailed receipts
  and current log hashes are in `MAIN-SYNC-20260912.md` and its validation file.

Read-only production catalog checks at 19:30–19:32 UTC confirm absent audit
readers and applied migrations only through 0185. All three roles are healthy
on `31b73a96`, with zero restarts. This does not measure projection parity.

Compressed captures remain unavailable and prevent acceptance. Production
parity, HTTP savings and fresh-event latency are unmeasured. Before deployment,
assemble a release preserving current production ancestry and applied migrations.
It must include and apply reserved 0186 before 0187, or resolve that reservation
first; the migration runner rejects adding an unapplied lower predecessor later.
This branch is not that combined release. Replay, rebuild and C2b activation
retain their separate gates.
