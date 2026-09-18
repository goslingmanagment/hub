# Binding-wait body work: author handoff

Candidate worktree: `/Users/dmitriy/code/goose/.worktrees/hub-perf-binding_wait-20260912`, based on production `31b73a9691f3`. No commit, push, deploy, production mutation, Vitest or database process was run by this author. Root owns serial database validation and an independent agent owns review.

## Problem and scope

The OFAPI webhook sweep repeatedly loads and parses successfully understood observations whose events cannot be attributed to an account yet. A prior live 30-minute sample counted 116,533 `skippedUnmapped` out of 116,736 visits; it did not measure body-reading or parser CPU separately. The fix does **not** claim to eliminate those SQL visits or save 99.8% of total work.

After one successful nonempty parse, a bounded page batch records a rebuildable negative result. The next identical sweep still visits the same observation and advances the same keyset cursor; the repository returns an explicit `bindingWaitUnchanged` marker and SQL NULL for its payload. The driver counts it in both `skippedUnmapped` and the new subset `skippedUnmappedCached`, without calling the payload seam or parser. `parse_version` is unchanged.

Only the existing OFAPI webhook family opts in initially. Other families retain their current path. Inline bodies **without any catalog reference** are eligible. Reference-backed bodies, pointer-only bodies, families with `replayContext`, exact receipt runs, CLI replay and dry runs bypass the optimization. Thus catalog read-mode/availability/parity behavior and accepted-post ledger context are not negative-cached.

## Invalidation and correctness

- The first parse and shape gate remain mandatory. Zero drafts stamp normally; shape refusal, body unavailability, parser error and partition refusal never create a waiting hint.
- The context fingerprint covers both per-run binding maps and the quarantine conflict set, sorted deterministically. Current/historical association, conflicting/missing transitions, and native-account context changes invalidate the hint. A binding change during a sweep is observed on the next run exactly as before; the map was already one snapshot per run.
- The parser family version is matched separately. Parser changes remain subject to the existing family-version contract. The implementation changes no parser version or event dedup key.
- PostgreSQL computes an observation signature from every parser-visible envelope field, native reference, parse version, the capture-time body hash, storage reference, and inline-presence bit. No body is hashed or materialized for that comparison. The capture journal is immutable; a body repair must either re-journal or maintain its capture hash. The repository has no API to rewrite source facts.
- The batch remember operation rechecks that exact signature and inline eligibility in the same SQL statement before writing its hint. A concurrent metadata/storage change therefore cannot install a result for a row different from the one parsed. Overlapping writers can at worst replace one valid context hint with another; a matching current context still represents a proven nonempty/unmapped parse.
- Team-level exports are classified only **after** their `account_ids` have been parsed and checked. No events are appended until every named target is mapped. Changes to any binding invalidate the hint and the original export routing/erasure fence runs again.
- The query adds a LEFT JOIN and conditional **projection**, not a WHERE exclusion. Page size, visit budgets, wrap behavior, errors, priority between families and source ordering stay intact. This avoids scanning the whole waiting corpus merely to fill a page.
- Hint updates fail open: a failed batch only logs a warning, does not stop cursor advancement, and leaves raw facts eligible for a fresh read. A rollout still requires migration 0187 before the new query is deployed, as usual.

## Storage and rollout costs

Migration 0187 creates an initially empty table. No source table rewrite or historical migration/backfill is required. Each attempted page writes up to 200 hints in one ordered batch during the first sweep; later identical hits do not write hints. A parser/context change may repeat the fill. It therefore has a one-time row/WAL/index cost and an additional indexed join plus small metadata SHA-256 cost on reads; root must inspect the benchmark before accepting it.

The table holds one entry per `(family, observation_id, received_at)`, not a new entry per parser version, binding change or run. It stores only IDs, receipt time and SHA-256 values: no body, draft, raw provider reference or user text. Successful background reprocessing clears that page's hints with a batch operation. The deletion allowlist pins this new repository to `canonicalize_binding_wait` only. Source facts, keys, events and replay state are never deleted by it.

This is **bounded by the corpus ever classified**, not a fixed-size cache: a fact consumed by an exact/CLI run or removed by an existing erasure workflow can leave an inert hash-only hint. There is deliberately no new timer or source-table FK (which would couple partition detach to this optimization). Such rows do not participate in scans without their source observation. The benchmark reports actual table/index size; a later explicit rebuild may discard these derived hints without affecting facts. No claim of zero storage growth is made.

The deploy rollback allowlist includes the additive table: old runtimes ignore it. A runtime rollback restores the prior repeated work, with source facts and versions unchanged. No configuration flag is flipped by this change.

## Validation prepared

Commands must run from the candidate worktree, one database/Vitest suite at a time:

```sh
pnpm exec vitest run tests/canonicalize-binding-wait.integration.test.ts tests/canonicalize-sweep.integration.test.ts tests/canonicalize-budget.test.ts tests/retention-deleters.test.ts --maxWorkers=1 --no-file-parallelism

node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/binding-wait-benchmark.mjs --run-local
```

The benchmark starts/stops its own local PostgreSQL 16 container and accepts no DSN. It runs the full migration chain, seeds 4,000 real-shaped OFAPI webhook bodies (8 KiB varying text each), and invokes the **actual repository SQL, payload seam, registry parser and driver**. It compares disabled controls, enabled first fill, two warm runs (one after runtime reset), and disabled-after-warm. It records wall time, database execute time, body bytes returned, canonicalizer calls, all result counters, exact cursor positions, hint row/storage size, and actual first-page EXPLAIN ANALYZE/BUFFERS. Body-byte instrumentation uses seeded sizes, avoiding a second JSON serialization inside the timing loop. “Cold fill” refers to empty hints, not a cold OS cache.

| Case | Expected invariant |
| --- | --- |
| Repeat unchanged unmapped body | Same visited rows, no stamp, SQL payload NULL, one parse across two sweeps |
| Late binding repair | Fresh parse, original event/provenance, stamp and hint cleanup |
| Optimization enabled/disabled | Same result fields except hit subset, domain events, parse versions and durable cursors |
| Parser bump and body/envelope changes | Fresh payload and classification; replacement of one hint, not accumulation |
| Exact receipt, CLI, dry run | Payload always read; dry run writes neither hints nor stamp |
| Binding context and isolated conflict-set change | Reparse even when target remains unmapped |
| Multi-account export | Wait for every target, then append once per target |
| Zero draft and shape refusal | Existing stamp/refusal behavior, no hint |
| Added catalog reference / missing pointer body | No cache hit; unavailable body remains transient and unstamped |
| Accepted-post replay context | No hint reuse |
| Concurrent envelope mutation before remember | Old signature refused |

Author-side checks passed: offline frozen dependency install, changed-file ESLint, strictness ratchet (1,897 existing errors within debt budget), `git diff --check`, shell syntax and benchmark syntax. These are not database or runtime validation. Root test receipts should be attached separately.

## Other fixes and proposed decision

The earnings single-parse change and disjoint unparsed/replay passes touch other branches of the same driver. They are independent: only OFAPI webhook opts into this hint, and that family does not set `prioritizeUnparsed`. This patch neither changes their parse API nor the query's existing `atLeastParseVersion` input. Root should resolve any textual merge overlap without broadening eligibility.

Proposed decision text for the coordinator to append once reviewed: “Unchanged OFAPI webhook binding waits keep replay debt and normal bounded visitation while omitting repeated inline body transfer and parsing. Only a previously successful nonempty parse may establish a rebuildable hint; the full binding context/conflict set, parser version and immutable capture/envelope identity invalidate it. Exact/dry replay, catalog-backed bodies and ledger-context families always read retained bytes. Migration 0187 adds hashes-only optimization state, and `skippedUnmappedCached` reports avoided body work without claiming fewer source visits.”
