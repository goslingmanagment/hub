# Lilly-2 A0 missing-head investigation — 14 September 2026

**One repeated current-debt candidate matches both problematic list windows.**
The retained list responses advertise message `949097710298869762` in
conversation `834268142812291072`, while its aggregation group explicitly has
`lastMessage: null`. This narrows the investigation. It does not establish exact
historical pre-apply attribution, message loss or a provider-side deletion.

No code, flag or business data was changed; no provider request or recovery
was started.
Ordinary Agent audit and usage bookkeeping remains part of the CLI reads.
Production SQL used `read_only`, REPEATABLE READ READ ONLY, 5-second statement
and 100ms lock timeouts, with 8s remote plus 1s kill grace and 20s local limits.
Each SQL read ran once without a retry or privilege fallback. Hub CLI reads used
the production-pinned installation and existing Agent key.

## What the original counters say

The independently reviewed [A0 export](../fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T174241Z/REPORT.md)
contains one `readerMissingHeadsBelowStop` and one hot-head miss in each Lilly-2
sweep G6917 and G6918. Both completed with 142 pages and candidate stop page 3.
Their counters contain no conversation/message identities or per-page reader
state. The G6918 flags discrepancy is another aggregate and is not attributed
to the candidate below.

## Current debt and historical list markers

The 18:14 privilege read confirms page `lilly-2` is Fansly page 5. `read_only`
can SELECT observations, hot capture bodies and the debt-report view; direct
message stores, thread rows, sync runs and raw-payload rows remain denied. No
attempt was made to bypass those grants or rerun the SQL-cost probe.

At 18:15:55 UTC the bounded debt query returned all **106 current uncaptured
debts**, below its 201-row sentinel. This includes hidden/unresolved/excluded
targets. Debt is a candidate index, not a census of historical reader misses:
a later capture, previously closed debt, erased thread or material arriving
between pre-apply and list-write can remove a historical candidate from it.

The raw-list read covers the two exact completed-sweep time windows. It uses
the indexed page/time scope, limits each window to 201 source receipts and
extracts only sanitized markers. Both windows have **142 ordered unique
observations and 14,104 list entries**, zero unavailable bodies, zero malformed
data arrays and no source cap. Of the 106 exact debt pairs, only the same pair
matches each window:

| Window | Observation | Received UTC | Producer run | Source ordinal / item |
| --- | ---: | --- | ---: | --- |
| G6917, 16:46:24.430–16:58:10.122665 | 2500080 | 16:52:05.085 | 750834 | 69 / 44 |
| G6918, 17:16:25.467–17:28:31.896110 | 2500617 | 17:22:27.004 | 750944 | 69 / 44 |

Producer idempotency keys contain the run IDs. Generation association is based
on the retained sweep windows, not an embedded generation field. Source ordinal
69 is the order of retained observations; it is not a verified request offset.

Both matching rows use captured body object `1077298`, bucket September 2026.
They have flags `2`, exactly one matching aggregation group, and an explicit
null embedded head with no embedded ID or creation time. Duplicate aggregation
groups would remain visible in the query output rather than silently selecting
one. No message text, username or arbitrary request parameters were exported.

The candidate's current debt records `captured_at=null`, zero attempts, visible
and resolved identity, complete history and exclusion reason
`partner_unresolvable_from_account_lookup`. Its retained message date is
26 August 20:41:27 UTC; debt `first_observed_at` is 8 September 12:10:09.240088.
That debt timestamp is not proof of the first provider sighting: migration 0172
also seeds existing heads. The exclusion describes Hub's recorded lookup result;
it does not prove the provider deleted or permanently disabled the account.

## Current reader evidence and limits

A single Agent transcript read selected this conversation from 1 August through
14 September 18:22:43 UTC, including deleted rows by default. It returned zero
rows and an exact zero count for that filtered transcript scope. The API call
was successful, but `--fail-on-partial` correctly produced exit **3** because
`delivery_not_exhausted` was present: no next cursor and
`snapshotExhausted=false`, with mutable/no-frozen-snapshot caveats.

All four transcript planes were marked read, with no source errors or capture
gaps. `message_archive` reported a floor of 13 October 2025; the other three
floors were unknown. The current transcript deliberately does not promise a
frozen snapshot. Its query includes pending rows and null event timestamps;
it applies the final time window after source precedence. These results are
not an exact-ID classification across all possible winning event times, and
cannot reconstruct the earlier reader snapshot. No existing Agent/CLI exact-ID
state endpoint was found. Repeating the same read or cost probe would not
resolve that limit. The [source review](SOURCE-TRANSCRIPT-REVIEW.md) retains the
exact reader-contract references. A separate static count-cap finding is
recorded in [its own note](UNRELATED-COUNT-FINDING.md); it does not explain this
zero-row result and was not reproduced or changed in this investigation.

The supportable finding is **one repeated candidate with an advertised ID and
an explicit null embedded head, already excluded by the current lookup policy**.
It is consistent with the two scalar anomalies. It is not proof that both
historical reader-missing counters refer to that candidate. The unchanged flags
in these two source rows do not explain the separate G6918 flags counter.

A0/A1 remains NO-GO. Original clocks, full polling, discrepancy counters and
historical unknowns are unchanged. Provider-deletion head repair remains outside
A0. No HTTP savings or event-to-reader latency result follows from this work.
Exact historical attribution would need per-ID pre-apply evidence that was not
retained; today's snapshots cannot recreate it.

The [read-plan review](REVIEW-READ-PLAN.md) fixed payload multiplication and
duplicate-group selection before execution. [Final findings review](REVIEW-FINDINGS.md)
records independent validation of the raw receipts and these conclusions.
