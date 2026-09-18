# Fansly A0/T0 shadow (Decision 284)

A0 measures the existing full sweep. It cannot stop pagination, change the
business streak, certify membership, advance a scheduled slot or enqueue an
extra provider request. A1 and sockets have separate gates.

## Flag and deployment

`fanslyDmShadowPageAllowlist` / `FANSLY_DM_SHADOW_PAGE_ALLOWLIST` is live and
starts at `none`. Use explicit comma-separated page labels. Workers reload the
value at each chunk. Enable only after the approved inert deployment and the
historical corpus pass below. The first full sweep without a certified
predecessor is a priming measurement, not a zero-miss success.

The deployment adds migrations 0174–0177. The new table stores bounded
scalars, survives telemetry retention, and participates in explicit page
erasure. Two fixed SQL read functions are granted to the existing `read_only`
role; no base-table privilege, role, provider access or credential is added.
The source plan's historical pass requires retained request offsets. The
current production role cannot read those offsets. Deploying these inert read
operations is therefore necessary before exporting the September 1–6 corpus;
the offline pass remains a gate before runtime shadow activation.

Deploy, enable and rollback use separate owner-approved actions through the
normal deployment / Configuration paths, with current expectedVersion. Keep
all other flags unchanged. After deployment verify image revisions, health,
read-function access and running `none` on API/worker/scheduler. After an
approved enable, verify the same exact allowlist on all active roles and save
timestamps; the >=7-day clock is not the PR/merge/deploy time.

## Read and retain evidence

Use `HUB_READ_ONLY_DATABASE_URL` for the existing role through an approved
local connection/tunnel. Never put the URI in a committed file or command log.
The exporter verifies `current_user=read_only` inside every READ ONLY
transaction and sets a 20-second statement timeout. Every query window is
nonempty and at most eight days. An output path must be new.

```sh
pnpm exec tsx scripts/fansly-events/read.ts corpus \
  2026-09-01T00:00:00Z 2026-09-07T00:00:00Z /absolute/evidence/corpus.jsonl
pnpm exec tsx scripts/fansly-events/analyze-corpus.ts \
  /absolute/evidence/corpus.jsonl /absolute/evidence/sensitivity.json
pnpm exec tsx scripts/fansly-events/read.ts report \
  2026-09-10T00:00:00Z 2026-09-11T00:00:00Z /absolute/evidence/day.json
```

Replace report dates with the actual half-open window. Keep the output and
SHA-256 manifest outside the 30-day observability tables. Failed exports retain
`.partial`; they are not completed evidence. Exports are timestamped reads,
not an atomic census. The corpus exporter pins an upper raw ID and scans at
most 500 envelope IDs per query; only matching head metadata is returned.
Missing bodies, run receipts or completion proofs remain incomplete. Repeated
exports use different paths; do not concatenate overlapping windows as unique
attempts or sweeps.

### Compare retained HTTP windows (Decision 362)

Run the offline comparator on two completed `report` exports. Each report's
original `.manifest.json` must remain beside it. Inputs must be regular private
files (no group/other access or symlinks), at most 32 MiB per report and 16 KiB
per manifest. The output must be new; it is created with mode 0600. No database,
Fansly request, flag change or new collection is performed by this command.

```sh
node --import tsx/esm scripts/fansly-events/compare-http-cli.ts \
  /absolute/evidence/baseline.json /absolute/evidence/current.json \
  /absolute/evidence/http-comparison.json lilly-1 lilly-2
```

Choose the same explicit page cohort before comparing. The command verifies
exact file SHA-256, report/manifest dates, completed export ordering and the
manifest's **sweep count** (not HTTP attempts). All selected-page sources,
streams, operations and states contribute to the attempt total. Retry ordinals
and retry outcomes are separate subsets and are never added to that total.
Per-page, per-stream and per-source totals keep redistribution visible.
Nonzero submillisecond window boundaries are rejected instead of rounded;
microsecond timestamps in the exporter receipts remain accepted.

`eligibleForObservedCountComparison` requires equal, nonoverlapping, ordered
whole UTC-day windows (at most eight days each), closed before export started;
the same observed page ID for each selected label; coverage for each selected
page and attempt stream; and known zero run losses with no unfinished attempts.
Because the existing coverage export has labels but no page IDs, a page without
any attempt rows has unverified identity, even if coverage exists. Reused labels
and absent pages cannot silently become a comparable zero. Attempt source can
differ from its parent run source, so source equality is not a coverage test.

On incomplete evidence, a valid comparison artifact still records the observed
counts/delta and `blockers`, with a null percentage. Exit zero means the artifact
was written; inspect eligibility before interpreting it. Null loss sums are
unknown. Mixed known/null sums remain explicitly partial, with unknown runs and
null counter groups shown. Overlapping-run losses are never trimmed or assigned
to an attempt day. Boundary runs with complete zero losses are allowed. Missing
payload sizes do not invalidate request counts; bytes describe captured JSON,
not network egress or proxy spend.

Even an eligible negative `observedAttemptChangePercent` is an observed count
change, not causal savings. Check workload, activation/policy evidence and reader
freshness separately. This ledger excludes browser/bootstrap HTTP and WebSocket
traffic. The result always keeps `causalSavings=unverified` and
`readerLatency=unmeasured`; it does not close the migration's savings or latency
acceptance. Hash verification binds the retained pair but does not authenticate
its provenance. Keep the original read receipts with the evidence.

The SQL calls are also available from ordinary read_only psql:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT fansly_events_measurement_report(
  '2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z'
);
COMMIT;
```

## Current material-query cost (Decision 332)

`public.fansly_dm_shadow_material_probe(text, integer)` is an inert, on-demand
read operation. Migration 0192 grants EXECUTE to the existing `read_only` role;
it grants no table access and introduces no flag. One call selects the newest
1–100 visible, nonempty current head IDs for one named Fansly page, then runs
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the same typed VALUES, hot-message
EXISTS and head-debt join used by `readFanslyDmShadowMaterial`.

Set the deadlines **before** the function SELECT. The function rejects writable
or non-repeatable-read transactions, disabled/timeouts above the bounds below,
unknown/non-Fansly pages and sample limits outside 1–100. It accepts no SQL or
head IDs from the caller. The execution plan contains head identifiers and
database plan metadata, but no message bodies, usernames or credentials.

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '100ms';
SELECT current_user AS role,
  current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('lock_timeout') AS lock_timeout;
SELECT public.fansly_dm_shadow_material_probe('lilly-1', 100);
ROLLBACK;
```

Use the existing `read_only` connection; verify the identity receipt and retain
the raw output, command/source revision, timestamps and SHA-256 in a new private
evidence directory. Read the six explicit page labels serially, one call per
page, with an 8-second remote process limit (one-second kill grace), a 20-second
local outer limit per call and a 45-second overall budget. Stop on a failed call
or exhausted budget; remaining pages are unmeasured. A timeout is unknown cost,
and `no_sample` returns a null plan, not a zero-duration success. Do not retry
to obtain a prettier number. Apply this additive migration through the normal
reviewed deployment; application rollback may leave the unused function in
place. To stop measurement, stop invoking it. No polling configuration changes.

This is a biased sample of **current stored heads**, not provider responses at
the original pre-apply boundary. The sample can warm shared buffers before the
material query. EXPLAIN timings include instrumentation and exclude client/pool
waits, report writes, pipeline scheduling and reader publication. Its result
rows are not returned, so the plan is not a count of present heads. It establishes
neither archive/serving completeness nor event-to-reader p95/p99, and cannot
pass A0 or establish the 50% savings goal. Keep the original A0 clock and gates.

## Interpretation and acceptance

- `attempts` counts one `sync_http_attempts` row per physical request, grouped
  by page, stream, operation, source, UTC day, state and error. Retries are
  additional attempts, not duplicate transitions. Source falls back to the
  run source because existing attempt writers leave that column null.
- `httpCoverage` includes overlapping runs. Unknown/unfinished runs and lost
  insert/terminal receipts remain explicit. Loss counters for boundary runs
  cover the whole run; they cannot be assigned to an exact attempt time or
  silently folded into exact in-window totals. Open `started` attempts and
  unknown captured bytes must also remain visible.
- T0 covers instrumented sync HTTP. Browser/extension traffic and future WS
  handshakes are not in this baseline. Counts from worker summary logs are a
  different completion-window measurement. Do not claim total provider cost
  or >=50% savings from hypothetical list pages.
- `dmCoverage` independently reads run-event receipts. A missing shadow row,
  failed report write, failed run or missing receipt cannot disappear from the
  denominator. A row marked `complete` is only a completed observation.
  Disabled runs have no shadow receipt and remain unknown in this read. The
  gate additionally requires no unexplained discrepancies and adequate scope.
- `stopPage` includes its own request cost. Pages and captured-payload bytes
  below it are hypothetical savings. Runtime byte measurement uses the same
  trimmed capture object as T0; offline `retainedJsonBytes` uses PostgreSQL JSON
  text encoding and is a separate estimate, not wire/compressed bytes.
- `missingHotHeadsBelowStop` is an exact pre-apply check of non-deleted
  `page_dm_messages` IDs. It does not prove absence from archive or serving,
  nor text/media/link parity. Failed reads set `unknownMaterialChecks`.
- Material-lag samples use existing exact-ID head-debt receipts, first observed
  to captured, rounded upward to a millisecond. `materialLagSamples` and
  `maxDiscoveryToCaptureMs` describe known heads seen in that sweep; repeated
  sweeps can observe the same receipt. Zero samples means unmeasured. This is
  not provider-event-to-reader latency and cannot establish its p95/p99.
- Pending history is counted even when never synced. Its due-origin age is
  unknown: `unknownHistoryAgeCount` says so. `maxHistorySyncAgeMs` only measures
  time since the last history sync; it is not the age of pending work.
- Head rollback is a discrepancy category, not a deletion verdict or repair.
  Unknown markers, timestamp ties, guards/restarts and long gaps remain in the
  report. Delete+insert above a mutable offset can escape both full and virtual
  comparisons; the deterministic fixture preserves that counterexample.

Before any A1 proposal: export >=7 full days for all six pages, including
lilly-2; inspect incomplete/unknown/lost fractions and activity by type; explain
every discrepancy; retain K=1/3/5 × overlap=0/60s/300s sensitivity. A quiet week
is not coverage. No-op chunks and healthy processes do not prove freshness.
Keep the original polling freshness until a separate stop contract is accepted.

### Reason coverage in the A0 follow-up (Decision 313)

New runtime sweeps count all eleven pre-apply head-diff reason types. The two
unread reasons share one counter per conversation. `stateChangesBelowStop`
counts changed conversations, so it is not the sum of individual categories.
Rollback and material counters remain separate predicates.

Six added counters expose visibility, unresolved identity, exclusion reason,
subscription tier, effective head timestamp and effective sender differences.
Only measurement from the start of a runtime sweep initializes them to zero.
Starting diagnostics midway through a sweep leaves them null. A legacy
checkpoint missing one of these fields loads it as `null`; resume preserves that unknown value
through terminal persistence. A completed legacy sweep may therefore have
`status=complete` and null reason counters. Completion does not certify full
reason coverage, and old report rows missing those fields are also unknown.

The existing JSON report/export carries these scalars without a migration or
new flag. Group measurements by field availability and sweep start; never
coalesce absent/null counters to zero. This does not explain historical generic
counts retroactively or restart the original shadow clock. A1's completeness
and discrepancy gates still apply to the chosen measurement window.

Offline corpus comparison remains raw-to-raw. It cannot observe runtime
visibility, identity resolution or exclusion reason, so those three counters
are null. Its tier/time/sender counts describe retained metadata differences;
runtime time/sender comparisons use effective values after repair/fallback.
Neither comparison alone establishes a provider action or message loss.

Rolling back to the earlier parser drops the new fields from resumed cursors.
If the newer code resumes that generation again, the fields remain unknown;
it must not reconstruct their earlier history as zero. Saved terminal reports
and business cursor semantics remain unchanged.

## Advertised-head reader state (Decision 335)

New runtime observations retain the original hot counter and additionally count
Agent operation 6's exact advertised-head state before applying the provider
list page. The reader prefers `dm_message_archive`, then `message_archive`, then
hot; a scoped tombstone in any candidate source dominates. Pending content uses
the winning source's rule, not empty text. `captured_at` debt receipts do not
establish current reader presence.

- `readerHeadsChecked` and `unknownReaderHeadChecks` cover advertised IDs on all
  observed pages. Failed reads remain unknown; absence of an advertised ID is
  instead part of the existing invalid-marker accounting.
- `readerMaterializedHeadsBelowStop`, `readerMissingHeadsBelowStop`,
  `readerDeletedHeadsBelowStop` and `readerPendingHeadsBelowStop` classify exact
  IDs below the candidate stop. They are separate from head-metadata differences.
- `readerArchiveOnlyHeadsBelowStop` counts materialized IDs without a live hot
  copy. It does not prove pruning caused that state.

Absent/null fields on saved reports and resumed legacy cursors mean unknown,
never zero. Mid-sweep activation also leaves the new counters null. Current code
marks a finished observation incomplete when reader coverage is unknown. Group
reports by field availability and sweep start; preserve historical rows and the
original A0 clock without crediting earlier days to the new reader scope.
A complete row still requires explanation of every discrepancy before any gate
can pass. Missing, pending and deleted are observations, not automatic proof of
provider loss or a request to repair a head.

Flag `none` adds no queries. Enabled reads share one read-only repeatable-read
snapshot and a decreasing query allowance of at most five seconds or the dispatch
allowance left. Timeout/failure keeps the full business sweep running. Pool
checkout is not cancellable by this helper; its elapsed time consumes the query
allowance once acquired. Do not report this as an end-to-end five-second bound.

After normal deployment of 0194, measure its separate fixed SQL through the
existing `read_only` connection, with caller deadlines installed before SELECT:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '100ms';
SELECT public.fansly_dm_shadow_reader_probe('lilly-1', 100);
ROLLBACK;
```

Use the same once-only six-page order and external total deadline as the hot
probe above. Retain identity, transaction settings, exact command, raw result,
hashes and resource/timeout receipts; stop on the first failure and leave the
remainder unmeasured. No privileged fallback or automatic retry. `no_sample` and
a null plan are unmeasured. EXPLAIN samples current stored heads, which may warm
buffers and omit archive-only conversations with no stored thread. It is not the
original provider-list population. Keep 0192's hot-query measurements separate;
measure the new query after deployment before claiming its production cost.

These exact-ID counters do not measure a whole transcript, field parity or
provider-event-to-reader latency. They do not close A0's seven-day/churn/outage
scope requirements, move to A1, or establish realized HTTP savings. Rollback
keeps the existing allowlist procedure; old parsers drop new optional fields,
which remain unknown if newer code later resumes the same generation. The
additive unused probe may remain installed.

## Reader discrepancy witnesses (Decision 354)

New sweeps add `readerWitnesses` (first20 total per sweep) and
`readerWitnessesOmitted` to the existing `diagnostics` report/cursor. They cover
missing/deleted/content-pending/unknown reader states **below** the virtual stop,
including an advertised ID with a null embedded head. Aggregate counters remain
complete even after the sample cap. `null` means legacy or mid-sweep coverage;
`[]` with omitted0 means no witnessed candidates in that instrumented scope.
Omitted>0 means candidates lack retained witnesses, whether because of the cap,
a missing capture receipt, ambiguous mapping or unavailable hashing. It is not
zero unexplained discrepancy evidence. The first20 are deterministic, not a
representative sample or a completeness verdict. No message IDs/text are copied.

Each pointer carries an observation ID, canonical JSON v1 SHA-256, zero-based
index into the **trimmed retained** `data` array and one-based sweep page number.
`readStartedAtMs`/`readFinishedAtMs` are worker-clock bounds around the existing
pre-apply read, before hydration/repair/write; they are not the precise database
snapshot instant or event latency. `source` is the preferred reader source; for
`deleted` the dominating tombstone can come from another source. Unknown reads
have null source and liveHotCopy, not evidence of absent hot material.

Read the existing report view/function through `read_only` in READ ONLY. For
selected witnesses only, load their exact `observations` envelopes and current
bodies (`coalesce(o.payload,b.body)`; join hot CAS by bucket_month/object_id).
Use the existing `resolveDmShadowWitness(witness, pageId, observation)` helper
from `apps/runtime/src/services/sync/dm-shadow-witness.ts` on that local export.
It validates observation ID/account/platform/kind and recomputes the hash before
resolving the row. Missing body, wrong scope, changed hash or bad index is
unresolved. Never search another index on mismatch or trust the original
observation hash without checking the current body. Export only needed markers,
not whole message/account payloads, and keep original read receipts private.

Erasure may remove/rewrite capture, making the pointer unresolvable. Existing
shared-observation erasure policy can also preserve the original body; such
pointers remain resolvable residuals. This does not promise anonymization. The
existing page/model erasure already removes shadow reports and cursors.

The historical G6917/G6918 scalar reports cannot be retroactively attributed.
Their existing raw candidate is not proof of provider deletion or of an exact
historical reader miss. Keep them unknown; do not reset the original A0 clock or
credit earlier days to the new witness scope. Ordinary full polling collects
new evidence without extra provider requests. Rollback drops optional cursor
fields and later resumes remain unknown; saved reports are preserved.

## Rollback

Through the normal owner-approved Configuration save, set this allowlist to
`none` (or remove only the approved page). Verify all roles. An interrupted
shadow sweep stays incomplete and its business cursor continues unchanged;
reports and captured material remain. Do not reset a cursor, change cadence,
replay history or drop migrations to disable diagnostics.
