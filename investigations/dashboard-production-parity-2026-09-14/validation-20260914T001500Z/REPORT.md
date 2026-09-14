# Dashboard candidate validation — 14 September 2026

**All required local checks passed.** Candidate source is local merge
`8d9606ca` over main `478fca42`, with the reserved Decision 323 draft. The
103 imported path hashes are unchanged from the independently reviewed
candidate: 102 match production bytes and one has verified formatting only.
No source or dependency change occurred during the checks.

| Check | Result | Duration |
|---|---|---:|
| Offline frozen dependency install | PASS; no dependency changes | 2.32s |
| `pnpm check` | PASS; 3,574 unit tests, nine existing skips, 315 files | 51.07s |
| 12 serial Docker-Postgres suites | PASS; 153 tests, no skips | 43.10s |

`pnpm check` includes the strictness ratchet, lint, unit tests and dashboard
build. Strictness remains within the unchanged budget: 1,897 known errors in
120 files. This is not a claim of a debt-free `tsc` run. The build retains its
ordinary large-chunk advisory; it did not fail.

The integration command used `ALLOW_MISSING_TEST_PREREQUISITES=0` and
`--no-file-parallelism`, so absent Docker prerequisites could not become skips:

```sh
ALLOW_MISSING_TEST_PREREQUISITES=0 NODE_OPTIONS=--max-old-space-size=8192 \
pnpm exec vitest run --no-file-parallelism \
  tests/admin-config-api.integration.test.ts \
  tests/admin-config-update-api.integration.test.ts \
  tests/admin-config-staged-api.integration.test.ts \
  tests/config-settings.integration.test.ts \
  tests/config-gate-wakeup.integration.test.ts \
  tests/workboard-v2.integration.test.ts \
  tests/workboard-stage23.integration.test.ts \
  tests/notifications-dashboard.integration.test.ts \
  tests/notification-incidents.integration.test.ts \
  tests/ofapi-webhook-recovery.integration.test.ts \
  tests/ofapi-webhook-lifecycle.integration.test.ts \
  tests/ofapi-typed-exports.integration.test.ts
```

The unit checks cover restored component/read states, feature registry and
configuration scope, reviewed mutation targets, draft/Undo handling, uncertain
webhook replies, fresh export recovery and navigation. The integration suites
exercise their existing server contracts with real Postgres: configuration
reads/updates/staging and wakeup behavior, Workboard state and actions,
notification delivery/recovery, webhook lifecycle/recovery, and typed exports.
They do not constitute a new live browser or production acceptance exercise.

Full output is in [check.log](check.log) and [postgres.log](postgres.log).
[check.json](check.json) and [postgres.json](postgres.json) retain arguments,
UTC start/end times, duration and exit code. [source-sha256.json](source-sha256.json)
binds the tested source and Decision 323 draft. Offline installation has its
separate [receipt](../preparation-20260914/install.json).

No push, PR publication, provider request or production action was performed.
Decision numbering and final publication remain coordinator gates. The cost
remeasurement packet remains untracked and outside this dashboard PR.
