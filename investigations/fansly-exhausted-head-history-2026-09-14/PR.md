After five failed head-recovery attempts, an uncaptured expected ID kept ordinary thread history permanently ineligible. Allow pending history once the bounded head retries are exhausted, while preserving the discrepancy and all active-target priority/backoff rules.

The message handler also starts that newly eligible history from its oldest stored cursor. Independent review caught that changing admission alone still re-read the missing head and looped at the overlap; the execution regression now proves one request advances older history and completes coverage without erasing the exhausted debt. Decision 326 and the existing catch-up runbook record the behavior. No flag, recovery activation, migration or provider-deletion head repair is included.

Final main composition `7bb73162` (main `b78752d0`):
- `pnpm check`: 3,420 unit tests passed, nine existing skips, 304 files; strictness, lint and build passed.
- Five serial mandatory Docker-Postgres suites: 41 passed, no skips — exhausted-head-history, head-debt, conversations-sweep, page-dm.repository and projection-debt.
- Independent source/readability review closed the execution finding. All pinned source hashes remained stable in final validation.

The investigation retains exact commands, compressed logs, the initial deterministic-fixture timing failure and the correction. No production action or measurement was performed for this patch; catch-up remains controlled by its existing allowlist.

Current-main follow-up integrates `a9794e60`. The prior local validation
certifies the unchanged topic source (`7bb73162`); the sole incoming executable/test
change is main's verified UTC fixture. Independent `REVIEW-MAIN-A979.md`
confirms source, decision and evidence preservation. Local suites were not
repeated for this composition; fresh PR CI validates the full merge.
