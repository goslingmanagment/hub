# Independent C1 packet review — 14 September 2026

Verdict: **no findings** in the retained numerical evidence or its stated scope.
The fresh C1 report supports an unchanged observation disposition; it establishes
no new owner action, policy acceptance, deployment, savings or latency result.

Reviewed locally by `/root/review_w0_runner`. No production/database/provider
calls, tests, Git operations, or C1 state writes were performed for this review.
The author was a separate agent. This is an artifact review, not a second live
observation. Review completed at 2026-09-14T05:26:02.731804+00:00.

## Evidence and recomputation

Packet: `investigations/fansly-c1-deploy-2026-09-11/followup-20260914T051155Z`.

- REPORT SHA-256: `1d5c8664665f03610346a51fdb3bedabb13f53c1bfed888ffacc6f2af39f9b09`.
- Summary SHA-256: `6d6cd317892e521cbd901f464455401f1ee762a2639bbc1057e7222dd7a76bb0`.
- All 42 entries of `SHA256.json` match. All six report hashes, raw receipt/report
  equivalence, embedded manifests, receipt hashes, row counts and cursor transitions
  independently match. The unchanged reader hash matches the pinned summary.
- The raw receipts report `read_only` and read-only transactions. The retained
  reader explicitly selects repeatable-read/read-only snapshots with 20-second SQL
  and 40-second subprocess limits. Isolation is not separately echoed by receipts.
  The fixed original window and through-ID 747772 persist across all six pages;
  only page six is exhausted. This does not make the combined timeline atomic.
- Independently compared all 2,845 ordered unique rows with the prior six-page
  export: all 2,604 prior rows remain byte-equivalent as parsed records; 241 are new.
  New outcomes are 36 successful and 18 partial follower runs, plus 177 partial
  and ten successful reconciles. All starts and finishes satisfy the stated window.
- Recomputed 457 valid decisions among 535 follower runs: 343 no-request,
  107 mismatch-only, seven mismatch-plus-exhaustion. Exported OR/count predicates
  and queue revision arithmetic agree. Each of 114 clean-queue requests has one
  later successful terminal on the same page and requested revision, retaining
  exact-generation proof and matching checkpoint revision/generation statistics.
  The other nine terminals are scheduled; this is not evidence of coalescing.
- Recomputed 123 terminals, 76 valid terminal membership receipts and one older
  valid nonterminal receipt. All 47 terminal gaps belong to unchanged prior rows.
  All ten new terminals have valid receipts; their sums are six deactivation and
  five grace-only occurrences. The report correctly avoids identifying distinct
  relations or equating protected and later retired rows from aggregate counts.
- The 18 new missing final decisions are Lora-1 partial runs before final run
  745802 (95 pages, requested revision 1273). They preserve unknown final decisions
  per chunk and do not increase the historical failed-run count. Cumulative missing
  receipts remain correctly split into 77 partial chunks and one historical failure.
- Recomputed only first-page follower HTTP aggregates: 12,525 physical attempts,
  32 retry ordinals, zero failed/429 rows and 743 unknown-byte attempts; states are
  12,493 success and 32 retry. Difference from the prior first-page aggregate is
  +1,084 attempts, +56 unknown-byte attempts and no new retry/failed/429 outcomes.
  Coverage is 2,845 runs with zero exported unknown/boundary/unrecorded/unfinished
  counters. Repeated page aggregates and cumulative snapshots are not added.

Current C1 STATE measurement fields and successful-packet pointers agree with
these artifacts. Its current numerical review was still explicitly pending when
read; coordinator-owned runtime/configuration fields are outside this review.
The shared heartbeat REPORT C1 paragraph agrees. The retained PR166 receipt hash
matches; its merge is correctly separated from deployment and policy acceptance.
Native checkpoint identity/encounter, presence equivalence, suppression, causal
savings and event-to-reader latency remain unproven. No gate or clock change is
supported by this review.
