# A0 observation — 13 September 2026, 00:15 UTC

The cumulative window remains 10 September 22:58:33.610 through
13 September 00:15:18.575628 UTC. The read completed at 00:15:27.909602 UTC
as `read_only`, transaction read-only `on`. This reader is not an atomic
snapshot: Lora-3 generation 7652 was updated at 00:15:18.699273, just after
the requested cutoff, and remained running.

There are **583 sweeps: 340 complete, 241 incomplete and 2 running**.
All 512 rows from the preceding 12 September 18:37 snapshot are unchanged.
The 71 newly selected rows comprise 64 complete, 5 incomplete and 2 running;
they are not added to the cumulative totals a second time.

Lora-1 generation 4830, completed at 12 September 20:37:44.643271 UTC,
contains 2,364 changed-head and 2,364 head-rollback occurrences below its
virtual stop. Both counters occur on this one row; they are not distinct
populations or a count of unique lost messages. Its 2,368 generic state-change
occurrences and other subtype counters are likewise not additive. The six
new reason counters are absent on this row. Their absence is unknown, not zero.
The subsequent [bounded raw comparison](../../../lora1-4830-20260913T003537Z/REPORT.md)
finds 2,363 distinct common groups whose populated list pointer becomes
null/absent and stays empty in the next full sweep. All already lacked an
embedded head, timestamp and sender in the preceding provider response.
The extra runtime occurrence remains pre-apply unknown; omitted and explicit
null fields cannot be distinguished. This does not establish content loss.

All nine depth/overlap candidates stop at pages 8, 10 or 12 and miss all
2,363 clearings on pages 50–77. The **current early-stop candidate is NO-GO**.
The [gate assessment](../../../lora1-4830-20260913T003537Z/GATE-ASSESSMENT.md)
preserves the original A0 clock and the earlier flags counterexamples. Actual
full polling continues; a negative decision does not require waiting seven
days and does not pass or shorten the positive A0 gate.

Cumulative material checks still include 403,215 unknown observations. For each
of the six new reason counters, 44 rows have known zeros, 538 omit the field and
one contains null. The retained HTTP cohort has 63,559 attempts, 2,066 retry
ordinals, 652 failed attempts and 3,464 unknown byte counts. HTTP coverage has
7 unknown and 4 boundary runs; DM coverage has 2 unknown and 8 lost-report runs.
These incomplete denominators do not establish savings or fresh-event latency.

The [manifest](report.json.manifest.json) matches the exact report SHA-256
`f16ce5e1ed32667498657c9e5c8850cbb163272aaa90d112cc051ccdaa5d0dda`.
The normalized report also equals the report inside the original read receipt.
Original files, clocks and earlier failures remain unchanged.

[Runtime metadata](../../../heartbeat-runtime-20260913T001518Z/runtime.json)
at 00:15:20.877342 UTC records source label `380326368fe3`, the same image on
all three healthy roles and zero restarts. The worker started at
00:08:36.595201918 UTC. The corrected ordinary
[API health read](../../../heartbeat-runtime-20260913T001518Z/api-health.json)
reports API/database `ok`; `health.json` contains the SPA response from the
wrong route and is not health evidence. This is not a protected deployment gate.

The original activation proof and seven-day clock are preserved. Effective
flag continuity has not been reverified because the prior signed-in Hub tab
was unavailable. A0/A1 acceptance remains open; the earliest original seven-day
point is 17 September 22:58:33.610 UTC. No flag, provider call, recovery, replay,
polling change or automation change was made in this documentation update.
