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
