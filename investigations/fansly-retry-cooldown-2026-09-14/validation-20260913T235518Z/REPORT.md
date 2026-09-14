# Retry-After validation

Local candidate based on `origin/main` at
`0a08365fbefa545397f4e91a2eae3fca7c36c444`. Node 26.7.0, pnpm 10.33.1.
The tested source identities are retained in `source-sha256.txt`; each command
has its complete output in `.log` and arguments, UTC times, duration, and exit
code in the corresponding `.json` receipt.

| Command | Result | Duration |
|---|---|---:|
| `pnpm install --offline --frozen-lockfile` | PASS; 598 packages reused, no downloads | 2.683s |
| First `pnpm check` (`check-initial`) | FAIL at strictness ratchet; three missing fixture seed guards caused 21 undefined-value errors | 13.511s |
| `pnpm check` after those guards (`check`) | PASS; 3372 unit tests, 9 existing skips, 300 files; lint and dashboard build pass | 48.757s |
| Five serial Docker-Postgres suites (`postgres`) | PASS; 64 tests, 5 files, no skips | 22.536s |

The strictness ratchet passes with the existing baseline of 1901 errors in 121
files; no new type debt was added. The initial failed check remains retained.

The Postgres command used `ALLOW_MISSING_TEST_PREREQUISITES=0` and
`--no-file-parallelism`. Suites:

- `tests/page-sync-provider-cooldown.integration.test.ts`
- `tests/page-sync-lease-fencing.integration.test.ts`
- `tests/fansly-dm-conversations-sweep.integration.test.ts`
- `tests/sync.integration.test.ts`
- `tests/notification-incidents.integration.test.ts`

The new nine-case suite verifies both orderings of queued request versus retry
for `rate_limit` and `provider_5xx`, preserving a 24-hour deadline and the latest
request source, payload, and revision. The dispatcher list, ordinary lease,
and targeted lease refuse work immediately before the deadline; the latest
revision can run and complete at the deadline. Ordinary transport retry and
expired provider retry can still be superseded. A real `dm_conversations`
handler against a mocked adapter queues its `dm_messages` follow-up while the
existing durable provider cooldown remains intact.

The existing lease fencing suite covers ordinary yield/manual supersession.
The full unit run also includes the executor's long-cooldown incident tests
and the Fansly adapter retry suite. No production requests, flag changes,
provider calls, commits, pushes, or PR publication were performed by this
validation run. Independent review and the decision entry remain separate
completion steps.
