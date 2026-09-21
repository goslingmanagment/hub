# Fable follow-up on implementation fixes

Model: claude-fable-5-1; one focused turn using the supplied patch and source; successful; no permission denials.

**Verdict: M1, M2, L1, L2, L3 and L4 are all correctly addressed. No remaining blockers in this patch.**

**M1.** The three deferral sites in the catch now go through a wrapper that swallows only a `HintDeferred` thrown by the deferral itself. The ownership wrapper still asserts the lease first, so a lost lease surfaces as a plain error and propagates. The comment correctly states why swallowing is safe: the stale claim expires or is reset by the next routed event under the new generation. The parameterized test proves both halves: generation rotation lets the chunk complete and ordinary polling continues, while lease loss still fails the chunk. Applied revision stays at zero in both cases.

**M2.** The new case turns A1 off after a completed sweep, fails the first fetch, and asserts the fresh checkpoint carries the prior boundary with zero pages read. Since no page write happened, that assertion can only be satisfied by the initial-checkpoint diagnostics line, so deleting it now fails the test. The resume assertion closes the loop.

**L1.** Treating a non-null `hot_applied_at` as materialized in the evidence CTE removes the counterexample. The completion gate still ignores that column, but that is consistent: any receipt with the stamp already has its revision applied, so the gate's `routed_revision > applied_revision` filter excludes it. The test reproduces the exact pre-0205 shape and confirms the result stays `rest_materialized`.

**L2.** The early return happens before `inspectBinding`, and the test asserts the inspector is never called. The blocked-but-matching case still reports `auth_refused`.

**L3.** The content digest is gone, the envelope hash stays, and the empty partner ref is filtered before the fence check. The test asserts the property is absent rather than merely null.

**L4.** The null check precedes the page comparison, so a blocked preview now reports the real reason.

Two things to confirm outside this review, neither a blocker:

- **Type check the preview return.** The early return sets `binding` to null. Vitest does not type check, so run tsc to confirm the preview result type allows a null binding.
- **Unused import.** The manifest test may now import `createHash` without using it. Lint will catch it if so.
