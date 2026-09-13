# C1 candidate validation — 14 September 2026

The merge candidate based on C1 `3a6eace1` and main `0a08365f` passed
`pnpm check`: 3,366 unit tests in 300 files, nine existing skips, strictness
ratchet, lint and dashboard build. Eight serial Docker-Postgres suites passed
102 tests with no skips: followers-membership, followers-timeline,
followers-diagnostics, generation-high-water, page-sync-lease-fencing, sync,
fan-churn and fansly-dm-shadow.

These checks exercise diagnostic receipt validation, membership protection and
guarded retirement, timeline/queue evidence, generation and lease fencing, sync
behavior and the newly integrated A0 regressions. They do not establish presence
equivalence, safe suppression, production savings or event latency.

The initial check failed only on 14 existing lint errors in two untracked local
probes. Their original bytes were hashed, temporarily moved outside the worktree
for validation, then restored in `finally` and hash-verified. No tracked lint
exclusion or application code was changed. The initial failure remains in
`check-initial-execution.json` and `check-initial.log.gz`; successful checks have
their own execution receipts and losslessly compressed logs.

The reviewed candidate inventory was unchanged through validation. The merge is
not a deployment; PR166 remains a draft while the policy/presence gate is open.
