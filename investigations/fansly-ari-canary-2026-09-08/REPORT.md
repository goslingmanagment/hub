# ari-1 head catch-up canary — 8 September 2026

The bounded canary is finished and the flag is back to `none`. It recovered one of the two original targets; the other remains explicit unconfirmed debt. This is partial production evidence for the pre-A0 repair, not completion of that prerequisite or of the events migration.

Production runs `b47f552abb97`. The implementation and its independent reviews are in [PR #157](https://github.com/goslingmanagment/core/pull/157) (head debt, Decision 277) and [PR #158](https://github.com/goslingmanagment/core/pull/158) (reply material, Decision 278). The [deployment report](../fansly-pre-a0-deploy-2026-09-08/REPORT.md) records their deployment and earlier measurements.

## Activation and rollback

The owner approved only `ari-1` for 60 minutes and its subsequent return to `none` in this task. `fanslyDmHeadCatchupPageAllowlist` was saved as `ari-1` at 12:33:25 UTC. Rollback was due at 13:33:25; the actual save call started at **13:33:34 UTC**, nine seconds late, and completed at 13:33:35. Thus the save-to-save interval was 60 minutes 9 seconds. The window was not extended for another recovery attempt.

The authenticated Configuration UI used its normal current-version CAS; no version was guessed and no conflict appeared. Fresh UI verification at 13:35:16 showed shared running `none`, editor `none`, disabled Save and no pending marker. API, scheduler and worker were active, with respective heartbeat times 13:34:12, 13:34:11 and 13:34:24. These are verification observations, not an exact timestamp of every worker's internal application. See [rollback evidence](evidence/rollback.txt).

No lilly-2 activation, budget/checkpoint change, restart, manual replay, socket probe or migration-stage activation was performed during the canary. The existing collector and automatic reply replay continued.

## Exact targets and coverage

| Original target | Result |
|---|---|
| Conversation `953353803074117634`, message `953354621215076352` | Exact raw capture at 12:36:33.695; hot-writer receipt at 12:36:33.704704. Recovery took 188.695 seconds from activation to raw capture. Hub returned the exact ID at 13:34:47 from `page_dm_messages`. Source observation remains at parse version 0; archive acceptance is pending. |
| Conversation `952822347599994880`, message `953208142580178944` | Zero matching raw receipts since 7 September; no unavailable bodies in this scoped query. Four completed unconfirmed reads; retained `backoff`, next retry 14:00:26.396, after the canary. No fifth attempt was forced. |

The four responses for the unresolved conversation contained the same eight other IDs. The two captured list responses contained its group but yielded no nested `lastMessage.id`. This does **not** establish provider-side deletion. The retained debt remains visible. See [returned source IDs](evidence/target-observations-1330.txt) and [final debt/raw check](evidence/status-final.txt).

Four ordinary heads arriving during the window were also captured. They are not additional recovered original targets. Three pre-existing ari debts remain excluded with `partner_missing_from_aggregation_accounts`; two also have unresolved identity and pending backfill. Exclusions were not silently dropped.

The separate, original fixed raw-ID cohort now has ari-1 **64/64 captured**, versus one missing before the canary. It is distinct from the broader known-debt set, so that result is compatible with the additional unresolved target above. Lilly-2 has **2,045 missing / 5,615**, versus 2,371 at 12:22 UTC. Lilly-2's improvement is ordinary collection: its new recovery path was never enabled. Other fixed-cohort missing counts: lilly-1 4, lora-1 1, lora-2/3 0. This is capture coverage, not an archive census. See [fixed-cohort evidence](evidence/fixed-cohort-final.txt).

Both final Hub reads returned `delivery_not_exhausted` with mutable-sort/no-frozen-snapshot caveats. The unresolved query returned a different archived ID, which was not credited as the target. Positive exact-ID evidence for the recovered target is retained without claiming exhaustive absence or archive parity. Full capture/delivery metadata is in [serving evidence](evidence/serving-final.json).

## Requests, runtime and replay

One worker-log export covers 12:33:25–13:35:30 UTC. Completed ari summaries were deduplicated by run ID; there were 15 summaries, zero duplicates/conflicts and no observed activation/rollback-straddling summary. Counts below end at the actual rollback save.

| ari-1 operation scope | HTTP attempts | HTTP retries | Failures |
|---|---:|---:|---:|
| DM messages | 9 | 0 | 0 |
| Conversation lists | 4 | 0 | 0 |
| Other ordinary streams | 15 | 0 | 0 |
| Total recorded completed summaries | 28 | 0 | 0 |

DM chunks reported zero 429s. Their nine fetches match the nine captured DM observations. The total includes ordinary heads and cannot all be attributed to the two-target repair. An uncompleted run without a summary is outside this evidence. These stdout counters do not replace the planned fleet-wide T0 aggregate or supply a comparable baseline. **HTTP savings and latency percentiles were not measured.** Method and per-run counters: [measurement notes](MEASUREMENT-NOTES.md), [worker summary](evidence/worker-final-summary.json).

All three containers remained healthy at `b47f552abb97`, with zero restarts and 31 GiB free; final loopback health was OK at 13:35:59. The collected worker log had no error-level entries. However, 13 projection-duration warnings included a maximum tick of 353.626 seconds, dominated by `message_archive` at 309.875 seconds. The last recorded warning at 13:27:12 was still 147.081 seconds. Healthy processes do not establish freshness, and attribution of this global load to the canary is not established. See [runtime evidence](evidence/runtime-final.txt).

Concurrent sync-pull v6 reply replay at 13:34:58 had **69,123 parsed / 298,491 pending** observations across its five kinds. The DM subset was 19,190 parsed / 49,735 pending. This is workload progress, not proof that all reply links are repaired. The canary target's parse version 0 and hot-plane read make its remaining archive lag concrete. See [replay evidence](evidence/replay-backlog-final.txt).

## What the tests prove

No implementation changed for this flag-only canary. Before their PRs, both changes passed `pnpm check`, Docker PostgreSQL integration suites and independent review; all findings were fixed.

- #157: 3,099 unit tests passed in 280 files, nine existing skips; **66 integration tests in seven files, zero skips**. Covers stale known heads, old targets behind overlap, chunk resumes, five-page bounds, bursts beyond 125 messages, initial backfill, external receipts and rollback continuity.
- #158: 3,103 unit tests passed in 280 files, nine existing skips; **55 integration tests in seven files, zero skips**. Covers real database driver/ledger/archive behavior, reply parent/root clocks, stale material, explicit clears, legacy shadow lifting and unchanged OFAPI behavior.
- Both passed lint, build and the strictness ratchet with 1,908 existing type errors within its budget. This was not a zero-error TypeScript run. Both PRs had five green CI checks and independent review before merge.

These tests prove the specified implementation behavior under controlled cases. They do not prove complete production recovery, event coverage or unchanged freshness.

## Migration state and remaining gates

| Stage | State | Measured savings / latency | Remaining evidence or owner gate |
|---|---|---|---|
| Pre-A0 P1 stale head | #157 deployed; ari canary finished, partial acceptance | No savings measurement; one exact recovery in 188.695 s | Unresolved target classification and archive acceptance |
| Pre-A0 P1 lilly-2 queue | #157 deployed; recovery off | Not measured | Separate owner yes for a bounded activation, refreshed baseline and freshness assessment |
| Pre-A0 P2 reply links | #158 deployed; automatic replay ongoing | Not measured | Complete replay and source-to-serving acceptance |
| A0 + T0 | Not started | Not measured | Close prerequisites; offline retained-raw report, inert shadow implementation and at least seven full days across all six pages |
| C1 | Not started | Not measured | Followers trigger RCA and independent narrow PR after A0 begins |
| C2a | Not started | Not measured | Earnings snapshot identity/replay correctness |
| C2b | Not started | Not measured | Semantic dirty shadow with existing daily rotation |
| C2c | Not started | Not measured | Proven quiet-correction coverage and accepted max-age before activation |
| W0 | Not started | Not measured | Management Session scope/transport evidence; separate approval for live probes |
| B0 | Not started | Not measured | Capture-only receiver, transport gates and durable shadow |
| B1 | Not started | Not measured | Proven event types, coalescing, budgets, history and freshness gates |
| A1 | Not started | Not measured | Own A0/T0/freshness gate and explicit owner yes; no default freshness degradation |
| B2 | Not authorized | Not measured | Separate decision; not built |

The unresolved provider head is not relabelled as deleted or repaired. Provider deletion remains a discrepancy category for A0, per the owner's decision. Production cases with nonempty attachments, full reply corpus parity, stale/clear repair and failure/restart behavior remain uncovered by this short canary. No event latency or ≥50% savings goal is claimed.

The next production expansion requires a separate lilly-2 approval after reviewing remaining freshness and prerequisite evidence. No further production change is scheduled by this canary. PR #157 now contains the verified canary result. This canary heartbeat was paused at 13:41:07 UTC; the broader migration remains unfinished.
