# Fansly events migration — execution record

Authority: [plan](fansly-events-migration-plan-2026-09-07.md), its adjacent
reviews, and [cross-check decision](fansly-events-cross-check-2026-09-07/DECISION.md).
Owner calls from the implementation chat are incorporated into the plan.
The original ignored research files are preserved locally; the versioned copies
and evidence now live in `investigations/`.

| Stage | State | Measurement / next gate |
|---|---|---|
| Pre-A0: stale follow-up + lilly-2 debt | Green locally, independent review passed; branch `fix/fansly-dm-head-debt`, base `a6631a70` | Fixed raw cohort at 11:02:47 UTC: lilly-2 2,767 missing / 5,615 known; ari-1 1, lilly-1 4, lora-1 1, lora-2/3 0. Deploy and each page activation require separate owner yes. |
| Pre-A0: reply links | Pending separate PR | Text, attachment and existing-link fixtures; replay of retained evidence, separately approved on production. |
| A0 + T0 | Not started; prerequisites not exited | Offline retained corpus, then default-off shadow/report; runtime shadow >=7 full days on all six pages. Physical-attempt baseline remains unmeasured. |
| C1 | Not started | Diagnostic counts of the three anomaly branches before a narrow fix. |
| C2a | Not started | Earnings identity correctness, A-B-A/replay/stale ordering; retain repair plan. |
| C2b | Not started | Dirty/receipt shadow; daily rotation unchanged. |
| C2c | Gated | Coverage, costs and per-fan max-age proof before selection/rotation changes. |
| W0 | Not started | Offline fixtures; live socket probes need explicit approval. Management Session only. |
| B0 | Gated by W0 | Capture-only receiver, >=7 days with sufficient event variety. |
| B1 | Gated by B0 and T0 | Measured delivery lag, added attempts and history fairness. |
| A1 | Owner/calendar/evidence gated | Separate yes after A0/T0 scope and freshness gate. |
| B2 | Not authorized | Separate owner decision required; build only if B1 measurements justify it. |

No savings or event latency have been measured. The >=50% goal is not met.
Provider deletion head repair is explicitly outside A0; A0 counts that
discrepancy. Events missed during outages, old edits/deletions, quiet-state
freshness and Management Session WebSocket scope remain unproven as in the plan.

The pre-A0 [runbook](../docs/runbooks/fansly-dm-head-catchup.md) and
[read-only report](fansly-dm-head-debt-2026-09-08/report.sql) are the next
operational artifacts. Nothing in this record authorizes a production action.
