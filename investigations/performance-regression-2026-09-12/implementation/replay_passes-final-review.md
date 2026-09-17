# Disjoint replay passes with bounded borrowing — final independent review

**APPROVE.** The revised source closes the useful-throughput blocker from `replay_passes-review.md` while keeping the capture/replay selections disjoint. No correctness, regression, code-quality or architecture blocker remains in the reviewed candidate. This is independent source/test review; the coordinator owns the serialized execution and final combined-release gates.

Reviewer: `/root/fix_preview_scope`, not the replay author. Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-replay_passes-20260912`, against `31b73a9691f32f8c33c3fe479bca68533c7048d6`. I read the complete three-file diff, current driver and repository call path, cursor CAS, Decision 276/279, Stage 8, the previous blocking review, and all added integration/budget cases. I changed no source and ran no suites, DB, production actions, commits or deployment. `git diff --check` passed.

## Why the previous blocker is closed

`runFamily` now reports private progress as `{budgetExhausted, pagesUsed, reachedEnd}` (`canonicalize-driver.ts:399–405`). The first reserved pass still receives half the pages and half the remaining time. The second gets the unused allowance. After both reserved turns, the first can continue **once**, using only the remaining pages and the original deadline (`:452–483`). Four valid zero-version rows with a four-page allowance therefore use two initial capture pages, an empty replay query, then two continuation pages. The prior candidate stopped after the first two useful rows.

This is symmetric: if a crash/overshoot left positive replay owed first, an empty capture turn returns its remainder to that positive traversal. A small second pass consumes its actual nonempty pages, then returns the rest. Both reserved turns always precede borrowing. No extra family page allowance, fresh wall-clock budget, unbounded loop, scheduler, persistent cache, public option or cursor namespace was added.

## Correctness and regression checks

- **Disjoint eligibility and repair:** only recursive positive replay adds `>= max(1, family minimum)` (`:492–520`), through the repository's existing qualified SQL predicate. Its companion still selects `<1`. Unmapped, unavailable and unparseable captures remain unstamped and reachable after a normal wrap; positive debt cannot spend its reserved turn repeating those zero rows. CLI, exact-receipt usage, dry-run, non-prioritized/single-page runs, ceiling one and higher family minimums keep their existing traversal. The cursor key and version stamp are unchanged.
- **One forward continuation, no poison-prefix restart:** each nonempty page costs one page, regardless of refusal or row error; an empty query costs zero (`:530–538`). Empty/partial pages set `reachedEnd` and wrap through the existing CAS. Such a first pass is never borrowed. An exact full page at the quota boundary may need one subsequent empty probe to discover EOF, but the continuation returns there; it cannot enter the newly wrapped head again in this invocation. No negative consumption stamp or deletion avoids work.
- **Time and fairness:** the parent checks the original deadline after each reserved turn, then again after the borrowed turn-marker write and after borrowed work (`:461–482`). This is necessary because a leaf deliberately guarantees its first page. The opposite turn is persisted before borrowed work, so a crash or page overshoot retains the other pass's priority. An overshoot returns `budgetExhausted` before the normal capture-first reset, preserving the existing outer family rotation. Pages still finish in full; no mid-row cutoff was introduced.
- **Custody and concurrency:** borrowing reloads the same durable observation cursor and uses the same revision-CAS advancement after each attempted page. Stale progress still throws instead of replacing another traversal's progress. The existing crash/retry and dedup semantics remain; no cursor reset is part of the patch. Source/body resolution, parsing, partition checks, account attribution, erasure checks, canonical append/checkpoint and stamp branches are untouched.
- **Code and integration:** the progress structure stays private and has exactly the information the existing allocator needs. Replacing the first result after continuation does not lose page charges: remaining pages were already decremented for the reserved work. The outer driver still consumes only `budgetExhausted`. The earnings single-parse change lives inside the unchanged row-processing block; the webhook batch change belongs to the read stage. They are logically compatible, but the final combined checkout must run the coordinator's gates after integration.

## Verification coverage inspected

The new real-PG file has 19 expanded cases. Capture-only page caps 3/4/5 prove odd/even full useful capacity and next-run continuation; a small positive backlog asserts canonical event order before returned capture work. Partial-EOF and exact-full-EOF poison fixtures assert each failed row is visited only once. The original refusal/restart/wrap, binding/body repair, parser bump and unsplit-mode cases remain.

The expanded fake-clock budget suite now honors both version bounds. It covers half-time continuation under the original deadline, replay-first borrowing, borrowed-page overshoot with and without process reset, and expiration during the borrowed marker write. The existing page-completion, shared-budget, cursor and family-rotation tests remain. These test bodies exercise the identified failure modes rather than merely duplicating the new return object.

I inspected the coordinator's new execution receipt `replay-passes-borrowing-tests.log`: **3 files, 52 tests passed**, in this author checkout. I also inspected every query/result in the actual-driver diagnostic `replay-pass-borrowing-control.json`: valid capture-only reads `[1,2,3,4]` and stamps all four; positive-only does the same; two refused zero rows followed by two positive rows read each once and stamp the two positive rows; four unmapped zero rows advance through `[1,2,3,4]` once and retain all four at zero. In the capture-only case the borrowed query resumes at `afterId=2`, and every positive query carries `atLeast=1`. This directly closes the former 4-to-2 capacity counterexample. The diagnostic uses controlled repositories/body/append doubles and is not a DB performance benchmark. I did not launch either execution.

After that execution the author corrected one test-only type annotation from optional `atLeast?: number` to explicitly present `atLeast: number | undefined`, matching the fixture's existing object values under exact optional-property typing. I verified that replacing just that annotation reconstructs the previously reviewed unit-file SHA-256 exactly. Runtime and integration-file hashes are unchanged. No runtime re-review blocker arises from this annotation correction; the final identity is below.

The count-based conclusion is restored use of available page/time allowance and removal of duplicate zero visits across passes. This review does not claim production latency, CPU percentages or a hard wall-clock limit: existing in-flight pages may overshoot the deadline.

## Reviewed identity

| File | SHA-256 |
| --- | --- |
| `apps/runtime/src/services/canonicalize-driver.ts` | `30ea50edf6960d928c1f116db401d649fdeeed6c8111f0636fbd7bf9af0989d9` |
| `tests/canonicalize-budget.test.ts` | `122fcd1ba163d020307116962d925f4e4c1ab2c7bdafde77e811dbc099f636c9` |
| `tests/canonicalize-pass-partition.integration.test.ts` | `ab61ff4dc8e4328baec146d797ee999eec2a08c99119f2b79bba447da201991d` |
