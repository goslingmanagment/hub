# Fansly C2a: earnings snapshot identity and projection repair

Authority: Decision 285 and the accepted Fansly events plan §6. This runbook
prepares operations; it does not authorize a deployment, replay or rebuild.

## Behavior and compatibility

Only `fan_earnings_stats` and `fan_earnings_monthly` move from pull/sync v6 to
pull/earnings v7. The minutely canonicalizer consumes their existing parse debt
once the updated worker runs. It prioritizes unparsed captures. DM and purchase
history keep v6; their kinds have not acquired new parse debt.

Each valid fan/window in one observation has one v2 earnings identity. A later
A after B applies even when an earlier A exists. Replay of that same observation
is idempotent. SHA-256 describes content separately from receipt identity.
The projection orders by observation time, then observation ID for timestamp
ties; event allocation order during replay cannot replace a newer receipt.
Legacy rows with an unknown tie-breaker resolve their exact source event by ID
and timestamp. If that event is unavailable, an equal-time overwrite is refused;
a strictly newer receipt can still apply. A scoped rebuild resolves retained
receipts without an unbounded ledger backfill in the migration.

New v2 events are projection-only with atomic checkpoints. Historical v1 events
remain deliverable because their original ledger positions lack checkpoints.
Both live and replay readers use this version-aware rule. No ledger rewrite or
weakened gap validation is part of this change.

Provider totals remain mills and are not calculated from local transactions.
An explicit provider zero is a valid snapshot. An empty historical array carries
no fan/window identity; it cannot prove a zero for an existing row. Malformed
money does not become zero: malformed or partially invalid observations stay
below v7 with fixed-code rejection samples. A valid empty array is parsed but
provides neither a monetary row nor a successful per-fan refresh receipt. A late response with an older observation timestamp
is rejected by the projection. A provider response with no source version/time
cannot establish an ordering stronger than local receipt order.

`observed_at` is the selected snapshot's observation time, not a new
`last_changed_at` or a successful two-endpoint check receipt. C2b owns operational
`last_checked_at`/`last_changed_at`, partial-result receipts and semantic dirty
revisions. Daily spender rotation, two endpoint calls and selection stay as-is.

## Deployment and bounded repair

1. Record exact approved revision, affected pages, raw/parse-debt counts,
   projection rows, capture health and the current image. Existing A0-only
   deployment targets PR164's merge, not an unreviewed later main revision.
2. Prepare and test a compatible rollback image before requesting this deploy.
   It must retain the new version-aware event readers and additive schema.
   Revert the earnings producer/projection changes only if rollback is needed.
   Returning the whole application to a pre-C2a image after v2 emission is not
   compatible: that reader would deliver a hidden row before its checkpoint.
3. With explicit approval, apply the additive migration and bring up the updated
   API first. Verify readiness and version-aware SSE replay before starting the
   updated worker. Worker startup activates v7 reparsing; it is not inert.
4. Use the existing `events:replay` command with both `--kind fan_earnings_stats`
   and `--kind fan_earnings_monthly`, an explicit `--account`, and a recorded
   received-at window. Start with `--dry-run`; it reads application state and
   belongs to this approved operator workflow, not the read_only agent plane.
   Cover all retained windows, retain each result, and account for detached
   partitions, rejected/errored rows and parse debt before declaring replay done.
   The normal worker and explicit replay share idempotent observation identities.
5. After a separately approved write replay, compare the last valid retained
   provider snapshot per fan/window with projection values and source receipt.
   Re-run a bounded read check after the projection watermark catches up. Do not
   turn one fan's latest timestamp into page-wide freshness evidence.
6. If mismatches remain, approve a page-scoped
   `projection:rebuild fan_earnings_stats --account <id>` separately.
   This resets
   only rebuildable rows/watermarks; readers can see an incomplete projection
   while it replays. Preserve observations, domain events and dedup keys.
7. Retain before/after mismatches, original and final receipt IDs, money values,
   replay totals and failures. No production A→B→A incident or completed repair
   has been established by the local regression tests.

## Rollback and remaining gates

Stop the new emitter through the approved compatible code rollback; keep all
captured facts and v2 readers. Restore ordinary daily rotation if a later stage
changed it. Pending receipts/revisions from later stages must not be deleted.
Do not repair money by direct SQL writes. Production diagnostics use read_only
inside READ ONLY transactions; privileged replay/rebuild commands require their
own explicit approval. C2b/C2c, A1 and live WebSocket work retain their gates.

## Retained snapshot audit (Decision 314)

Deploy the additive readers 0187–0189 through the normal reviewed release,
preserving all currently deployed source and migrations. No new flag is needed.
The reserved `0186_ops_metrics_recent_series.sql` must be included and applied
before 0187, or its reservation must be resolved before the audit release.
Do not apply 0187 and add an unapplied 0186 later: the migration runner requires
an applied prefix of the sorted files and rejects that ordering.
The local exporter uses SSH only to run psql as read_only in the existing
`agency-hub-postgres-1` container. It does not call Fansly or change stored data.

Run once per page, with an explicit range covering its retained captures and an
end timestamp already in the past. The output directory must not exist:

```sh
pnpm exec tsx scripts/fansly-events/export-earnings-audit.ts \
  "$FANSLY_AUDIT_SSH_HOST" "$FANSLY_AUDIT_PAGE" \
  "$FANSLY_AUDIT_FROM" "$FANSLY_AUDIT_TO" "$FANSLY_AUDIT_OUTPUT"
```

Use the same received-at range when comparing a bounded recheck. Each page's
export has its own database snapshot; successive exports are not additive or
one atomic agency-wide census. The transcript starts with the actual role,
READ ONLY/isolation receipt and transaction time. Subsequent batches bind both
the database snapshot and transaction time, and preserve microsecond cursors.

After forward migrations 0190–0191 (Decision 317), PostgreSQL 16 compressed
inline and CAS bodies can be read. A private raw-length helper bounds each copy
to 64 KiB before decompression, equality or parsing. CAS catalog size and access
are checked before body lookup. An unvalidated PostgreSQL major version fails
closed at installation and on every observation-reader call.

The sanitized parser input is also limited to 64 KiB, 512 array elements and
256-byte identity strings. Numerics outside absolute value 1e100 or scale 100
remain `shape_limit`: compact binary numerics must not expand into unbounded
text. Unused fields are withheld before serialization. These are audit limits,
not changes to the production parser.

Each statement returns at most 100 rows. Up to eight statements travel in one
network exchange, with at most 8 MiB per JSON line including its newline and
64 MiB per group before parsing. Up to 200,000 fan/window keys and 10,000 pages
per plane are allowed. Each statement stops after 15 seconds, lock waits after
one second, and the local SSH session and remote psql each have a 120-second
limit. Remote timeout escalates to a kill after one second. Incomplete response
groups retain only the previously written prefix and never produce a report.

Check `manifest.json` before using `report.json`: `completed` must be true, and
SHA-256 of `snapshot.jsonl` must equal its `sha256`. A completed export is not
necessarily a successful audit. `verified` also requires at least one matched
fan/window, current parser stamps, projector catch-up, no scoped detached rows,
no unavailable/rejected captures and no nonmatching projection outcomes.

Amounts are provider mills. The report retains original/projected observation
and event IDs, exact differences, counts and up to 100 nonmatching samples.
The complete normalized source records remain in `snapshot.jsonl`; all output
files are private. No provider response is reconstructed from transactions.

Interpret `projection_pending` with the actual sequence watermark, then recheck
after normal processing catches up. `outside_cohort` means a projected source
falls outside the selected range. Historical `compressed_body`, current storage/size failures,
unresolved receipts and detached rows prevent verification; do not replace them
with zero, an empty payload or a successful check. Empty arrays identify no fan
and establish no freshness. Explicit replay/rebuild remains a separate gate.

Rollback can stop using these readers while preserving their additive migrations.
This audit does not change the C2b/C2c, A1 or WebSocket gates and cannot establish
physical HTTP savings, quiet-correction coverage or fresh-event latency.


If the read_only role is at its connection limit, record the incomplete manifest
and wait for the other bounded diagnostics to finish before retrying. Do not
raise the role limit. Run pages serially with a fresh output directory and
cutoff, and retain the earlier attempt as separate evidence. First deployment
readback: three exports completed, only Ari-1 verified; three attempts were
incomplete. This is not C2a acceptance for the whole agency.
