# Ari-1 head catch-up canary — active

The owner approved this exact canary and its rollback in the current chat.
`fanslyDmHeadCatchupPageAllowlist` was saved as `ari-1` at
**2026-09-08 12:33:25 UTC / 15:33:25 Moscow**. The previous value was `none`.
The dashboard's running value subsequently converged to `ari-1`; API, worker
and scheduler reported active heartbeats and no configuration drift.

**Return the flag to `none` at 13:33:25 UTC / 16:33:25 Moscow.** This rollback
is already authorized. Refresh the dashboard and use its normal CAS save. Do
not overwrite a different scope set by another operator. An in-flight request
may finish; ordinary history continuity and debt must remain intact.

The same-task heartbeat checks the canary every five minutes and includes a
run at 13:33 UTC, instructed to wait until the rollback deadline and then act.
It must pause after verifying rollback and saving the final report. This
activation record is not a claim that recovery or production acceptance passed.

At 12:36:18 UTC both eligible target debts were still pending with zero
completed attempts, and ari-1 had no message observations since activation.
The next ordinary full list sweep must discover the eligible work; no manual
sync or checkpoint reset was performed.

- Conversation `952822347599994880`, message `953208142580178944`.
- Conversation `953353803074117634`, message `953354621215076352`.

The other three ari-1 debts retain exclusion/identity reasons. Lilly-2 is not
in the allowlist. Budgets, concurrency and all other flags remain as before.
Background v6 reply replay is separate from this head-recovery canary.

Evidence and resumption: [state](STATE.json), [activation](evidence/activation.txt),
[pre-activation debt](evidence/debt-before.txt),
[first check](evidence/status-first.txt), [read-only status query](canary-status.sql),
[scheduled check](evidence/scheduled-check.json).

## First observed result, 12:38:18 UTC

The original stale-follow-up target `953354621215076352` was captured raw at
12:36:33.695 UTC and accepted by the hot writer at 12:36:33.704704 UTC — about
3 minutes 9 seconds after activation. Hub returned that exact ID from
`page_dm_messages`; its observation is still parse_version 0, so archive
acceptance remains open. This is activation-to-capture for one target, not a
delivery-latency percentile.

Target `953208142580178944` remains unresolved after one completed attempt.
There are zero matching raw receipts since 7 September and zero unavailable
raw bodies in that scoped read. A different message returned in the narrow
transcript window is not credited as the target. Its debt remains explicit
and eligible for the normal retry policy; there is no deletion conclusion.

One additional new head, `953680793199198208`, was also captured by the
ordinary cycle. Do not count it as a second recovered original target.
The 60-minute window and authorized rollback remain in force.

[Exact debt/raw receipts](evidence/status-second.txt),
[serving checks with caveats](evidence/serving-initial.json).

## Runtime check at 12:49:50 UTC

All three processes remained healthy at b47f552abb97 with zero restarts and
31 GiB free. The collected 12:39–12:49 worker window contains one ari-1 DM
HTTP attempt, 477 ms, with zero retries/failures/429s. This is a bounded log
window, not the entire canary request total.

Global projection ticks rose to 204.177 and 133.725 seconds; message_archive
accounted for 172.220 and 112.812 seconds. The projection backlog threshold
also fired. Historical v6 replay is concurrent; no causal attribution to the
small canary is established. Freshness acceptance remains open. No flag or
budget was changed during this health check.

[Runtime](evidence/runtime-1249.txt), [worker warnings](evidence/worker-1249-summary.json),
[ari HTTP counters](evidence/ari-attempts-1239-1249.json).

## Retained provider response comparison, 12:57 UTC

The three permitted observation-journal bodies for the unresolved conversation
contain the same eight other message IDs, with no unavailable body. None
contains target `953208142580178944`. In the ordinary list observation at
12:36:19 UTC, the group is present but `lastMessage.id` is absent/null. This
is a provider-response discrepancy against the retained known head; it is not
a proved deletion, and the debt must remain explicit. The recovered target
`953354621215076352` is present both in the list and its message response.

A direct `sync_raw_payloads` query was unavailable to `read_only` (an initial
column-name error was corrected from the schema, then SELECT was denied).
Those two partial outputs are not evidence of an empty response. The result
above uses the already-permitted observation journal; it does not claim
inspection of the denied request metadata. No role/grant was changed.

[Working read-only query](target-observations.sql),
[message IDs and list heads](evidence/target-observations-1257.txt).

## 13:14 UTC check

Shared running flag remains `ari-1`; all three roles show active heartbeats. The original two targets remain one captured and one unconfirmed after four attempts. Four additional ordinary heads have receipts; they do not change the original-target denominator. Nine DM observations were captured since activation. See `evidence/status-1314.txt` and `evidence/config-1314.txt`.

The worker-log export found a 353.6-second global projection tick at 12:50:36, dominated by `message_archive` (309.9 seconds). The latest warning tick at 13:09:01 was 46.8 seconds. There were no error-level entries in this export. Historical reply replay remains concurrent, and attribution to the canary is not established. Freshness acceptance remains open. See `evidence/worker-1309-summary.json`.

## Closed at 13:41 UTC

Rollback saved at 13:33:34 UTC (nine seconds after the planned deadline); all-role running `none` verified at 13:35:16. Final report: [REPORT.md](REPORT.md). PR #157 production result was updated and read back; the canary heartbeat is paused. This closes the bounded canary, not the pre-A0 production acceptance or the migration.
