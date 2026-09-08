> Generated 2026-09-08 from docs/generated/REGENERATION-PROMPT.md at commit 92751418.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Capture and canonicalization

This map describes the shared observation-to-event engine and its OFAPI receipt
and recovery entrypoints. Source paths below are relative to the repository root.

## Observation identity and retained bodies

`packages/db/src/repositories/observations.ts` owns durable inserts, observation
keys and replay selection. `findObservationByKey` resolves the original journal
row through `(source, idempotency_key)` and its exact partition coordinate
`(observation_id, received_at)`. Observation identity and domain-event dedup
identity are separate. Replay selection uses qualified observation IDs and
parse-version, source/kind, account and received-time filters.

`apps/runtime/src/services/payload-reader.ts` resolves the retained body before
the driver calls a family's shape gate or canonicalizer. An unavailable capture
body leaves the observation unstamped and increments `skippedUnavailable`.
`parse_version` records consumption by a parser version; a traversal cursor does
not mark observations consumed. Unknown kinds outside the registry remain
available for future support.

## Shared driver and registry

`apps/runtime/src/services/canonicalize-driver.ts::runCanonicalization` serves
live exact-observation work, the background sweep and `events:replay` in
`apps/runtime/src/cli.ts`. `canonicalize/index.ts` declares these families:

| Source | Lane | Version | Kinds | Append mode |
|---|---|---:|---:|---|
| ofapi_capture | read_collections | 1 | 1 | projection-only |
| ofapi_capture | ofapi-posts | 8 | 1 | projection-only |
| webhook | ofapi | 5 | 30 | mixed |
| pull | posts | 8 | 2 | projection-only |
| pull | sync | 5 | 5 | mixed |
| pull | stats | 2 | 11 | projection-only |
| pull | engagement | 1 | 1 | projection-only |
| pull | catalog | 3 | 10 | projection-only |
| pull | comments | 1 | 1 | projection-only |
| pull | payouts | 1 | 2 | projection-only |
| command_result | result | 1 | all | deliverable |
| client_capture | desktop | 2 | 13 | deliverable |

These counts are parser coverage, not provider catalog size or configured webhook
subscriptions. The OFAPI family delegates content facts and async lifecycle facts
to their shared parsers. Its shape gate leaves unrecognized content observations
pending. The retained OFAPI-post family additionally requires minimum parse
version 7 and accepted-post context from the attached ledger.

The driver loads current page references and historical OFAPI custody. Conflicting
ownership is held back; live intake does not guess a page for such a fact.
Append operations use `packages/db/src/repositories/domain-events.ts` for
per-account sequencing and dedup. Projection-only and mixed families use their
corresponding checkpoint-aware append paths. The partition gate refuses appends
into unattached target months. Applicable material writes acquire erasure fences.

Invalid or implausible event dates fall back to observation receipt time with
`occurredAtRaw` and `occurredAtClamped` evidence. Keys are constructed before this
clamp. A failed row does not prevent later rows in its page from being attempted.
Append can commit before a later parse stamp fails; retry resolves the existing
event through its dedup key before completing the stamp.

## Immediate OFAPI processing

`ofapi-webhook-capture.ts` and `ofapi-webhooks.ts` verify and retain signed inputs
before acknowledging them. The durable `ofapi.events.process.v2` queue in
`ofapi-events.ts` processes receipt IDs. Settling allocates the legacy fanout
identity and commits its notification before post-settle consumers run.

Post-settle work includes command correlation, DM archive and hot projection,
subscriptions, presence, spend, account health and async lifecycle. The worker
then resolves an accepted receipt's observation and invokes `runCanonicalization`
with that exact ID and kind. This uses the existing queue; there is no separate
`canonicalize.observation` queue. Typing is outside the 30 canonicalized kinds.
A driver exception is logged with the receipt ID and fixed deferral message;
retained debt remains replayable. Reprocessing a settled accepted receipt can
repair debt without allocating a new legacy SSE identity or sending a provider
request. Operational projections and canonical facts have separate completion
states.

## Bounded recovery traversal

The minutely `canonicalize.sweep` processes 200 rows per page, at most 20 pages
per family, with a 600,000 ms run budget checked between pages/families. Family
rotation is process-local. Each family's traversal persists in
`canonicalize_sweep_cursors`, introduced by migration 0171 and accessed through
`packages/db/src/repositories/canonicalize-sweep.ts`.

The key contains a readable source/lane/version prefix and a SHA-256 of the
version floor, minimum version and query scope. Each completed attempted page
advances `after_id` with a revision compare-and-swap. A stale writer cannot
replace another traversal's progress or undo its wrap. A restart can repeat an
unfinished page. End-of-scan wraps to the head so skipped evidence can be tried
again; no fact is stamped merely to advance the cursor. Exact, CLI and dry replays
bypass durable cursors. `resetCanonicalizeSweepRuntime` resets only process-local
rotation, as used by restart regression tests.

`projections.dm-reconcile.sweep` is a separate minutely job for DM reconciles;
its work is not behind the canonical sweep's wall-clock budget.

## OFAPI delivery-history recovery

`ofapi-webhook-recovery.ts` captures each free provider delivery-history response
before validating attempts. New closed windows include complete boundary seconds:
start `.000`, inclusive end `.999`. A legacy scan resumes its original stored
wire bounds and offset. Validation admits only timestamps from the first through
last boundary second. A truly escaped page retains its raw capture and old offset
with `history_window_failed`.

Provider attempt IDs identify attempts; delivery UUIDs connect repeated attempts.
History success, local receipt, canonical state and operational projection state
remain independently visible. Remote redelivery is a separate owner action with
one-attempt semantics. `docs/runbooks/ofapi-webhook-recovery.md` holds operational
checks and the prepared repair of current-account debt; Decision 276 records the
production evidence and architectural choice.
