# C1 membership diagnostics — 12 September 2026

The natural window through 11:21 UTC has 206 valid decisions and 41 requests
from clean queues. Every requested revision later completed an exact generation.
Repeated walks remain compatible with legitimate absence protection; suppression
is not justified. The old receipts expose candidates before UPDATE, but do not
show which protection applies or how many rows UPDATE actually changes.

This refinement adds six counts to the existing aggregate and records the
existing guarded UPDATE's returned-row count. Active rows outside the current
generation are partitioned into candidates, generation grace only, timestamp
protection only, both protections and future generations. The receipt retains
its own sweep-start timestamp, including restart cases where checkpoint summaries
omit it. It adds no provider call, flag, cadence or predicate change.

The bounded reader in forward migration 0185 exports allowlisted scalars and
`membership_receipt_valid`. Missing, duplicate, malformed or inconsistent
receipts stay invalid. Withheld retirement has a null actual count. The aggregate
and UPDATE are separate statements: the counts do not certify active-after state
or identify a specific row or writer. Applied 0182/0183 stay byte-identical;
the assembled release must also retain already deployed 0184.

## Validation

- Unmodified `pnpm check`: 3251 passed, nine existing skips in 296 files;
  lint and dashboard build passed. Strictness remains 1901 known errors in
  121 existing files. Unit duration: 25.43 seconds.
- Serial real Docker-Postgres: 84 passed in six suites, zero skips, 25.63 seconds.
  Suites: followers-membership, followers-timeline, followers-diagnostics,
  generation-high-water, page-sync-lease-fencing and sync.
- The 14 new cases cover each disjoint protection, the exact timestamp boundary,
  inactive and other-page rows, actual retirement, withheld retirement, restart
  timestamps, malformed/private/duplicate/missing receipts and exclusive windows.
  A database trigger deliberately makes candidates=2 but updated=1; the test
  checks both the receipt and actual rows. Provider list calls remain unchanged.
- Both independent correctness and code-quality reviews closed their findings
  and found no remaining actionable issues. Reviewers did not run tests.

The full check used an exact Git-tree export with the existing dependencies and
a private Git index for SDK packaging provenance. Two historical untracked
probe scripts fail lint in the working directory; they were preserved, not
edited or hidden through a lint-rule change. The first export lacked Git context,
so SDK packaging failed; that setup was corrected before the successful run.
All failed and successful logs are retained. See
[validation receipt](evidence/membership-20260912/validation.json).

## Release and remaining gate

The owner authorized deployments. Release `7aaa3185757e6a89d1b7427b0d54aa8720c74da4`
combines the exact reviewed C1 change `97fcbd03` with the observed production
`02ff` base, preserving all unrelated paths and 180 applied migrations. The
release tag retains both parents without expanding PR166's scope.

The combined tree passed `pnpm check` (3258 tests, nine existing skips), 176
serial real Postgres tests in 11 suites, production build and both independent
release reviews. C1 source commit 97fcbd03 separately passed all five GitHub CI
jobs. See [release validation](evidence/membership-20260912/release-validation.json).

The standard deployment exited 0 at 12:11:44 UTC. Its protected sync-health
request returned 200 in 4714.768 ms. All three roles were healthy with zero
restarts; six compiled hashes, migration 0185, the restricted reader and pinned
CLI source/capabilities were verified. This single request does not measure
fresh-event latency or attribute a speedup to C1. No flag, replay, recovery,
socket or image GC operation ran. The previous image and applied SQL remain.

The first repeatable READ ONLY window, 12:11:06.271182593–12:14:16.851636 UTC,
contains zero follower runs and no new membership receipt. The next gate is a
natural full-walk completion and its following incremental comparison. PR166
remains a diagnostic draft, with no justified policy fix, measured physical
savings or fresh-event latency. A0's original clock and evidence gates remain.
