Restore the five deployed dashboard patches absent from main: feature explanations, page context, reviewed mutation targets, explicit webhook reconciliation and fresh export recovery. This prevents a future main deployment from regressing those workflows.

The original 103 topic paths are retained: 102 match production `38032636` byte for byte; one file expands two long JSX lines with emitted JavaScript AST equality. Historical D296–300 and new D323 document the restoration. Independent reconciliation verifies all known production performance/C1 fixes and all 187 migration file identities remain present; newer main behavior is preserved. This source comparison does not certify deployment readiness or production health.

CI's full-workspace Typecheck exceeded Node22's default approximately 2 GiB heap. The static job now has a bounded 4 GiB heap. Type coverage, error budgets, integration jobs and production configuration are unchanged. The original failure is retained.

Final composition `7e88384e` includes main `a9794e60` and its UTC fixture fix:
- `NODE_OPTIONS=--max-old-space-size=4096 pnpm check`: 3,580 unit tests passed, nine existing skips, 315 files; strictness, lint and build passed.
- Thirteen serial mandatory Docker-Postgres suites: 179 passed, no skips. They cover configuration/gate wakeup, workboard mutations, notifications/incidents, webhook recovery/lifecycle, typed exports and the newly merged credits fixture.
- Independent correctness/readability, main-composition, compiler-budget and production-preservation reviews have no outstanding findings. All pinned source hashes were stable during final checks.

`investigations/dashboard-production-parity-2026-09-14/` retains exact commands, compressed logs, source manifests, formatting proof and reviews. The final receipts are in `final-main-a979-validation/`. No new runtime flag, deployment or event-migration gate change is included.
