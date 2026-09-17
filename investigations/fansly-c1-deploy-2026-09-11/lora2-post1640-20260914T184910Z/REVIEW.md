# Independent numerical review: Lora-2 after revision 1640

**Pass; no actionable findings in REPORT.md or summary.json.** This closes the
previously unobserved next retained natural comparison for this specific case.
It does not accept C1 suppression policy or advance cumulative observations.

The reviewer used local files only. No production calls, exporter execution,
test runs, source changes, STATE edits or changes to frozen author files were
performed. The author's `analyze.py` was read, not rerun; independent read-only
calculations checked the retained data and hashes.

## Numerical and receipt checks

- All 11 hashes in the new artifact manifest match. All 11 frozen author-file
  hashes in the preceding revision-1640 packet also still match.
- Raw receipt/report equality, the report hash, invocation output, collection
  manifest, successful exit and empty error files agree. The receipt echoes
  `read_only` and transaction read-only `on`. The unchanged exporter explicitly
  uses REPEATABLE READ READ ONLY, a 20-second statement timeout and a 40-second
  subprocess deadline. Isolation is present in that SQL, not independently
  echoed by the receipt.
- The explicit window is 17:51:20.822–18:49:10.237073 UTC, or 3,469.415073
  seconds. All 50 cohort rows start inside it, have unique ascending run IDs
  and are within upper bound 751308. `afterRunId=0`, `nextRunId=null` and fewer
  than the requested 500 rows support exhaustion of this diagnostic cohort.
  The 18:49:12.782266 snapshot time falls within the retained export interval.
- Exactly one row is Lora-2. Independent selection matches `selected-rows.json`
  and the complete `naturalComparison` object in `summary.json`. Scheduled
  followers run 751279 starts at 18:44:27.072, records one valid decision
  5923633 at 18:44:30.105 and succeeds at 18:44:30.119, before the cutoff.
- Active/source counts are 8,140/8,140. The three decision predicates are all
  false; their OR agrees with `requested=false`. `requestedSeq=null`,
  `knownCheckpoint=true` and `processedThisChunk=0`. The independent diagnostic
  aggregates agree: one valid Lora-2 decision, no missing/invalid/duplicate
  decision and zero requested reconciles in this window.
- Empty `queueBefore` and `queue_valid=false` are expected for a no-request
  decision under the timeline contract; they do not establish a current empty
  queue. The report preserves this limitation.
- The preceding packet's raw terminal row equals its saved summary: run 751074,
  leased/request/checkpoint revision 1640, generation 1602, one valid membership
  receipt 5921313 and `exact_generation`. Its 17:51:20.822 finish equals the new
  lower window boundary and precedes the new comparison. The prior summary hash
  in the new packet matches. This is a temporal follow-up, not proof that the
  earlier deactivation causally explains all later count equality.

The final claims remain appropriately bounded: no relation identity, atomic
after-state, presence equivalence, future anomaly absence, fleet-wide repair
reduction, causal savings or reader latency is inferred. The cohort includes
other pages because the exporter lacks a page filter; its overlapping aggregate
totals are not added to cumulative counters. The frozen report's pending-review
sentence is historical; this separate receipt completes independent review.

## Reviewed hashes

| File | SHA-256 |
| --- | --- |
| `REPORT.md` | `c7cfc307eb7c19535c99a5e712d0a7f98ea865ac1ac75c60240943b6f2efe555` |
| `summary.json` | `a29380737b4c453b052c2c8ea739c6ab2ba7631af8b5251843168fd8e4eaca9c` |
| `artifact-manifest.json` | `0549b62b24808bdfce55a5bdcf258fdfacf1a7b91a89bbf9675c0c3335d5b062` |
| `page-1/read-receipt.json` | `0ea441cd98fce4dbad3518286d2199b61bde8c1583ba80a0491d4cdbded14bb3` |
| `page-1/report.json` | `7734465b4978a1ad306543954958c4c2e90f11e6c5e262c302b7b29ae7eea4e9` |
| Prior `summary.json` | `8cc4db7820d9f7167e5e2b3904cd61bbf3dd6385865948eb4d6ddb804e43c625` |
| Unchanged `read-report.py` | `75bf0c1b841d26cdea469d3f39dd238f7817fdd1d8ed721f57c99f6d86abdf3f` |
