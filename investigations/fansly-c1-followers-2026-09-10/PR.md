Fansly follower reconciliation now records which unchanged anomaly predicates
fired, the prior queue state and the result of guarded membership updates.
Restricted, bounded readers retain missing or invalid evidence as unknown.
The diagnostic implementation is complete. The policy and presence-equivalence
gate remains open; this PR introduces no trigger suppression, cadence change,
presence policy, additional provider request or new flag.

The previously missing Lora-3 receipt is now retained in the branch. The
[evidence package](https://github.com/goslingmanagment/core/blob/feat/fansly-c1-followers/investigations/fansly-c1-followers-2026-09-10/evidence/lora3-followup-20260913T000235Z/README.md)
contains the dated report and independent review, the compressed full
334-row source receipt, nine exact report records and provenance hashes.
Generation 775 protects one relation under grace; generation 776 records one
actual deactivation; five subsequent incremental comparisons match and request
nothing. This closes that natural follow-up. The aggregate data does not identify
the relation, prove atomic active-after state or justify suppressing a full walk.
No new production read was performed to retain these artifacts.

Decision 294 and the diagnostics runbook describe the implementation. Applied
migrations retain their names and bytes, including migration 0185 with SHA-256
`bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0`.

Validation of the complete candidate integrating main `0a08365f`:

- `pnpm check` passed: 3,366 unit tests in 300 files, nine existing skips;
  strictness ratchet, lint and dashboard build passed.
- Eight serial Docker-Postgres suites passed 102 tests with no skips:
  followers-membership, followers-timeline, followers-diagnostics,
  generation-high-water, page-sync-lease-fencing, sync, fan-churn and
  fansly-dm-shadow (including the newly integrated A0 regressions).
- Independent review found no actionable findings. It verified merge preservation,
  decompressed raw SHA-256, exact subset objects, both generation checkpoint
  chains, source identity and unchanged migration 0185.

The initial check encountered 14 pre-existing lint errors in two untracked
sync-health-latency probes. Only those probes were temporarily moved outside
the worktree; both were restored in `finally` with their original hashes.
No tracked lint exclusion or application code was changed. The initial failure,
successful commands, compressed logs and restoration receipt are retained in the
[validation package](https://github.com/goslingmanagment/core/blob/feat/fansly-c1-followers/investigations/fansly-c1-followers-2026-09-10/evidence/audit-followup-validation-20260914/VALIDATION.md).
The [independent review](https://github.com/goslingmanagment/core/blob/feat/fansly-c1-followers/investigations/fansly-c1-followers-2026-09-10/REVIEW-AUDIT-FOLLOWUP.md)
records the inspected content fingerprint. PR166 remains a draft because the
policy/presence gate is open.

Historical validation on the prior `3a6eace1` candidate: 3,365 passing unit tests,
nine existing skips, 300 unit files; 86 passing serial Postgres tests in seven
suites; independent correctness/readability review and five required CI checks
passed. [Prior validation](https://github.com/goslingmanagment/core/blob/3a6eace148c1b9a238aaf50302f5de3e5e9f4749/investigations/fansly-c1-followers-2026-09-10/MAIN-SYNC-20260913.md)
does not certify this updated candidate.

Production diagnostics run in a separately composed release. This branch
preparation is not a deployment and does not replace verification of that release:
production additionally contains applied `0186_ops_metrics_recent_series.sql`,
which this C1 branch does not yet contain. The separate production-parity work
must retain it before any future deploy. Safe suppression, equivalent presence
coverage, physical savings and provider-event-to-reader latency remain unproven.
