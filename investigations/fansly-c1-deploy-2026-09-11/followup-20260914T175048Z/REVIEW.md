# Independent C1 observation review

Verdict: **pass; no actionable findings** in the frozen numerical packet.
Reviewed locally by `/root/w0_browser_discovery`; no production connection,
provider request, test run or STATE mutation was performed.

All 48 artifact-manifest entries match their retained bytes. Each of the seven
raw receipts equals its formatted report and confirms `read_only` / read-only
mode. The unchanged reader explicitly begins REPEATABLE READ READ ONLY, limits
statements to 20 seconds and its subprocess to 40 seconds. Isolation is SQL
provenance, not a separately echoed receipt field. Exact invocation records use
the original start, fixed cutoff and first `throughRunId` 751072; subsequent
`afterRunId` values use the preceding returned cursor. Six pages contain 500
records and the exhausted last page contains 244. Page asOf instants fall within
their own export intervals; the combined observation is not atomic.

Independent calculations from raw pages and the previous 11:07 packet confirm:

- 3,244 ordered unique runs, with all 2,937 previous rows unchanged and 307 new
  rows: 40 successful incremental runs, 249 partial reconcile chunks and 18
  successful reconcile terminals. Outcomes total 677 succeeded, 2,565 partial
  and two historical failures.
- 611 incremental runs, 533 valid decisions: 398 no-request, 128 mismatch-only
  and seven mismatch-plus-exhausted. All eight OR combinations are accounted
  for, including five unobserved combinations. Count/OR arithmetic and all 135
  queue increments agree with first-page aggregates. The same 78 missing final
  decisions are 77 partial chunks and one historical failure; invalid,
  duplicate and unknown request-queue receipts are zero.
- 134 of 135 requests match exactly one later successful terminal for the same
  page and requested revision. Generation statistics, checkpoint generation /
  revision and final observed/source counts corroborate the exported
  exact-generation marker. Ten other successful terminals are scheduled.
  Pending-at-request remains zero and is not a current queue or savings metric.
- Lora-2 request 751019 / seq 1640 has 16 partial chunks and no in-window
  terminal. Run 751072 finished at 17:51:03.241, after the fixed cutoff
  17:50:48.205159; its `unfinished_in_window` marker is preserved. Its later
  observed partial result does not establish completion at cutoff.
- 144 successful reconcile terminals include 97 valid membership receipts;
  all 47 missing receipt IDs equal the previous packet's historical set.
  The historical 44 + three writer-boundary classification is carried forward,
  not re-investigated. Including two nonterminals gives 99 valid receipts;
  disjoint membership arithmetic checks out. The 18 new terminal receipts sum
  to 10 deactivation and 14 grace-only occurrences, with the other three
  protection categories zero. These are occurrences, not unique identities.
- Lilly-2 750533 / G803 / seq 2552 has a valid restart receipt, withheld
  finalization and null deactivatedCount when source count rose 18,323 →
  18,324. Run 750706 later completes G804 in the same revision with two
  deactivations. The report correctly avoids pairing identities between them.
- The first-page HTTP aggregate alone totals 14,279 attempts: 14,247 success
  outcomes and 32 retry outcomes, zero failed/429 outcomes, 864 unknown-byte
  attempts and 537,393,523 known captured bytes. Signed differences are +1,410
  successes/attempts, +79 unknown-byte attempts and +52,901,452 known bytes;
  source deltas are 1,325 anomaly reconcile, five scheduled reconcile and 80
  incremental. No repeated aggregate was summed.
- HTTP coverage totals 3,244 runs, including one unknown run in the 84-run
  Lora-2 anomaly reconcile day bucket. The grouped export cannot identify that
  run. Boundary, known unfinished-attempt and unrecorded-attempt counters are
  zero; these counters do not override the separate cutoff-crossing timeline.

The report preserves provider completeness, historical missing-evidence,
non-atomic timing and identity limitations. It makes no suppression, external
presence, production acceptance, causal savings or event-to-reader latency claim.
The original author report's pending-review sentence is historical; this review
closes numerical review only. Coordinator state/finalization is separate.

Verified SHA-256 fingerprints:

| Artifact | SHA-256 |
|---|---|
| REPORT.md | `2a39e9884d719b95a9dc59977f544fb3a4954000e96cdb055b13c35403150df7` |
| summary.json | `2a45600b21c4c9929577c6a508b7edbde1c9b3c0cfa8f57d2c2a88fea9638b53` |
| artifact-manifest.json | `bb9e34b95f99b8b9fa52f1f54289fa6f5a6b117bf7b1dc273e3367e24d12900f` |
| analyze.py | `a168a135ae502d5c79b353f4a700aa12c517474bc6fc376f60b8be2df2f9cf5f` |
| collection.json | `541077f1967df662226e3fb7b39d77218bd416c7a0ca514d1d417a6dbfefd9f2` |
| ../read-report.py | `75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f` |
