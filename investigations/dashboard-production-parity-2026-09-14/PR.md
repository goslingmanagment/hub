The deployed dashboard contains five reviewed control and navigation patches absent from main. This restores their feature explanations, page context, reviewed mutation targets, explicit webhook reconciliation and export recovery, so a future main deployment preserves those workflows.

The original 103 topic paths are retained: 102 match production `38032636` byte for byte; the remaining file only expands two 2,000+ character JSX lines. Canonical emitted JavaScript AST comparison verifies identical behavior and rendered text. Historical D296–300 and new D323 explain the restoration. No new flag or backend behavior is introduced.

Validation against the composed main candidate:
- `pnpm check`: 3,574 unit tests passed, nine existing skips, 315 files; lint, strictness and build passed.
- Twelve serial Docker-Postgres suites: 153 passed, no skips. They exercise config updates/gate wakeup, workboard mutations, notifications/incidents, webhook recovery/lifecycle and typed exports.
- Independent review closed the long-line finding and found no remaining actionable issues; source hashes were stable throughout validation.

The committed investigation contains exact commands, complete logs, transfer/source manifests, formatting proof and the independent review. This PR does not deploy or change event-migration acceptance gates. C1 and provider cooldown remain separate PR topics.

Final main composition `83471e2c` incorporates main `b78752d0` (merged C1 and
cooldown). The only merge resolution preserves both decision entries. Final
`pnpm check`: 3,580 passed, nine existing skips, 315 files; twelve serial Docker
PostgreSQL suites: 153 passed, no skips. All pinned source hashes remained stable.
See `final-main-validation/` for exact commands and compressed logs, and
`REVIEW-FINAL-MAIN-MERGE.md` for the independent composition review.

The first CI attempt failed in Typecheck when Node22 exhausted its default
approximately 2 GiB heap. The static job now declares a bounded 4 GiB heap;
no type coverage, error budget, integration job or production configuration
changes. `pnpm check` passed again at that exact 4 GiB limit (3,580 tests and
nine existing skips). Application source remains byte-identical to the final
153-test PostgreSQL validation. The failure and new full-check receipts are
retained in `ci-failure/` and `static-heap-validation/`; fresh CI is required.
