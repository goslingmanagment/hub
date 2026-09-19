# Independent integration review — preserve intervening production release

Verdict: approved for integration, with deployment still subject to the root's validation and current-production check. Reviewed the resolved staged/working tree, not merely a proposed merge. No application or repository file was changed by this reviewer and no tests or production commands were run.

Production 4310680dc2f923955295f85491eb6cf43d9bb82a has parents 96a86c1f and c189da3f. Its delta from 96a86c1f is 14 files: DM shadow diagnostic state/counting, the retained-corpus analyzer, four test files, documentation and prior review evidence. It touches no canonicalization driver, replay repository selector, payload reader, database schema or migration. Our fix 14219b68f81515e4619e6860b7bf704c85c52922 touches only the replay selector, its new integration test and decisions.md. The only intersecting path is the decision log.

The DM shadow delta adds six bounded scalar reason counters. Counts start at zero only with complete measurement coverage; legacy or partially observed history remains null. The exhaustive typed reason map counts both unread reasons once per conversation and preserves the generic discrepancy count, rollback checks and material checks. It does not alter provider calls, stop decisions, business checkpoint completion or stored-head repair. The offline analyzer marks three runtime-only categories unknown. Existing added tests exercise the two-unread case, pre-stop exclusion, pre-apply reasons surviving repair, legacy resume, partial initialization and the offline/runtime distinction. Nothing in these semantics depends on or rewrites observation-replay eligibility. Our same-statement existence guard changes only lookup work and cannot modify these diagnostic counters directly.

Resolved-tree verification:

- Relative to 4310680d, the only differing tracked paths are docs/decisions.md, packages/db/src/repositories/domain-events.ts and tests/observations-replay-head.integration.test.ts.
- Source and test bytes exactly match the reviewed/passed 14219b68 commit. Source SHA-256 is 66840f0208b377716f30ffc9905498b55daa18737c393fe56f53843ca59c1957; test SHA-256 is 38152cb30642bf9a0e214916a00f7037938fe00f557a7fcb269316f15712093b.
- No unmerged or unstaged tracked paths remain. All 4310680d content outside those three paths is preserved.
- Decision 313 and its quick-reference row remain byte-identical. Its reservation of 312 for C2a remains intact. Our row and body are appended as 314; the original reviewed body is otherwise byte-identical. Removing our new row and appended body recovers the entire 4310680d decision log exactly.

A focused composed validation should include observations-replay-head.integration.test.ts with dm-shadow.test.ts, dm-shadow-cursor.test.ts, dm-shadow-corpus.test.ts and fansly-dm-shadow.integration.test.ts, in the repository's single-suite order, plus the root's normal static/build gates. No new integration-specific test is warranted solely for this nonoverlapping merge. The root should retain the already completed test evidence for each parent and verify the final combined revision.

Measurement consequence: the earlier baseline belongs to 96a86c1f. Preserve it as historical evidence, but use a fresh predeclared window on 4310680d against the merged deployment for the release-level comparison. This keeps the intervening A0 instrumentation constant on both sides. The source-level same-snapshot query pair remains valid because the replay selector and query inputs are unchanged by A0, while whole-service CPU remains workload-sensitive.

The final committed merge ea7a629ceb3ccad1e6456210181469fa27057ab6 was also inspected: parents14219b68/4310680d, exactly three changed paths and316 additions versus431, clean working tree, and source/test diff against142 empty.
