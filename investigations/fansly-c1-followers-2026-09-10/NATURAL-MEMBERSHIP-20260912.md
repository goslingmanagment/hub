# First natural C1 membership receipt — 12 September 2026

Release `7aaa3185757e` emitted its first observed valid membership receipt on
Lilly-1. This demonstrates the new diagnostics on one natural reconciliation.
The trigger policy remains unchanged and redundancy is not established.

The repeatable READ ONLY report covers 12:11:06.271182–12:30:50.069257 UTC.
Its nine follower runs comprise two incremental decisions and seven chunks of
request 736 / generation 687. Pagination is exhausted. Report SHA-256:
`f4a1a12bb07fa0c305fc61c972e90f915f2befba9e19026264d340fcec049330`.

The incremental run requested revision 736 from a clean queue after observing
3,357 active followers against a provider count of 3,356. The final chunk,
run 733015, completed at 12:19:29.162 UTC with one valid receipt and
`membership_proof=exact_generation`:

| Measurement | Count |
|---|---:|
| Active before UPDATE | 3,357 |
| Active in generation 687 | 3,356 |
| Active outside generation | 1 |
| Deactivation candidates | 1 |
| Actual rows deactivated | 1 |
| Generation-only, timestamp-only, both, future protection | 0 each |

The generation used 36 successful physical attempts: 34 follower-list reads and
two account reads. No retry or terminal failure was recorded. The preceding
generation 686 / revision 735 had zero candidates, but it predates the new
actual-UPDATE receipt. It does not establish an actual zero-row UPDATE.

These observations are compatible with an absence-protection expiry; they do
not identify the same row across generations or establish which earlier
protection applied. Subtracting the retirement count from the aggregate is not
an active-after measurement: SELECT and UPDATE are separate statements.

An independent reviewer verified the hash, read identity, receipt partition and
the comparison with generation 686; no findings remain. Follow the next natural
Lilly-1 incremental decision to see whether the mismatch and request disappear.
Do not suppress this generation based on frequency alone. Other trigger branches,
presence freshness, physical savings and fresh-event latency remain unaccepted.

Raw reports remain in the main checkout under
`investigations/fansly-c2a-c2b-preflight-20260912T122314Z/`.
Earlier cumulative exports and the first empty post-start window remain intact;
this overlapping window must not be added to their counters.
