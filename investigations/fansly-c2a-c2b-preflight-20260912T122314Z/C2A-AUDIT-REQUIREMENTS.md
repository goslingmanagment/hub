# Remaining C2a verification

This specifies the missing acceptance read from the existing plan and runbook.
It is not a new rollout stage, an access grant or permission to run replay.
The current census closes only the measured retained parser backlog.

## Existing sources

- `parseFanslyEarningsObservation` is the source of valid fan/window aggregates,
  including breakdown, zero/negative mills and fixed rejection codes. Reuse it.
- `fan_earnings_stats` contains internal account/fan IDs, window, gross/net mills,
  currency, observed_at, source_event_id and source_observation_id.
- Native fan identity must be resolved within the same account/platform scope.
- `projection_seq_watermarks` is the actual earnings projector checkpoint;
  the legacy `projection_watermarks` table is insufficient.
- Raw bodies may be referenced through capture storage. An unavailable body
  must be a recorded failure of verification, never an empty or zero result.

## Required comparison

1. Freeze the retained observation cohort with an explicit received-at range,
   upper observation ID and account scope. Preserve partition inventory.
2. Parse retained bodies with the deployed v7 parser. Track empty, rejected and
   unavailable observations independently from successfully reconstructed rows.
3. Select the last valid complete snapshot per account/native fan/window by
   `(observedAt ?? receivedAt, observationId)`. Do not order by replay allocation.
4. Compare gross/net mills, currency, observation time and exact source receipt
   with the corresponding projection. Include missing/extra rows and the full
   zero/negative population; top-spender filters are unsuitable.
5. For legacy source_observation_id=0, resolve the exact original source event
   by source_event_id and occurred_at. Missing legacy evidence stays unknown.
6. Record the actual projector watermark and corresponding event bound.
   A changing live projection must not be compared silently to an older source
   cohort. Distinguish newer rows, in-flight projection debt and mismatches;
   use a bounded recheck once the source cohort has been processed.
7. Preserve original and final receipt IDs, mismatch counts, scope exclusions
   and coverage limitations. No per-page freshness or correction-latency claim
   follows from one fan's latest timestamp.

## Implementation and operating boundaries

The existing read_only grants cannot complete this comparison. The next
implementation must provide only the bounded earnings audit data needed above,
with explicit account/range/size limits and stable pagination. Do not expose a
general payload export, weaken the owner payload boundary or change rotation.
Choose the existing report/CLI conventions after inspecting current main.

Before any deployment, run pnpm check and the relevant real Docker-Postgres
suites, then close independent correctness and readability findings. Cases must
cover A→B→A, stale-after-fresh, equal-time receipt ties, legacy source ID 0,
zero/negative values, malformed/empty/unavailable bodies, missing/extra rows,
pagination boundaries and a projector still processing the frozen cohort.
Any explicit production replay or rebuild needs its separate scoped approval.
