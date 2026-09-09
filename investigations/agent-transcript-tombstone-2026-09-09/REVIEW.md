# Independent review of PR162

Base: `34d897779fd004336e114333501f284f1faeefc1`.
Reviewed head: `708585d249f5d9cd31e875e6bab28026925287b7`.
Reviewer: independent agent `review_pr162`; no implementation edits or production calls.

## Result

No correctness, isolation, or deployment-scope blockers found in the executable change. One P3 validation-accuracy finding requires evidence-log whitespace cleanup and confirmation on the final documentation-only head.

## Finding

P3 — The report says `git diff --check` passed (investigations/agent-transcript-tombstone-2026-09-09/REPORT.md:76), but the immutable base-to-head range check exits 2 on six newly committed logs: baseline-regression.log:35, baseline.log:9, bounded.log:9, build-production.log:52, check.log:39, integration.log:15. Remove trailing whitespace and extra EOF blank lines without changing output content, then rerun the exact range check. Reported to the implementation agent before completion.

## Independently checked

- Read CLAUDE.md, the full immutable diff, Decision 282, the reply runbook update, complete reader/caller/floor code, current schema/index definitions and the relevant new/existing test cases.
- The runtime diff changes only `cross_tombstones`. It parameterizes platform and resolves the current binding through a scalar primary-key lookup. Zero/missing page binding yields NULL and matches no account equality. The account binding is unique in pages; the cold unique key is `(platform, ofapi_account_id, platform_message_id)`.
- Chatless tombstones remain reachable without a conversation predicate. Cross-account/platform tombstones no longer contaminate another scope. Current-binding clearing behaves as before. Candidate tombstones, preferred source, purchases, post-dedup window/filter/order/limit and count construction are unchanged.
- Caller derives platform from the authorized page. Archive floor is still an independent unbounded query; witness construction and cursor generation are unchanged.
- Parsed production-plan.json and both benchmark JSONs directly. The production estimated subplan searches by message ID before checking the binding; local baseline executes 300000 cold row visits including 30000 tombstones. Bounded local plan executes zero cold row visits. Narrow normalized material/witness/count outputs are byte-equivalent after JSON normalization; wide artifact reports equal first 200 rows. Bound parameter shift is only the inserted platform parameter. SQL diff matches the runtime change.
- Verified production probe SHA256 `ea6dff84b72825ced6d02abbfe5c3e690774b7e193a7f95a1552932221b32d1c`, matching dispatch metadata. The saved SQL uses READ ONLY, 10s statement/2s lock limits, EXPLAIN FORMAT JSON without ANALYZE, and ROLLBACK. No additional production call was made by the reviewer.
- Reviewed local fixture limitations and report qualifiers: single samples, empty OFAPI archive in earlier PR161 benchmark, different synthetic plan shape, later production snapshot with literal values, no claim of full timeout RCA or production improvement.
- Independently executed both focused Docker Postgres integration files: 2 files / 5 tests passed, 0 skipped, exit 0, 4.60 seconds. The runtime/test files were verified unchanged from 708585d2 after execution. See focused-integration.log.
- Inspected the recorded full check/build and 122-test integration evidence; no independent full-suite rerun was performed.

## Remaining verification and gates

This review does not prove production timeout recovery, HTTP savings, fresh-event latency, full lora-1 acceptance, Lilly reply repair, known-head recovery, or A0 readiness. Production deployment remains a separate owner-approved action; exact reads and full original 143-ID lora-1 cohort must pass before remaining already-approved Lilly replay. No extra privileged diagnostic, replay, flag, socket probe or A1 action is authorized by this review. Confirm the final documentation-only head after the P3 cleanup before merge.


## Finding addressed

The P3 validation-accuracy finding was fixed by removing trailing whitespace
and redundant final blank lines from the six evidence logs. Runtime code and
regression tests remain identical to reviewed implementation 708585d2. The
final documentation-only commit is submitted to the same independent reviewer
for confirmation; the exact confirmed head is recorded in the PR body.
