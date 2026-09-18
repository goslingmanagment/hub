# C1 natural comparison after Lora-2 revision 1640

**The next retained natural comparison did not request another reconcile.**
Scheduled `followers` run **751279** started at **2026-09-14T18:44:27.072Z**,
emitted one valid decision at **18:44:30.105Z** (receipt **5923633**) and succeeded
at **18:44:30.119Z**. Both active and source follower counts are **8,140**.
`requested=false`, `requestedSeq=null`; count-mismatch, exhausted-without-known
and unchanged-head-with-rows are all false. The known-checkpoint flag is true.
The empty queue receipt is expected for this no-request result; it does not prove
current queue state.

This follows the separately verified exact-generation terminal **751074**, queued
revision **1640**, generation **1602**, completed at **17:51:20.822Z**. Its
[previous packet](../lora2-seq1640-20260914T181333Z/REPORT.md) remains unchanged.
The new result closes the previously unobserved subsequent comparison for this
case. It does not establish relation identity, presence equivalence, absence of
future anomalies or a fleet-wide reduction in repairs.

One bounded export covers **2026-09-14T17:51:20.822Z** through
**2026-09-14T18:49:10.237073Z**. It returns **50 ordered unique cohort rows**,
including **one Lora-2 row**, and is exhausted (`nextRunId=null`, upper bound
`throughRunId=751308`). Snapshot `asOf`: **18:49:12.782266Z**; collection finished
**18:49:16.706348Z**. The exporter lacks a page filter, so the preserved cohort is
filtered locally without adding it to cumulative counters.

The hub skill and production-pinned CLI documentation were read. That CLI does
not expose C1 diagnostic timeline functions; the existing reviewed
`read-report.py` invokes their approved SQL read surface. Its unchanged SHA-256
is `75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`.
The receipt confirms `read_only` / read-only `on`; the explicit SQL uses REPEATABLE
READ and a 20-second statement timeout, with a 40-second outer deadline.
[collection.json](collection.json) retains the exact invocation; [analyze.py](analyze.py)
verifies the raw/report hashes and equality, scope, ordering, terminal linkage,
decision arithmetic and every prior author-packet hash.

The read succeeded once, without retry, fallback, forced work or provider calls.
The database lane is released. No cumulative STATE, previous packet, code, flag,
job or deployment changed. Overlapping totals were not summed. Savings and
reader latency remain unmeasured by this targeted observation. Independent
review is pending.
