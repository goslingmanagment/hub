# Disjoint capture/replay selection with bounded budget reuse — author handoff

Author: `/root/review_earnings_parse_fix`, acting as the author of this separate replay task. A different agent must review this code. Independent final reviewer: `/root/fix_preview_scope`.

Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-replay_passes-20260912`.
Base: `31b73a9691f32f8c33c3fe479bca68533c7048d6`.
Status: revision 2 is ready for final independent approval. The coordinator reported 52 passing targeted tests and the revised throughput control; the author ran no DB/Vitest. Final lint and strictness ratchet passed after a type-only fixture annotation correction.

## Problem, rejected first candidate and final design

Zero-version captures previously matched both the dedicated capture pass (`<1`) and replay (`<current`). Unmapped, malformed or unavailable observations could consume both reserved turns while following positive parser debt waited. The first candidate added only the correct lower replay bound. Independent review blocked it because the old overlap also incidentally let replay consume *other valid* zero-version rows: a capture-only corpus lost half its useful per-run capacity. The first candidate's author handoff is retained in `replay_passes-author-v1.md`; review evidence is in `replay_passes-review.md` and its control/candidate JSON files. That blocked candidate is superseded, not the release proposal.

The final change keeps the two selections disjoint and restores bounded reuse of unused allowance:

- Only recursive `pass === "replay"` gets `atLeastParseVersion = Math.max(1, family.minimumParseVersion ?? 0)`. Every unsplit path retains its original minimum. The repository already implements this filter; no SQL repository change or migration is needed.
- The private pass result reports `budgetExhausted`, `pagesUsed` and `reachedEnd`. Every nonempty page counts, including pages whose rows all refuse or fail; an empty query does not consume a page, matching the preceding allocator's `ceil(scanned/pageSize)` accounting.
- Both reserved passes still execute before any borrowing. Their order, first-pass half-page/half-time reservation and second-pass remainder are unchanged.
- If the first pass stopped at its page or half-time allowance, the second left unused pages, and the original deadline remains alive, the first may continue **once** from its still-forward durable cursor. It receives only the remaining total pages and the original deadline. The continuation can be capture or replay, depending on the persisted owed turn.
- A partial/empty page proves end and wraps the cursor. Such a pass is never reentered in the same invocation. If a full final page concealed EOF, the one continuation may discover it with an empty query and wrap, but cannot start over afterward. This prevents repeated poison-prefix visits.
- Before borrowed work, the opposite pass is persisted as owed. The original deadline is checked after the second pass and again after the borrowing marker write, because a marker DB roundtrip can consume the remaining time. A borrowed-page overshoot returns overall budget exhaustion and preserves the marker for restart plus existing cross-family rotation.

There is no new public option, schedule, cursor key/table, migration, flag, persistent payload cache or second loop of borrowing. The private `runFamily` return changed from a boolean to this progress record; its top-level caller still consumes `budgetExhausted` for exactly the same rotation behavior.

## Contracts preserved

Plain CLI replay, exact-observation repair, non-prioritized runs, dry-run, single-page runs, a ceiling of one and families whose own minimum is positive keep their existing eligibility. No observation is deleted, version-reset or terminally stamped to reduce backlog. Account/body repair is read afresh; malformed captures remain at zero until a parser can consume them. Family version bumps retain their scoped cursors and positive replay debt. Body resolution, parser algorithms, account mapping, partition checks, event/checkpoint identities, append-before-stamp ordering and forward-only stamps are unchanged.

A resumed pass starts with the existing cursor API and CAS. No cursor is reset to make borrowing possible. Scope and parser-version keying remain identical, so the same cursors are readable on rollback. Ordinary end-of-traversal wrapping continues to make deferred facts reachable again.

## Files and regression fixtures

- `apps/runtime/src/services/canonicalize-driver.ts`: disjoint lower bound, private progress result and one bounded continuation.
- `tests/canonicalize-pass-partition.integration.test.ts`: **19 expanded real-PostgreSQL cases**, using the actual repository, registry, driver, earnings parser, payload seam, append/checkpoint and stamp. It contains no driver/SQL mock.
- `tests/canonicalize-budget.test.ts`: **5 additional expanded fake-time cases**, plus repository stubs corrected to honor both version bounds.

The PG file covers:

1. Capture-only useful capacity at page caps 3, 4 and 5, with one extra row left pending to prove no overspend and forward continuation after restart.
2. A small positive replay corpus returning unused pages: actual domain-event sequence order proves the positive reserved turn runs before borrowed capture.
3. A poison prefix ending on a partial page or exactly at the first quota's full-page boundary: each row is visited once and stays pending.
4. Unmapped, malformed-money and unavailable-body zero rows before positive replay debt, with reserved progress, persisted restart continuation and end/wrap replayability.
5. Actual late binding and missing-body reference repair. Binding uses the page metadata repository; the observation keeps its null account. Catalog repair reattaches the original synthetic body and still reads it through the real seam; no parse stamp is forged.
6. CLI/non-prioritized/dry/single-page modes, exact zero-row repair, ceiling-one semantics, higher family minimum and version bump.

Real append counts include each projection checkpoint; dry-run counts only would-be drafts as the existing driver does. The missing-body fixture is an isolated disposable-DB pointer to an absent catalog object; no production fact is changed.

The new fake-time cases cover first-pass half-time exhaustion followed by continuation under the original deadline; symmetric replay-first borrowing after a persisted owed turn; borrowed-page overshoot with and without process restart, proving turn persistence and live cross-family rotation; and no forced borrowed first page if the marker write consumes the deadline. The full existing budget suite still pins alternating turns, row indivisibility, total page/wall-clock allowance and family rotation. Every relevant stub now supplies/filters rows using `atLeastParseVersion` as well as the upper bound.

## Coordinator validation

The coordinator reported the earlier narrow candidate's **24 targeted tests passed**, but its independent throughput control blocked release. Those results did not validate revision 2. The coordinator subsequently reported **52 passing tests** in `replay-passes-borrowing-tests.log` and a successful control in `replay-pass-borrowing-control.json`. The serialized command is:

```sh
pnpm exec vitest run tests/canonicalize-pass-partition.integration.test.ts tests/canonicalize-sweep.integration.test.ts tests/canonicalize-budget.test.ts --maxWorkers=1 --no-file-parallelism
```

Then run the combined checkout containing earnings single-parse and webhook catalog batching. Those changes touch different driver blocks, but only a combined check proves their final composition.

The original base driver should still fail duplicate-visit/poison-prefix assertions in the new file. To isolate borrowing, compare against the superseded lower-bound-only driver: capture-only cap cases and small-replay returned allowance must fail there. Keep all other candidate source files intact during either control and restore the full candidate driver afterward.

The reusable no-DB artifact `implementation/replay-pass-throughput-control.cjs` can compare actual driver/parser/registry on base and final candidate with controlled repository/payload/append doubles. It was independently executed for the blocked first candidate, not by this author. The coordinator then confirmed the revised outcomes in `replay-pass-borrowing-control.json`. With pageSize=1/maxPages=4:

| Corpus | Base IDs visited / useful stamps | Revised IDs / stamps |
|---|---|---|
| Four valid mapped zero rows | `[1,2,3,4]` / 4 | `[1,2,3,4]` / 4 |
| Four unmapped zero rows | `[1,2,1,2]` / 0 | `[1,2,3,4]` / 0 |
| Two unmapped zero rows, then two positive replay rows | `[1,2,1,2]` / 0 | `[1,2,3,4]` / 2 |
| Four valid positive replay rows | `[1,2,3,4]` / 4 | `[1,2,3,4]` / 4 |

These are controlled driver results confirmed by the coordinator, not measured production throughput/CPU. A borrowed EOF probe may add one empty repository query; it cannot reread the wrapped prefix. The large non-prioritized webhook backlog is not attributed to this overlap, and its production savings cannot be inferred from these fixtures.

## Static validation and boundaries

Revision 1 passed offline frozen install, targeted lint and unchanged strictness ratchet (1,897 known errors / 120 debt files). Revision 2 also passed targeted ESLint, `git diff --check` and the unchanged strictness ratchet (1,897 known errors / 120 debt files). The only edit after the coordinator's 52-test run was a local test-record type annotation accepting explicit `undefined`; no runtime code changed. No lockfile changes occurred. The author has run no Vitest, DB/Testcontainers, provider calls, production access, commit, push or deploy. The new integration file is included using explicit `git add -N`; shared decisions are untouched.

## Proposed decision note for the same-problem commit

**Keep capture and replay disjoint while sharing their existing allowance.** The prioritized capture pass owns versions below one; its replay pass owns versions at least one, respecting stronger family floors. An unstamped zero-row refusal therefore cannot consume both reserved turns. The driver tracks consumed nonempty pages and observed EOF. After both reserved turns, it may continue the first pass once with unused pages and the original deadline, resuming the same forward cursor. It never reenters a pass that wrapped, and records the opposite turn before borrowed work so overshoot/restart retains fairness. This avoids halving useful capture capacity when positive replay is empty without reopening overlapping selection. Ordinary replay/repair eligibility, parser versions, event identities, durable cursor schema and forward-only stamps remain unchanged. Tests cover refusal/repair, fresh-only and small-replay capacity, partial/full EOF, odd caps and borrowed-time overshoot. No production-wide speedup is inferred from the fixtures.

Quick reference: **Disjoint capture/replay sets keep their reserved turns and reuse unused allowance once, without restarting an exhausted cursor.**

## Candidate identity and rollback

Final patch: `implementation/replay_passes-final.patch`.

Complete `git diff --binary` SHA-256: `88d3fdcccb1f1045527c4915d5a839811531eb532eb994a256fb431c28a07bd4`.

| File | SHA-256 |
|---|---|
| `apps/runtime/src/services/canonicalize-driver.ts` | `30ea50edf6960d928c1f116db401d649fdeeed6c8111f0636fbd7bf9af0989d9` |
| `tests/canonicalize-budget.test.ts` | `122fcd1ba163d020307116962d925f4e4c1ab2c7bdafde77e811dbc099f636c9` |
| `tests/canonicalize-pass-partition.integration.test.ts` | `ab61ff4dc8e4328baec146d797ee999eec2a08c99119f2b79bba447da201991d` |

Code-only rollback restores the previous overlap and allocator; existing cursors remain valid in either direction. No migration, fact rewrite, version reset or config rollback is required.
