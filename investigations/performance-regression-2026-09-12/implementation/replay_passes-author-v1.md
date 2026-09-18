# Disjoint capture/replay selection — author handoff

Author: `/root/review_earnings_parse_fix`, now acting as **author of this separate replay task**. This agent must not independently review its own replay change. Its preceding earnings review was a different assignment.

Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-replay_passes-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Status: candidate and static validation ready; coordinator is running the serialized DB gate. Independent replay review is still required, including the throughput tradeoff below. No runtime result is claimed by the author.

## Problem and code change

The prioritized bounded sweep splits work into new capture (`parse_version < 1`) and versioned replay (`parse_version < current`). A refused zero-version row can therefore occupy both independent traversal budgets. It remains eligible for a second payload read/parse even though it already has a dedicated capture pass. In the minimal observed scenario one pending zero row consumes both pages and prevents a following positive-version replay row from being visited during that run.

Only the recursive `pass === "replay"` now supplies `atLeastParseVersion = Math.max(1, family.minimumParseVersion ?? 0)` to the existing repository API. Every unsplit path retains `family.minimumParseVersion` exactly as before. No repository implementation, migration, cursor identity, cursor persistence/reset/CAS, rotation, page allocation, wall-clock checks, body read, parser, account resolution, append, checkpoint or stamp implementation changes.

The split guard already requires `minimumParseVersion < 1`; the `Math.max` nevertheless preserves a stronger minimum if the recursive seam is later reached under such a family. Families whose minimum is already positive stay on the existing unsplit path. CLI, dry-run, single-page, non-prioritized, exact-observation and ceiling-one replay retain their original ability to read version zero when the family's own minimum permits it.

## Changed files

- `apps/runtime/src/services/canonicalize-driver.ts`: 7 insertions, 1 replacement, only the replay selection floor near `runFamily`'s cursor/query setup.
- `tests/canonicalize-pass-partition.integration.test.ts`: 13 expanded cases using the real PostgreSQL repository, family registry, driver, earnings parser, payload seam, event/checkpoint append and version stamp. No driver or SQL mock is used in this suite.

The new test file is included via explicit `git add -N`. No commit has been made. No shared decision file was edited.

## Test design and coordinator execution

The new integration cases cover:

1. Three variants of the original counterexample: unmapped, malformed-money and unavailable-body zero-version rows, each preceding a valid positive-version earnings row with `pageSize=1` and `maxPagesPerFamily=2`. Each pending row costs one visit; the positive replay row appends and stamps in the same run. The tests then add fresh capture and more replay debt, reset process-local state, prove both persisted cursors advance, wrap them, and prove the original pending row remains eligible at zero on a later cycle.
2. Late binding and catalog-reference repair. Binding repair uses the page metadata repository while the observation keeps its null account. Missing-body repair attaches a catalog object containing the original body; the next visit must still read it through the real payload seam. Neither repair forges a parse stamp.
3. Ordinary CLI, non-prioritized sweep, dry-run and single-page modes with both zero and positive versions. Dry-run preserves all versions and writes no checkpoint; real appends count both the earnings draft and its projection checkpoint.
4. Exact-observation replay at zero, an explicit ceiling of one with its existing stamp semantics, a family's higher minimum that excludes unsettled rows, and a version bump reopening positive replay debt beside new capture.

The unavailable-body fixture uses a pointer to an absent catalog object in the disposable test DB; no production row is modified. Its repair retains the original synthetic payload. The driver must report `skippedUnavailable`, not treat missing bytes as an empty body or a parser refusal.

Coordinator command, serialized with every other Vitest/DB run:

```sh
pnpm exec vitest run tests/canonicalize-pass-partition.integration.test.ts tests/canonicalize-sweep.integration.test.ts tests/canonicalize-budget.test.ts --maxWorkers=1 --no-file-parallelism
```

For the negative control, keep the new test file and use the complete base driver. The three refusal/restart cases and two repair cases should fail their first work-count assertion because the base visits each pending zero row twice. The other eight cases describe compatibility behavior and should stay green. Restore the candidate driver before subsequent validation. The coordinator can also run the same suite in the final combined checkout so the earlier earnings single-parse and webhook catalog-batching changes are exercised together.

The existing budget suite remains important: it already pins persisted alternating turns after overshoot, process restart, shared page/wall-clock budgets and family rotation. This patch does not introduce a replacement allocator.

## Throughput tradeoff that requires independent review

**This is not only removal of duplicate visits in every possible workload.** The old overlapping replay pass could also process *other* valid zero-version captures after the first half stamped earlier captures. Making the replay set disjoint removes that incidental borrowing. The coordinator explicitly requested keeping the allocator unchanged until this effect receives causal review.

Concrete reproduction: the actual earnings family has version 7, `prioritizeUnparsed=true`, no minimum; enable sweep cursors, use `pageSize=1`, `maxPagesPerFamily=4`, no wall-clock expiry, empty initial cursors, and seed IDs 1–4 at version zero. If all four are valid and mapped, the capture pass processes/stamps IDs 1 and 2. The old replay pass then sees the remaining eligible zero rows 3 and 4 and stamps them too. The candidate's replay floor 1 sees no positive-version debt, so it leaves 3 and 4 for a later capture pass. Useful stamps in this run are therefore expected to change **4 → 2**, with no data loss and no lost cursor progress. At the default 20 pages × 200 rows the analogous page ceiling changes 4,000 → 2,000 fresh observations per run in a pure, sufficiently large valid-zero backlog, assuming the wall-clock deadline is not the limiting factor. This is a capacity effect, not a measured production workload or latency regression.

For contrast, if all four zero rows are unmapped, the old pass visits `[1,2,1,2]` and stamps nothing; the candidate visits `[1,2]` and also stamps nothing. If IDs 1–2 are unmapped zero rows and 3–4 are valid positive-version replay rows, the candidate replaces the duplicate zero visits with useful work on 3–4. If all four rows are already positive and replayable, both implementations give replay the full unused capture allowance. A family minimum ≥1 does not enter the split branch and is unaffected by this tradeoff.

A separate **unexecuted diagnostic artifact** makes those four states reproducible without choosing the preferred allocator policy:

`/Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/replay-pass-throughput-control.cjs`

It is derived from the original audit fixture: actual driver/parser/registry via TypeScript evaluation, with controlled repository/payload/append doubles. Run it once against the untouched baseline audit checkout and once against this candidate (or combined release checkout):

```sh
node investigations/performance-regression-2026-09-12/implementation/replay-pass-throughput-control.cjs /Users/dmitriy/code/goose/.worktrees/hub-regression-audit-20260912
node investigations/performance-regression-2026-09-12/implementation/replay-pass-throughput-control.cjs /Users/dmitriy/code/goose/.worktrees/hub-perf-replay_passes-20260912
```

The artifact reports visits, selected IDs and stamps; it deliberately asserts neither allocator policy as preferred. It is investigation evidence, not a product/test commit file. The author did not execute it. Production percentages or impact on the large webhook orphan corpus cannot be inferred: that webhook family does not enable `prioritizeUnparsed` at all.

## Author validation and boundaries

- `pnpm install --offline --frozen-lockfile`: passed, no lockfile change.
- Targeted ESLint for both changed files: passed on final candidate.
- `pnpm typecheck`: passed at **1,897 known errors across 120 debt files**, unchanged strictness-ratchet baseline. Initial new fixture nullability errors were fixed with explicit prerequisite/model/page guards. This does not claim a clean `tsc`.
- `git diff --check`: passed.
- No Vitest, DB/Testcontainers, provider network, production mutation/read, commit, push or deployment was run by the author. The coordinator owns runtime gates.

## Proposed decision note for the same-problem commit

Title: **Keep prioritized capture and versioned replay selections disjoint**.

The sweep's dedicated capture pass owns versions below one; its recursive replay pass now reads versions at least one while respecting any stronger family minimum. Previously an unstamped zero-version refusal could spend both traversal allowances and delay a following positive-version replay row in the same run. The repository's existing lower-bound filter implements the separation. Ordinary replay, exact-row repair, non-prioritized runs, dry-run and single-page sweeps keep their original floors, so no pending fact is terminally classified or stamped to remove work. Cursor identities and fairness/expiry budgets are unchanged. This intentionally does not introduce budget borrowing: with only a large valid-zero backlog, the reserved replay allowance is unused and per-run useful capture capacity can be lower than under the former overlap. That tradeoff must be accepted by independent review before release; no production throughput improvement is claimed from selection tests alone.

Quick reference: **The prioritized replay pass excludes zero-version capture debt; plain replay and repair remain unchanged, with the existing split-budget capacity tradeoff recorded.**

## Candidate identity and rollback

Complete `git diff --binary` SHA-256: `296a8041bfc22879debaace8c67bac99f48c95978773fe1578b8cfac13427cfc`.

| File | SHA-256 |
|---|---|
| `apps/runtime/src/services/canonicalize-driver.ts` | `6ee2339477822b4e929734758b452fcc9a22e34eefcdf591b8a232ccd8cb59c0` |
| `tests/canonicalize-pass-partition.integration.test.ts` | `0a6d22e2a32737151b134b8d82c6ee092e0f5532d42db74ad068e7f6fecea8dd` |

Code-only rollback restores overlap. Persisted cursors use identical keys and remain valid in either direction; a zero row behind an existing cursor is revisited after the normal wrap. No migration, fact rewrite, version reset or flag rollback is needed.
