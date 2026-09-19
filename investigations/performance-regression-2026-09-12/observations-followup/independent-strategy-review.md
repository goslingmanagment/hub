# Independent review of observation replay optimization strategy

Reviewer: `/root/review_observation_strategy`; not the implementation author. Reviewed release `96a86c1fcdde`, Decisions 276 and 311, Stage 8 replay requirements, migration 0144, the current repository selector and health-floor query precedent, and captured before/failed-guard/proposed-prefix SQL. This review performed no production probes, DB suites or source edits.

## Status

The recursive actual-version plus equality-prefix existence guard is a sound candidate. There is no strategy-level correctness or architecture blocker in `queries-prefix-guard.json`. This is not approval of an unimplemented final diff or a deployment: populated and empty plans, branch eligibility and regression evidence still need review.

## Evidence and rejected alternative

The original first-page selector requests global numeric observation-id order through its monthly primary keys. Captured read-only ANALYZE found three empty families rejecting approximately 2.39 million rows each: stats 1336.363 ms / 998,882 shared-hit blocks; engagement 1507.167 ms / 998,884; command results 1211.588 ms / 998,884. A populated webhook page used 1.085 ms / 46 blocks for 200 rows. These are individual query measurements, not service CPU or throughput estimates.

The first generic range/IN guard is correctly rejected. Its populated webhook query took 1613.257 ms and touched 22,414 shared blocks, versus 1.085 ms / 46 for the original. Adding EXISTS alone is therefore not an acceptable optimization; physical plan shape is essential.

## Correctness argument

Let S be the rows satisfying the existing selector predicates. The recursive CTE discovers every distinct stored parse version inside the original version bounds, using a strict greater-than successor and no arithmetic increment. Every row in S has a version in that discovered set. For that version, a source-bound and (when declared) kind-bound equality probe must find at least one row. Therefore a genuinely nonempty S cannot be rejected by the guard. With only the proposed unscoped predicates, the converse also holds.

Both probes and the unchanged ordered SELECT belong to one SQL statement. There is no application-level check/read race or negative cache. The SELECT retains all original predicates, projection fields, numeric `o.id` order and LIMIT, so a positive guard cannot alter its page. An empty page remains genuine EOF, preserving wrap and durable cursor CAS semantics.

Strict successor discovery covers negative and sparse parse versions, terminates when no successor exists, and cannot overflow by adding one to an integer version. Parse-only discovery is deliberate: adding source/kind filters to that ordered minimum scan can recreate the broad filtered-index walk that this fix addresses.

## Acceptance conditions for the final change

- Keep the optimization local to `listObservationsForReplay`; no driver, cursor identity, parser-version, binding, erasure, provider-read or payload-reader lifetime changes.
- Apply only to the intended first-page, source-defined, unscoped query shape. Check absence with null/undefined semantics rather than truthiness: `afterId: 0` is a real cursor; `accountIds: []` is an explicit empty account set. Exact observation reads retain their original path.
- Preserve `kinds: undefined` and `kinds: []` as unrestricted; repeated kinds have set semantics. For unrestricted kinds, equality on parse/source followed by kind/received ordering matches the remaining index prefix.
- Retain the caller's exact lower/upper comparisons. Do not clamp negatives, enumerate only 0..N, assume contiguous versions, impose an arbitrary version cap, or floor caller bounds.
- Generated SQL must remain parameterized. Every ORDER BY column must stay qualified; the result's text id alias must never determine ordering.
- Production plans must confirm that an empty guard prevents the outer primary-key walk, while the populated webhook case and other first-page families incur only bounded prefix probes. Deep/scoped/exact paths must remain the old SQL path unless separately justified.
- Behavioral integration coverage should compare representative ordered row sets with the old selector: mixed versions/kinds/months, sparse and negative versions, duplicate/empty kinds, lower bounds, a match appearing only in a later kind/version, explicit empty accounts, account intersections, half-open time bounds and strict/deep cursors. Existing capture/replay budget, durable cursor and erasure tests must remain green.

## Architectural assessment

Using the deployed parse-leading 0144 index avoids another large index's write/storage costs and collateral planner risk. A same-statement existence guard leaves traversal and facts untouched; this is preferable to a cache or a new wait state for observations, whose eligibility can change through later account binding. Recursive SQL is more complex than a plain EXISTS, but the actual negative versions/sparse bounds contract and the measured range/ordering failure justify that complexity if final code documents it clearly.

Residual limitation: a genuinely populated but sparse eligible family can still make the original global-id selector scan broadly. This candidate targets the demonstrated completely empty first-page scans; it must not be presented as eliminating every observation read or guaranteeing overall CPU savings.
