# Fansly events migration — execution record

Authority: [plan](fansly-events-migration-plan-2026-09-07.md), its adjacent
reviews, and [cross-check decision](fansly-events-cross-check-2026-09-07/DECISION.md).
Owner calls from the implementation chat are incorporated into the plan.
The original ignored research files are preserved locally; the versioned copies
and evidence now live in `investigations/`.

| Stage | State | Measurement / next gate |
|---|---|---|
| Pre-A0: stale follow-up + lilly-2 debt | PR157 deployed; one ari known head verified in archive; second ari target unresolved; lilly-2 recovery not activated by this migration task | Historical ari exact capture 188.695 s after canary activation; source/serving acceptance and separate lilly-2 activation gate remain open. |
| Pre-A0: reply links / honest sweep | PR158/159/160/161 deployed; 266/994 original reply IDs verified across timestamped reads; lora-1 140/143, both Lilly scopes paused | First PR161 exact read still 503 in 14.545 s. One approved plan-only diagnostic completed 9 Sep 17:34 UTC. Separate tombstone lookup fix (Decision 282) passed local validation (122 Docker-Postgres tests and pnpm check); independent review and a new deploy yes remain required. |
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

No physical-attempt savings or fresh-event latency distribution has been measured;
the >=50% goal is not claimed. Earlier replay confirmation bounds were 14m39s
from write start for ari, 7m05s for lora-3 and 4m20s for lora-2. These are sampled
repair bounds, not fresh-event percentiles. The latest successful PR161 sync-health
deploy gate took 105.498 s after two 150-second client timeouts; latency remains
unresolved. Serving counts retain their original timestamps, not a fresh atomic
994-ID census.
Provider deletion head repair is explicitly outside A0; A0 counts that
discrepancy. Events missed during outages, old edits/deletions, quiet-state
freshness and Management Session WebSocket scope remain unproven as in the plan.

The [reply runbook](../docs/runbooks/fansly-dm-reply-repair.md) retains the original
per-page acceptance gate. The owner's remaining Lilly reply replay permission
persists, but the original lora-1 cohort must pass first. The one-use plan-only
role exception is exhausted and does not change standing read_only access.
Current query evidence: [Decision 282 reproduction](agent-transcript-tombstone-2026-09-09/REPORT.md).
Operator evidence for the prior replay/deployment is retained under
fansly-five-page-reply-replay-2026-09-08/ and fansly-pr161-deploy-2026-09-09/ in the
main workspace. No repeated v6 replay is authorized as a workaround for a serving
timeout. Activating head recovery, live socket probes and A1 remain separate
gates. No A0/T0 clock has started. Nothing in this record authorizes a production
action.
