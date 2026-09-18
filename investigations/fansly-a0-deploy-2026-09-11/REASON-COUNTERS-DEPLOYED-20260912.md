# A0 reason counters: deployed and read back

PR176 is merged: https://github.com/goslingmanagment/core/pull/176.
Release 4310680dc2f923955295f85491eb6cf43d9bb82a deployed through the standard
script at 20:56:28–20:59:35 UTC on 12 September, exit 0. API, worker and scheduler
were independently healthy with zero restarts. The protected sync-health gate
returned 200; the production-pinned CLI was rebuilt and verified. No flag,
provider request, polling policy or migration changed.

The exact production-preserving release passed pnpm check: 3467 tests in 310
files, nine existing skips; strictness 1897/120, lint/typecheck/build passed.
The production build and serial Docker-Postgres regression passed: 34 tests in
four suites, zero skips. Both independent correctness and quality reviewers
approved the final release after its table-format finding was corrected.

At21:18:54 UTC the narrow readback window contains 16 sweep rows: 15 complete
and one running. Five started after the new worker and completed before the
cutoff. Lora-2 G5484, Lilly-1 G7402, Lora-1 G4832 and Lora-3 G7646 processed
below-stop sections; Ari-1 G671 completed without a virtual stop. All six new
counters are known and zero. New Lilly-2 G6824 was running, so its zeros describe
only its processed prefix. Legacy Lilly-2 G6823 retains six null counters.
The other nine old rows have no new fields. All ten previously completed rows
are unchanged. An independent reviewer confirmed the raw receipt, cohort and hash.

This read proves persistence through completion, not positive detection of every
reason. It does not reconstruct historical unknowns or clear A0/A1. The narrow
reports overlap each other and the cumulative observation; they are never added.
Physical HTTP savings and fresh-event latency remain unmeasured. The original
clock still reaches seven days at 2026-09-17T22:58:33.610Z; age alone is not acceptance.

Evidence: the stage-owned release directory is
/Users/dmitriy/.codex/worktrees/hub-fansly-a0-shadow/investigations/fansly-a0-reasons-2026-09-12/evidence/release-20260912T204117Z.
Readback report hash: 0d5eb79ce997f6c82526e22bbbaf4c8d2a37dc2737a07bf6229697ee5bca78c8.
See deploy-result.json, validation.json, reason-counter-followup-20260912T211853Z.json
and followup-report-20260912T211853Z/ for the raw evidence and review.

An intervening replay release ea7a629ceb3c was independently observed healthy
at 21:27:31 UTC, preserving the A0 code. Its runtime boundary is recorded separately;
the narrow measurement above was collected before that later deployment.
