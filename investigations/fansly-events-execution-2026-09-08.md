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
| A0 + T0 | [PR164](https://github.com/goslingmanagment/core/pull/164) merged; Decision 284, not deployed | Narrow read operations precede the retained September 1–6 export; runtime shadow >=7 full days on all six pages is not started. Physical-attempt savings unmeasured. |
| C1 | [PR166](https://github.com/goslingmanagment/core/pull/166) draft, Decision 287 | Three-branch diagnostic code tested/reviewed; production timeline and narrow policy fix pending in this PR. |
| C2a | [PR165](https://github.com/goslingmanagment/core/pull/165) merged, Decision 285; not deployed | A-B-A/replay/stale-ordering tests pass; production replay/repair remains separately gated. |
| C2b | Shadow implementation tested and independently reviewed, Decision 289 | Atomic semantic dirty, independent endpoint receipts and restricted report; daily rotation unchanged. Production deployment/enablement and measurements pending. |
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
gates. No A0/T0 production clock has started. This record grants no production
action.

C2b is prepared in [its stage record](fansly-c2b-earnings-shadow-2026-09-10/STATUS.md)
and [runbook](../docs/runbooks/fansly-earnings-shadow.md): 3190 passing unit tests
and 57 real Docker-Postgres checks, no production measurement. Main PR168 took
Decision 286; C1/W0 drafts were synchronized and renumbered 287/288. Their
previous heads had green CI; CI reruns on the synchronized heads. These code
milestones do not pass the calendar, activity, freshness or live socket gates.
