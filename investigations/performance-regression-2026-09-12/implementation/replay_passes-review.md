# Disjoint canonicalization passes — independent review

**BLOCKED: restore use of the remaining capture allowance before release.** The new replay predicate is correct, but the eight-line candidate introduces a concrete useful-throughput regression when positive-version replay is empty or small.

Reviewer: `/root/fix_binding_wait`, not the author. Reviewed `/Users/dmitriy/code/goose/.worktrees/hub-perf-replay_passes-20260912` against `31b73a9691f32f8c33c3fe479bca68533c7048d6`, including `tests/canonicalize-pass-partition.integration.test.ts`. No source changes, database, suites or production actions were performed. I independently executed the supplied in-memory diagnostic, which transpiles the actual driver/parser and supplies controlled repository/append doubles.

## Blocking finding

**[P1] Fresh valid captures lose half their service capacity once replay excludes version zero.**

Relevant lines: `apps/runtime/src/services/canonicalize-driver.ts:443–456` and the new predicate at `:462–484`. The first turn still receives `floor(maxPages/2)` and half the remaining time; the second receives unused allowance. Before this change, the second/replay turn could use that allowance on *different valid zero-version rows*, because the first turn had stamped and removed its successfully processed rows from eligibility. With `parse_version >= 1`, an empty positive replay returns immediately and the unused allowance is discarded. Both turns then reset to capture-first, so this repeats every normal run.

Independent same-code control (driver blob `764b634811040b22f4363c5c5bd68b1ad959b020`, equal to production 31b73a96) versus candidate, with pageSize=1, maxPages=4 and no elapsed-time pressure:

| Corpus | Before: reads / useful stamps | Candidate: reads / useful stamps |
| --- | --- | --- |
| Four valid mapped version-zero observations | `[1,2,3,4]` / **4** | `[1,2]` / **2** |
| Four unmapped version-zero observations | `[1,2,1,2]` / 0 | `[1,2]` / 0 |
| Two unmapped zero rows, then two version-six rows | `[1,2,1,2]` / 0 | `[1,2,3,4]` / **2** |
| Four valid version-six observations | `[1,2,3,4]` / 4 | `[1,2,3,4]` / 4 |

The latter cases establish the intended benefit and replay-only parity, but do not cancel the first case. Exact evidence is in `replay-pass-review-control.json` and `replay-pass-review-candidate.json`; both commands exited zero. The script is `replay-pass-throughput-control.cjs`. This is a count/eligibility experiment with the real driver and parser, not a DB or wall-time benchmark.

With the actual default 20 pages × 200 rows, the first case implies a reduction from **up to 4,000 to up to 2,000 successfully processed fresh observations per family invocation**, when paging is the bound and enough run time remains. Both earnings and sync-pull opt in; the latter carries DM capture. A repaired backlog of valid zero-version rows can take roughly twice as many family invocations to drain, and sustained arrivals between those capacities can accumulate where they previously drained. These are conditional capacity consequences, not measured production arrival rates or an assertion that every isolated repair doubles its latency. Other families may use the released time, but that does not restore this family's lost capacity or its fresh-DM service.

Decision 279 explicitly shares the existing allowance between capture and replay to protect freshness. A performance fix should not silently turn that shared allowance into a permanent half-cap whenever replay is empty. Root agreed this is a release blocker.

## Minimal safe borrowing proposal

Keep the disjoint selections. After both reserved turns have run, permit the first pass to resume once using remaining page allowance and the original overall deadline **only if its traversal stopped at the page/time allowance rather than reaching the end/wrapping**. Resume its existing durable cursor; never re-enable version zero in the positive replay pass.

The private pass result should expose enough progress/stop information to distinguish “more may exist after the last full page” from “end reached.” This can stay local to `runFamily`; no scheduler, table, public option or new cursor namespace is needed. If the first turn ended on a partial/empty page, do not re-enter its newly wrapped cursor in the same run and repeat poison rows. Check the overall deadline before invoking the borrowed pass, because the callee intentionally always allows its first page. Charge borrowed pages to the same total and preserve CAS plus the next-pass turn marker before work, including crash/page-overshoot behavior. Both reserved turns must keep precedence over borrowing.

A symmetric resumption of whichever pass ran first is preferable to an ad hoc capture-only retry: after an overshoot/restart the first pass can be positive replay, and an empty second capture pass should not waste its remainder either. Do not widen this into an unbounded loop; one bounded continuation after both turns is sufficient for this regression.

Required proof before re-review: all-valid capture-only and replay-only runs use the available cap; a small/empty second pass returns its unused share; pending zero rows cannot consume the reserved positive replay share; partial/end/wrapped cursors do not repeat within the same run; odd page caps remain bounded; a borrowed-page overshoot/restart preserves turn and family fairness; CLI/dry/exact modes retain their current behavior. Existing fake-budget repository stubs should honor `atLeastParseVersion`, otherwise a passing test can still feed zero rows to the supposedly positive pass.

## What is otherwise correct

- Only recursive `pass === "replay"` gets `>= max(1, minimum)`. Ordinary replay, CLI, dry runs, explicit single-page sweeps, a version ceiling of one and families with higher minimums do not enter the split path; their eligibility remains intact.
- The two domains are disjoint and together retain the previously eligible versions. Unavailable, unmapped and unparseable zero rows stay in the unparsed pass, unstamped and reachable after durable wrap. There is no data deletion or terminal negative stamp.
- Existing scope keys, page ordering, current-version stamps and event dedup remain unchanged. A parser bump creates the same new version-scoped traversal; an old positive cursor pointing at a formerly visited zero row still works as an ID boundary and wraps normally.
- Reserving positive replay work fixes the verified same-tick duplication and delayed positive debt, not proven infinite starvation. The new integration scenarios appropriately cover body/binding repair, restart/wrap, refusal classes, parser upgrades and unsplit modes. They currently omit the useful capture-only throughput case above.
- The predicate itself is an appropriate small architectural correction. Approval is withheld for the allowance interaction, not for the disjoint-pass design.
