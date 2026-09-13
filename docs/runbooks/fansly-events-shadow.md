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

The SQL calls are also available from ordinary read_only psql:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT fansly_events_measurement_report(
  '2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z'
);
COMMIT;
```

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

## Rollback

Through the normal owner-approved Configuration save, set this allowlist to
`none` (or remove only the approved page). Verify all roles. An interrupted
shadow sweep stays incomplete and its business cursor continues unchanged;
reports and captured material remain. Do not reset a cursor, change cadence,
replay history or drop migrations to disable diagnostics.
