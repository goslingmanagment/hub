# Exhausted head debt and ordinary history — local candidate

14 September 2026. Base main `478fca42`; branch
`fix/fansly-exhausted-head-history-20260914`. Decision 326 is a local
coordinator reservation and must be checked before publication.

The selector stopped head searches at five attempts but also excluded pending
history whenever any uncaptured head debt existed. Exhausted debt therefore
made ordinary history ineligible indefinitely. The list sweep separately used
`hasUnresolvedFanslyDmHead` to suppress the corresponding message-stream wakeup.

The candidate changes those two admission decisions and the admitted history cursor:

- Pending history is excluded by head debt only when `attempts < 5` and the
  expected ID remains uncaptured. Due debt retains priority; unexhausted debt
  in backoff cannot enter through the history path.
- The list wakeup reuses its already-read `nextFanslyDmHeadRetryAt` result.
  It returns no deadline when the eligible conversation has only exhausted
  debt, allowing pending history to request the sibling stream. Visibility,
  identity and exclusion guards still run before that wakeup is accepted.
- A fresh pending-history candidate without a head target starts ordinary
  backfill at its oldest stored cursor. A missing expected head no longer
  forces an incremental overlap that leaves history pending and repeats work.
  Due head targets, deep backfill and already pinned work retain their behavior.

`hasUnresolvedFanslyDmHead` itself remains unchanged: exhausted uncaptured IDs
still return true. The report, attempt cap, exact-ID acknowledgement and later
capture resolution are unchanged. No debt row, thread head or coverage receipt
is repaired or removed. There is no provider-deletion decision, new flag,
migration, recovery activation or metadata full-row change (audit finding 10
remains separate).

The isolated Postgres regression suite covers five cases: exhausted debt remains
visible while its history is selectable; a competing unexhausted head has
priority and preserves backoff; an allowlisted real list sweep requests pending
history with five attempts; the same sweep does not bypass four-attempt debt
waiting in backoff; an actual message chunk reads older history once, completes
coverage and keeps the exhausted missing-head identity visible. Provider
responses come from mock adapters; these tests make no live provider requests.

The seven-file [source manifest](source-manifest.json) records the local
code/test/docs snapshot. [Independent review](REVIEW.md) found the
incremental-overlap gap; the cursor fix and execution-level regression closed
it. The reviewer also checked the final deterministic retry-date fixture and
reported no remaining findings.

The first Postgres pass retained one failure in the new active-head priority
fixture, which used a database-default deadline equal to `now()` while the
selector used a Node timestamp. The final fixture explicitly seeds a past-due
deadline and preserves the separate future-backoff assertions. Runtime source
was unchanged after that run. The original receipt and failing log remain in
`validation-20260914T003359Z`; its full `pnpm check` passed.

Final serial Docker-Postgres validation passed **41 tests in five suites**, zero
skips, with missing prerequisites treated as failures. Exact commands, raw
logs, receipt hashes and source pins are in
[`validation-20260914T003607Z`](validation-20260914T003607Z). The relevant
Postgres command is:

```sh
ALLOW_MISSING_TEST_PREREQUISITES=0 NODE_OPTIONS=--max-old-space-size=8192 \
pnpm exec vitest run --no-file-parallelism \
  tests/fansly-dm-exhausted-head-history.integration.test.ts \
  tests/fansly-dm-head-debt.integration.test.ts \
  tests/fansly-dm-conversations-sweep.integration.test.ts \
  tests/page-dm.repository.integration.test.ts \
  tests/projection-debt.integration.test.ts
```

Final `pnpm check` also passed: **3,414 unit tests passed, nine skipped**, lint
and dashboard build passed. The existing strictness ratchet passed with 1,901
known errors across 121 files, within its unchanged budget; this is not a claim
of zero TypeScript debt. The check took 44.13 seconds and the serial Postgres
run 12.76 seconds. All seven source/document pins were unchanged after both
commands. `git diff --check` passed. Offline frozen install passed separately.

No commit, push, PR, deployment, flag change or production read/write has
been performed for this candidate. Existing history/request budgets and
stream/provider gates continue to apply. Returning to the previous image can
reintroduce the history blockage but does not discard the retained discrepancy.
