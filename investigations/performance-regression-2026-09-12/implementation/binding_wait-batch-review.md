# Binding-wait fresh batching — independent review

**Verdict: BLOCK — the current all-webhook prefetch expands a governed-erasure race.**

Reviewed the integrated candidate in
`/Users/dmitriy/code/goose/.worktrees/hub-performance-fixes-20260912` against
HEAD `a2153faba545154eefc9e7ad8fd516e248f27669`. This review covers only the
binding-wait batching patch; the reviewer's own preview/comment fixes are excluded.
No code changes, suites, database runs or production actions were performed.

## Blocker: prefetched mapped bodies can outlive erasure and recreate canonical facts

`canonicalize-driver.ts:497–499` enables prefetch for **every** webhook page.
`payload-reader.ts:627–638` loads later pointer-only rows before their processing
turn; `:648–656` later accepts the saved body if the in-memory reference still
matches. An erasure does not mutate those already selected JavaScript rows.

Concrete differentiating interleaving:

1. Two pointer-only webhook observations for mapped pages A and B enter one
   group. The candidate reads both catalog bodies while resolving A.
2. After A is processed/stamped, execute a governed erasure of B. The erasure
   removes B's observations and catalog body, while deliberately preserving its
   page catalog row. The canonicalizer's binding map was built before erasure.
3. Resolve B. The old single-row path now finds its catalog object/body missing
   and raises `CapturePayloadUnavailableError`, leaving it unavailable. The
   candidate consumes B's saved body because its old in-memory ref still matches.
4. Normal webhook events reach `appendDomainEvents` / `appendMixedDomainEvents`
   at `canonicalize-driver.ts:647–651`. These paths do not check the erasure
   tombstone. The specialized guards at `:625–643` cover team exports and two
   other event kinds, not ordinary message/presence webhooks. Migration 0057
   explicitly has no FK on `domain_events.observation_id`. The candidate can
   therefore append a new canonical fact referring to a removed observation.

Source custody was checked against `services/erasure/index.ts:1530–1606` and
`:1865–1909`: its committed tombstone and exclusive page fence protect cooperating
writers, but the normal canonical append above does not participate. The
catalog sweep happens after the observation deletion. An existing per-row
read-to-append race is not claimed fixed by the baseline; this patch adds the
inter-row prefetch window and changes the outcome of the sequence above.
Projection-specific transcript fences do not make a recreated canonical source
fact acceptable.

This is code-proven control flow, not a newly executed concurrent DB reproduction
by this reviewer. The coordinator should retain a discriminating baseline versus
candidate test before accepting the redesign. The current 67 tests do not cover
this interleaving: the body-removal test creates a fresh resolver after deletion.

## Narrow redesign agreed with coordinator

Batch only rows that cannot append in this run: `accountId === null`, no resolved
envelope-native reference in the same immutable, platform-scoped binding map,
and no `data_exports.*` kind (their target accounts come from the body). Keep
mapped, ambiguous and team-export rows on the original per-row path.

This restriction is sufficient for the identified regression: for an eligible
non-export row, `accountIds` stays `[null]`; every positive-draft result reaches
`skippedUnmapped` before any append. Rejection retains the existing skip, dry-run
does not write, and the existing zero-draft stamp creates no canonical material.
The next run reads a fresh binding map and normalizes a newly mapped row through
the original reader. This is a read optimization for held-back rows, without a
new cache, body mutation, terminal mapping stamp or erasure protocol redesign.

**Filter the candidate set, not merely the current call.** Calling a resolver
only when the current row is unmapped but constructing it over all page rows
would still prefetch mapped/export neighbors. Use the same binding formula as
the downstream append decision and preserve all parsing and stamp branches.

Required acceptance cases:

- Governed deletion between processing two mapped pointer rows: later erased
  material must not be appended; compare the old path and candidate outcome.
- Mixed unmapped/mapped/ambiguous/export page: capture catalog query parameters
  and prove mapped/export refs never occur in a prefetch batch.
- Binding repair on a subsequent run changes the row to ordinary individual
  reading and retains existing append/stamp/dedup behavior.
- Repeat the synthetic pointer benchmark after narrowing; its all-unmapped
  corpus should keep the same round-trip gain with all parser calls intact.

## Other reviewed properties

The batch repository query is appropriately small. VALUES positions preserve
duplicates/order, LEFT JOIN LATERAL LIMIT 1 produces one answer for each ref,
and both catalog and JSON-body probes use `(bucket_month, object_id)`. Body
presence uses the joined key, correctly distinguishing JSON `null` from absence.
Representation mismatches retain the envelope-type boundary. Omitting the
byte-body join is safe for the two envelope kinds that both require canonical
JSON. There is no persistent hint state or new migration in this candidate.

Reference values are copied before the query and checked before consumption;
an in-memory reference replacement falls back to its current single-row read.
Missing results remain per-row explicit failures, and a whole batch failure
falls back to individual reads. Successful siblings do not inherit a failure.
The ordinary reader still owns mode handling, warnings and per-row counters.

For conforming catalog objects, the writer records canonical byte length in
`logical_bytes`; values above 512 KiB are deferred to the single reader. A batch
returns at most eight such small bodies. The JavaScript bound is the ordinary
single large body plus at most seven small prefetched bodies, with additional
JSON/heap overhead; it is not a four-MiB RSS bound. The consumed slot is released.
There is no persistent positive or negative body cache. A group snapshot still
means body removal/repair after prefetch is observed only on a later lookup;
the restricted unmapped-only scope is what makes that tradeoff acceptable here.

The integrated earnings single-parse path remains intact: resolution is still
before `family.parse`, and the returned parsed result is reused. Earnings uses a
different source family; this patch does not change its parser entry or drafts.
Observation selection, cursor advancement, row counters and budgets remain
outside the changed seam.

## Evidence inspected and limits

Read the actual staged diff, author handoff, the complete new integration file,
existing read seam, driver/registry, capture writer/schema and erasure code.
Read the root log confirming **5 files / 67 tests passed**; did not rerun them.

The actual benchmark source extracts the pre-batch driver from HEAD and imports
the current driver, using real repository/seam/parser code and a fully migrated
local PG16 database. Its receipt records 4,000 observations with 90% presence
(466–467 logical bytes) and 10% messages (2,095 bytes). Catalog queries fall
from 4,000 to 500, with all 4,000 parser calls, result counters and cursor values
preserved. Measured runs were 1,601 ms versus 453 / 431 ms; inline runs made zero
catalog queries. These are local fixture timings, not production CPU forecasts.

First and final batched EXPLAIN plans execute eight keyed catalog probes and
eight keyed JSON-body probes, each returning at most one row, with 48 shared
hits and no temporary I/O. Empty partition scans have zero executions. The
rejected deep-page prefix rescan is absent. These findings support the narrower
batching design, but do not remove the custody blocker in the current diff.
