# C1 Lora-3: the next natural comparison — 13 September 2026

Lora-3's next full follower walk performed one actual deactivation. Five
subsequent incremental comparisons matched provider and active counts and
requested no reconciliation. This closes the pending follow-up from the
18:37 UTC report and supports preserving this observed repair path.

One bounded READ ONLY repeatable-read timeline covers
2026-09-12T18:00:00Z through 2026-09-13T00:02:35.324525Z,
with asOf 00:02:38.837060Z. It contains 334 unique ordered run IDs, upper
ID 737812, and exhausted pagination. Lora-3 contributes 39 rows:
seven successful incremental runs, two successful reconciliation terminals
and 30 partial reconciliation chunks. This overlapping interval is not a
replacement for, or addition to, the earlier cumulative snapshot.

| Run / time UTC | Evidence |
|---|---|
| 734952 / 18:00 | Counts 7,566 / 7,565; count-mismatch branch alone requests revision 1524 from a clean queue |
| 735021 / 18:06 | Revision 1524, generation 775: exact-generation terminal; one row protected by generation grace, zero actual deactivations |
| 735379 / 19:00 | Counts still 7,566 / 7,565; count-mismatch branch alone requests revision 1525 from a clean queue |
| 735448 / 19:06 | Revision 1525, generation 776: exact-generation terminal; one candidate and one actual deactivation, all protection buckets zero |
| 736007 / 20:00 | Counts 7,565 / 7,565; no request |
| 736470 / 21:00 | Counts 7,566 / 7,566; one processed row, no request |
| 736918 / 22:00 | Counts 7,569 / 7,569; three processed rows, no request |
| 737405 / 23:00 | Counts 7,570 / 7,570; one processed row, no request |
| 737798 / 00:00 | Counts 7,570 / 7,570; no request |

Both terminals have one valid membership receipt and
`membership_proof=exact_generation`. Their leased revisions match the
respective requested revisions. Each generation reports 7,565 observed
members. Generation 775 starts at 18:00:33.940Z and generation 776 at
19:00:21.820Z; each finishes after 76 fetched pages.

These are aggregate receipts: they do not identify the protected or retired
relation or prove that both counts refer to the same relation. The later
incremental comparisons are separate runs, not an immediate atomic
active-after-UPDATE observation. They also do not measure presence coverage.

Production was only read. The SQL session uses `read_only`, repeatable-read
READ ONLY, a 20-second statement timeout, a 1-second lock timeout and a
30-second bounded psql process. It rolled back normally. Exact SQL, raw JSON,
transaction identity, command outcome and SHA-256 are retained alongside
this report. Runtime metadata immediately before the read shows all three
roles healthy with zero restarts on `74aac5093cfc`.

This observation introduces no application code, deployment, flag, provider
probe or forced sync. No application tests were rerun; the existing C1
implementation checks and independent reviews remain recorded in PR166.
The new numerical review is in `REVIEW.md`.

No redundant-work suppression is justified by this chain. It does not prove
that every full walk is necessary or clear other C1 cases. Presence freshness,
safe suppression, physical savings and event latency remain unproven.
The three historical missing membership receipts remain unknown. A0's
original clock and its cumulative snapshot are unchanged.

