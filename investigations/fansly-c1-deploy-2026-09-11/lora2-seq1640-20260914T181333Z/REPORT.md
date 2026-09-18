# C1 targeted closure — Lora-2 revision 1640

**The pending reconcile completed naturally.** Run **751074** succeeded at
**2026-09-14T17:51:20.822Z**, with leased revision **1640**, checkpoint revision
**1640**, generation **1602**, and one valid `exact_generation` membership receipt
(receipt **5921313**, emitted at **17:51:20.799Z**). No forced work was requested.

The targeted chain contains the original scheduled incremental request **751019**
at **17:44:27.766Z**, **16 partial reconcile chunks**, and that single successful
terminal. The terminal records **8,140 observed / 8,140 source followers**, one
actual deactivation and zero grace-only, touch-only, grace-and-touch or
future-generation occurrences. Destructive finalization is explicitly recorded.
These scalars do not identify a relation or prove atomic active-after state or
presence equivalence.

No subsequent natural Lora-2 incremental run appears before the new cutoff.
A later no-request decision is therefore **unobserved**, not false or zero.
The next natural comparison was not forced or polled again.

This is one separate bounded read covering **2026-09-14T17:44:00Z** through
**2026-09-14T18:13:33.785535Z**. The reviewed exporter has no page filter, so its
**37-row cohort** is retained and analysis selects **18 Lora-2 rows** locally.
The one page is exhausted (`nextRunId=null`), with fixed upper bound
`throughRunId=751150`; its snapshot `asOf` is **18:13:38.766546Z**. Collection
completed at **18:13:44.524425Z**. Exhaustion concerns this retained diagnostic
cohort, not provider completeness.

The unchanged exporter SHA-256 is
`75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f`.
Its SQL explicitly uses REPEATABLE READ, READ ONLY, a 20-second statement timeout
and a 40-second subprocess deadline. The receipt confirms role `read_only` and
read-only mode `on`; isolation is explicit in SQL, not independently echoed.
Raw/report equality, SHA-256, unique ordering, window bounds and exhaustion were
verified by [analyze.py](analyze.py). Exact invocation and timing are retained in
[collection.json](collection.json), with [summary.json](summary.json) and the
[selected rows](selected-rows.json).

All 17 overlapping Lora-2 rows match the previous cumulative packet except the
window-dependent `unfinished_in_window` field on run **751072**: it is true for
the old **17:50:48.205159Z** cutoff and false for this later cutoff. Its actual
partial outcome and **17:51:03.241Z** finish are unchanged. The old cumulative
report remains correct and unchanged.

One production export succeeded, with no retry, fallback, write, provider call or
additional read. The database lane was released immediately. No cumulative STATE,
cohort, counter, gate, flag or code was advanced. HTTP aggregates were not added to
cumulative totals. This closes only the specific cutoff-pending revision;
suppression policy, presence equivalence, savings and event-to-reader latency
remain outside the proof. Independent review is pending.
