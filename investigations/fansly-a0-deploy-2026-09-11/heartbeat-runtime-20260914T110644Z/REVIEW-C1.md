# Independent C1 numerical review — 14 September, 11:07 UTC packet

**Passed; no findings.** The retained packet supports unchanged C1 diagnosis,
with no newly established owner action or stage acceptance.

Reviewed by `/root/review_w0_runner` at 2026-09-14T11:15:54.308866+00:00. This review read local artifacts
only: no production/database/provider call, test, Git operation or C1 state write.
The author was a separate agent; this is not a second live observation.

Packet: `investigations/fansly-c1-deploy-2026-09-11/followup-20260914T110744Z`.

- REPORT SHA-256: `c7e1c17f7cc49810526e84a329b08bf8ef0722148057768bd6cfaed24234958b`.
- Summary SHA-256: `6220bf910c234dc1d5700c7d3b1ff47b8a03e1bc5945a4135f134de2dc8916d2`.
- All 42 manifest entries, six raw/report/receipt pairs and embedded manifests
  match their hashes. The reader hash matches the previously reviewed source.
  Every receipt confirms `read_only` and read-only mode; repeatable-read isolation
  is explicit in that SQL, not separately echoed by the receipt.
- Independently verified the six cursor transitions, fixed original window and
  through-ID 749100, counts 500/500/500/500/500/437, final exhaustion and 2,937
  unique ordered rows. All selected starts and finishes meet the reported cutoff.
  All 2,845 prior rows are unchanged; 92 new rows exactly match the retained delta.
- Recomputed 493 valid decisions among 571 incremental runs: 376 no-request,
  110 mismatch-only and seven mismatch-plus-exhaustion. Exported count/OR/queue
  arithmetic agrees. Every one of 117 clean-queue requests has exactly one later
  same-page, same-revision successful terminal retaining exact-generation proof,
  matching checkpoint revision/generation and destructive-finalization evidence.
  There are 126 terminals in total, including nine scheduled terminals.
- The unchanged missing-final split remains 77 partial chunks plus one historical
  failed run. All three new terminals have valid membership receipts: 79 valid
  terminal receipts plus one older nonterminal receipt; the same 47 prior terminal
  gaps remain. Recomputed two actual-deactivation and one grace-only occurrences.
  All three reported generation chains and their later incremental comparisons
  match raw rows, including five Lora-3 no-request comparisons after generation
  786 and two matching 9,476/9,476 comparisons after Lora-1 generation 1234.
- Recomputed first-page-only HTTP totals: 12,869 attempts, 32 retry ordinals,
  zero failed/429 outcomes, 785 unknown-byte attempts, and state counts of 12,837
  success plus 32 retry. The previous cumulative aggregate differs by +344 attempts
  and +42 unknown-byte attempts, with no extra retry/failed/429 outcome. Coverage
  totals 2,937 runs with zero exported unknown/boundary/unrecorded/unfinished
  counters. C1 STATE measurement values and successful-packet pointers agree.

The report correctly retains per-page rather than whole-timeline atomicity,
unknown checkpoint identity/encounter, historical receipt gaps, and the distinction
between count occurrences and identified relations. Subsequent comparisons are
separate observations, not atomic active-after evidence or presence equivalence.
It does not sum overlapping snapshots, infer causal savings or event latency,
accept suppression, or equate PR166's historical merge with deployment.
Runtime/configuration, C2b and final shared disposition belong to the coordinator.
