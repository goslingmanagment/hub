# Earnings rotation contract — audit finding 8

14 September 2026. Independent local source/evidence review only: no production reads, provider calls, tests or runtime changes.

**The scheduler already admits at most one new scheduled generation per page/assigned slot. This does not establish exactly one physical walk per slot. The proposed rolling `completedAt` guard is not a safe drop-in fix: it can suppress due reads and falsely complete an unfinished walk.** Keep daily rotation until the concrete duplicate-work case is identified and a focused change satisfies the criteria below.

## Source and existing contract

Reviewed runtime/repository files match main `b78752d0d1144a8457638ffb3ae0bda33455fde1` byte-for-byte in the dashboard composition worktree. Subsequent main `a9794e600dfbb10918800ab5b49241e33d7357a3` adds the test-only UTC fixture. Retained production source is `380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`; its relevant slot/earnings completion behavior is the same. D322 changes provider-cooldown handling, not the slot arithmetic described here.

- `packages/db/src/repositories/page-sync.ts`, policy around 279 and helpers around 1000: `fan_earnings` cadence is 86,400 seconds; its policy has no explicit freshness SLA. Slots are offset per page, not UTC calendar days. Page 5's offset is 7,195 seconds, so its boundary is **01:59:55 UTC**.
- `scheduleDuePageSync`, around 1886–1986, locks the stream rows in a transaction. An outstanding `requestSeq > appliedSeq` is retained rather than replaced by a new scheduled generation. When no work is outstanding, only `currentSlot > lastScheduledSlot` admits a generation, and admission atomically advances both `request_seq` and `last_scheduled_slot`. Repeated ticks in that assigned slot cannot admit another new scheduled generation. Several missed slots coalesce to the current slot; there is no queue of every missed daily slot.
- Explicit requests (`requestPageSync`, around 3037–3180) can create additional generations independently of that scheduler rule. Slot admission must not be confused with manual/recovery requests or chunk continuation.
- `apps/runtime/src/services/sync/fan-earnings.ts:52–178` walks the existing spender roster by a durable fan cursor, reading lifetime and monthly endpoints. Only reaching the end sets `walkCompleted`, resets the cursor to zero and records `completedAt`. Partial progress deliberately retains the **previous full walk's** `completedAt`.
- `apps/runtime/src/services/sync/executor.ts:667–715` settles the leased generation with `completePageSync` after the handler returns. Completion advances `applied_seq` and stamps success separately from the handler's checkpoint write (`page-sync.ts`, around 2392). A failure/crash between those operations can leave a reset cursor with an outstanding generation. A subsequent retry can begin again at zero. This is a code-level window requiring a focused reproduction; this review did not reproduce it or attribute historical traffic to it.

D285 preserves daily request selection while fixing observation identity. D289 preserves the daily spender walk during shadow and preserves full-completion history across partial progress. The [migration plan, section 6](../../fansly-events-migration-plan-2026-09-07.md) explicitly requires per-fan/window age and the last completed independent sweep: C2c changes rotation only after quiet corrections are detected within the previous bound, or after the owner separately accepts a new max-age. The [cross-check decision](../../fansly-events-cross-check-2026-09-07/DECISION.md), lines 113 and 153, retains the same daily-shadow gate. A daily cadence is therefore not permission to silently reduce freshness, nor proof of a hard 24-hour SLA.

## What the retained production evidence proves

The original [earnings lane](../lanes/D-earnings.md) describes a plausible delayed-slot mechanism. The retained `evidence/q9.sql` / `q9.out` count observations by hour, not generations or full-walk completions: Lilly-2 has **2,014 lifetime-stat observations on 12 September** (17:00–23:59 UTC). The [cost remeasurement](cost-remeasurement/REPORT.md) independently counts **4,028 physical fan_earnings attempts** that day and zero recorded attempts on 11 September, versus a 1–6 September mean of 2,010.33/day. These are different measures and must not be substituted for each other.

This supports uneven work across days. It does **not** identify two completed walks, their assigned slots, their request source/sequence, distinct fan coverage, or a particular restart's repeated chunk. The claim “two complete 1,005-fan walks plus four repeats” is not proven by these aggregates.

The scheduler permits the following explanation: generation N is admitted before a boundary, finishes late during slot N+1, and then generation N+1 is admitted. Both completions can fall in one UTC day, and even in the same execution-time slot, while the **assigned scheduled slots differ**. This is permitted by source, not established as the cause of the retained counts. The completion/settlement window above and explicit request generations remain alternative mechanisms to distinguish.

## Why the proposed rolling guard changes behavior

The audit proposes treating a scheduled dispatch as satisfied whenever `completedAt >= now - cadence`. That changes an admission-slot rule into a completion-time cooldown.

For page 5, consider a delayed older walk completing at 20:00 UTC on 12 September. A newly due generation can be skipped immediately; the 13 September 01:59:55 generation is also within 24 hours and can be skipped. The next eligible daily boundary is 14 September 01:59:55, almost **30 hours after completion**. The first fan in the older walk was read still earlier. This counterexample demonstrates later reads than the existing scheduler; it does not assert an already guaranteed 24-hour SLA. Simply waiting 24 hours after completion also does not prove per-fan age is preserved.

There is a second correctness hazard: executor yields default to `dispatchSource = "scheduled"` (`executor.ts:783–794`), including continuations of explicitly requested work. Since a partial walk carries the prior full `completedAt`, the guard can stop such a walk after its first chunk and declare the remaining cursor satisfied. `satisfied: true` without an explicit skip disposition also stamps stream success despite doing no read. Neither issue is solved by a calendar-day cap.

## Acceptance criteria before changing rotation

1. Define the capped unit explicitly: assigned scheduled generation, physical full walk, UTC day or rolling interval. Retain scheduled/manual/recovery provenance; a chunk's dispatch priority/source is not enough to identify the original request.
2. Establish the unwanted case from request sequence, admission slot, request source and completed-walk/cursor provenance. Hourly counts alone cannot distinguish delayed independent generations from repeated execution of one generation. No new production query is performed by this review.
3. Add deterministic Docker-Postgres cases for repeated/concurrent scheduler ticks; an old pending generation crossing a slot boundary; coalescing several missed slots; explicit requests and their partial continuations; and a completed checkpoint followed by failed generation settlement. Show that any suppression avoids both repeated physical work and false completion, while retaining the established retry/cursor behavior.
4. Preserve independent lifetime/monthly checks and measure per-fan/window maximum/tail age, along with the last full independent sweep. Quiet corrections must still meet the old bound; a different bound needs the separate C2c owner decision. Zero/missing/out-of-roster subjects remain separately uncovered by the current spender walk.
5. A skip must not manufacture freshness, discard an unfinished cursor or lose endpoint/revision retry debt. Existing provider cooldown ownership remains intact.
6. Compare physical attempts over matched multi-day and generation windows with workload/backlog context. Flattening one UTC day is not a demonstrated saving. The retained fleet means remain 30,569.33/day for 1–6 September and 30,699.50/day for 11–12 September (+0.426%); causal savings and the ≥50% goal remain unproven.

**Next concrete engineering step:** reproduce the completed-checkpoint/unsettled-generation case and establish historical generation provenance before choosing a narrow duplicate-work fix. The rolling completion cooldown is not accepted by this review; that conclusion follows from the explicit source counterexamples and freshness contract, not a preference for the present scheduler.
