# Fansly events migration — execution record

Authority: [plan](fansly-events-migration-plan-2026-09-07.md), its adjacent
reviews, and [cross-check decision](fansly-events-cross-check-2026-09-07/DECISION.md).
Owner calls from the implementation chat are incorporated into the plan.
The original ignored research files are preserved locally; the versioned copies
and evidence now live in `investigations/`.

| Stage | State | Measurement / next gate |
|---|---|---|
| Pre-A0: stale follow-up + lilly-2 debt | PR157 deployed; Lilly-2 one-hour canary completed and rolled back | Frozen Lilly-2 5615/5615 raw; canary had 0 eligible targets / 0 recovery attempts, 104 excluded debts unchanged; 8/8 selected material passed after rollback. Separate old Lilly-1/Lora-1/Ari discrepancies remain explicit. |
| Pre-A0: reply links / honest sweep | PR158–162 deployed; original bounded corpus accepted | 994/994 reply IDs, 2893 observations, 27 attached messages across separately timestamped reads; not an atomic census or fresh-event latency claim. |
| A0 + T0 | PR164 deployed; shadow active since 10 September 22:58:33 UTC | T0 and historical comparison retained. Earliest seven-day point: 17 September 22:58:33 UTC. Unknown material checks and incomplete comparisons remain outside acceptance; savings unmeasured. |
| C1 | [PR166](https://github.com/goslingmanagment/core/pull/166) draft, diagnostics running | 3205 unit / 70 Postgres tests pass. One valid no-request receipt; protected deploy gate failed. RCA and narrow fix remain open. |
| C2a | PR165 code observed in production main 32478124 on 11 September | Replay completion and projection repair have not been verified here; no additional replay authorized. |
| C2b | PR169 merged; code observed in production main 32478124 | Enablement and measurements not verified; daily rotation remains the required policy. |
| C2c | Gated | Coverage, costs and per-fan max-age proof before selection/rotation changes. |
| W0 | [PR167](https://github.com/goslingmanagment/core/pull/167) draft, Decision 288 | Offline diagnostics tested/reviewed; live Management Session binding, fan-out, presence and six-hour continuity still gated. |
| B0 | Gated by W0 | Capture-only receiver, >=7 days with sufficient event variety. |
| B1 | Gated by B0 and T0 | Measured delivery lag, added attempts and history fairness. |
| A1 | Owner/calendar/evidence gated | Separate yes after A0/T0 scope and freshness gate. |
| B2 | Not authorized | Separate owner decision required; build only if B1 measurements justify it. |

No physical-attempt savings or fresh-event latency distribution has been measured;
the >=50% goal is not claimed. Historical reply-repair bounds for Lilly-2/Lilly-1
were 50m52s/66m40s from write start; these are sampled repair bounds, not fresh-event
percentiles. All earlier failures and intermediate mismatches remain in the
operational evidence. The one-use privileged plan-only exception is exhausted;
ordinary production diagnostics still require read_only in READ ONLY transactions.

The canary returned its single flag to none on all roles by the 10 September
16:30:12 UTC verification; its automation is paused. Zero eligible workload
means recovery efficacy and latency were not measured. No replay or repeated
recovery activation is implied. See the [A0 implementation/evidence record](
fansly-a0-shadow-2026-09-10/STATUS.md) and [shadow runbook](
../docs/runbooks/fansly-events-shadow.md).

Provider deletion head repair is outside A0; A0 counts discrepancies. Old
edits/deletions, mutable-offset omissions, quiet-state freshness, outage gaps,
archive/serving completeness and Management Session WebSocket scope remain
unproven. A1, live socket probes and B2 retain their separate owner/evidence
gates. A0 observation is in progress; elapsed time alone does not pass its
acceptance gate. This record grants no production action.

The source observed on production at 11 September 00:33 UTC was `32478124`,
not the original A0 image. The intervening deployment was not performed in this
turn. Code presence does not certify replay, dirty-shadow enablement or stage
acceptance. C1 was synchronized with that main and numbered Decision 291;
W0 remains a separate draft. The current production preflight is retained in
C1's evidence directory. The A0 operational report records the intervening
release, 500ms material-check timeouts and the incomplete Lilly-2 comparison.

The owner-approved C1 source `d47dc9b09f87` replaced that runtime at
11 September 01:05 UTC. Its standard deploy exited 1 on protected sync-health;
automatic rollback was skipped after migrations 0182–0183 applied. The three
roles remained healthy with zero restarts at 01:34–01:35 UTC, and the CLI and
dashboard checks passed separately. C1's first retained decision is lora-3
with equal counts and no reconcile request. The six-hour observation now
retains C1 evidence too, preserving A0's original start and runtime boundaries.
See [C1 status](fansly-c1-followers-2026-09-10/STATUS.md) for the open gates.
