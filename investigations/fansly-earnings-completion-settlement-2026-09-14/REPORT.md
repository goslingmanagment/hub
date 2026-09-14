# Fix: settle a completed earnings generation once

The handler now reuses a fully completed checkpoint when settlement retries
its exact owning request sequence. It checks page/stream identity, the stored
sequence, an exact zero fan cursor, a valid completion timestamp and the current
lease. It issues no endpoint calls and does not rewrite the checkpoint or any
provider-read timestamp. The ordinary scheduler still settles the generation.

The fix is 14 added runtime lines, uses existing `cursor_seq` metadata and adds
no field, schema migration, flag, cadence cap or new scheduling policy. D331 and
the earnings shadow runbook explain the `reusedCompletedWalk` statistic and the
difference between scheduler settlement time and the original provider read.

The separate 200-line PostgreSQL suite covers eight boundaries: healthy same-slot
settlement, failed settlement/retry of the same generation, a queued newer
request, partial continuation carrying old completedAt, first-fan rejection in
a newer generation, absent execution context with an existing owned checkpoint,
expired ownership and removed checkpoint. The preserved negative reproduction
on original main confirmed two full endpoint sequences for one generation;
the corrected retry retains one sequence and an identical checkpoint.

| Validation | Result | Command wall time |
| --- | --- | --- |
| Original-code reproduction | 2/2 cases passed, demonstrating the gap plus a healthy control | 4.543s |
| Four serial Docker-Postgres suites | 39/39 passed, no skips | 10.378s |
| pnpm check | Strictness/lint/build passed; 3,580 unit tests passed, nine existing skips, 315 files | 48.043s |

Final local checks used main `ce0a44b0d6778f8bd371c105f26d31f9abe8b8bd`
plus the topic changes. The exact source/doc fingerprints stayed unchanged
through both final runs; PostgreSQL ended at 01:34:52.684979 UTC and check at
01:35:59.957061 UTC on 14 September. The initial reproduction stopped at a
wrapper-error assertion; its log is retained alongside the corrected assertion
against the original PostgreSQL cause. No failure evidence was replaced.

Commands, timestamps, exits and source hashes are in `evidence/*.json`;
`validate.py` captures the final check/PG receipts. Complete logs and original
reproduction test bytes are retained as deterministic gzip, with compressed
and decompressed hashes in `evidence/compressed-logs.json`. Original plain logs
remain local and are excluded from publication.

The adapter is a no-network response stub. The test harness invokes the actual
handler and real scheduler/settlement repositories, not the full worker entry
point. No production call or mutation was performed. This confirms one local
failure boundary; the cause of the historical Lilly-2 traffic, causal savings,
event-to-reader latency and C2c's freshness gate remain unproven.
