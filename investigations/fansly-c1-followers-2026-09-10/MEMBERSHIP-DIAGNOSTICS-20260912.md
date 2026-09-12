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

The owner resumed implementation and authorized deployments. The current runtime
is 02ff7e34239e; deploying the older C1 base would lose unrelated production fixes.
The release must preserve that exact source plus the reviewed C1 delta and pass
combined-source checks before the standard deployment. PR166 remains the only C1
draft. This refinement is ready locally; it is not yet deployed or an accepted
C1 policy fix. Physical savings and fresh-event latency remain unmeasured.
