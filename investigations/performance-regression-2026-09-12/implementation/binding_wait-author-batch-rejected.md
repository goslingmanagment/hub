# Binding-wait body reads: revised author handoff

Candidate: `/Users/dmitriy/code/goose/.worktrees/hub-perf-binding_wait-20260912`, based on production `31b73a9691f3`. The author ran no database, Vitest, production action, commit or deployment. Root owns serial database validation and an independent agent owns review. The candidate is not approved for release merely because static checks pass.

## Rejected design and actual applicability

The persistent `canonicalize_binding_wait` hint design is **withdrawn**. Migration 0187, its hint writes, query join, counters and fixtures have all been removed from this candidate. `binding_wait-author-rejected.md`, `binding-wait-rejected.patch` and the earlier `binding-wait-benchmark.*` preserve the rejected evidence. Its synthetic inline benchmark did show less body transfer, but review found a deep-page prefix rescan and its 8 KiB inline corpus did not establish benefit for the historical pointer-only prefix. There is no schema migration or persistent optimization state in the revised patch.

`binding-wait-canonical-eligibility.json` samples only canonical webhook kinds with pending parse debt and no account. All first 2,000 sampled rows had a catalog reference and no inline body. All latest 2,000 sampled rows had an inline body and no reference. Roughly 91% in both slices were presence events; the latest bodies were typically about 520 B for presence and 2 KiB for messages. These are bounded slices, not a census. The earlier 116,533 unmapped / 116,736 visits statistic does not establish the pointer/inline split or time spent reading bodies.

The concrete avoidable cost is one catalog query for every pointer-only visit, even when the next visit is another adjacent pointer row. The fix batches these **fresh reads**, retaining all body bytes and all parser calls. It does not skip observations or promise a reduction in parser CPU, SQL visits to observations, or total production CPU proportional to the unmapped percentage.

## Implementation and bounds

- The existing envelope-authorized catalog read seam gains a bounded batch counterpart. Callers still provide the envelope kind and references read off authorized envelope rows; there is no new service API accepting arbitrary bare object IDs.
- Only the canonical webhook driver uses the new page-scoped row resolver. A group covers at most eight consecutive rows of the already selected page. Inline rows and dual-copy rows keep the original single-row path, including the same shadow comparison and serve fallback. Other families retain their original call path.
- Two or more pointer-only rows in that group produce one catalog query. One remaining pointer row uses the original query. Duplicate references retain their input positions and separate decoded JSON values.
- The SQL uses a `VALUES` input and one correlated `LATERAL ... LIMIT 1` lookup per reference. Both object and JSON-body keys include bucket month and object ID. There is no cursor-prefix join; the benchmark checks first and deep groups with `EXPLAIN ANALYZE`.
- Objects with more than 512 KiB of canonical logical JSON bytes return a deferred marker and use the ordinary single-row reader. At most eight small JSON bodies, at most 4 MiB of their canonical bytes, are returned by a batch. PostgreSQL JSON serialization and decoded JavaScript heap overhead are additional; this is not a 4 MiB RSS claim. A single large body can coexist with the remaining small prefetched bodies, so the bound is the previous single-body behavior plus at most seven small bodies. Slots are released as rows are consumed.
- The current webhook route has no custom `bodyLimit`; the installed Fastify 5.8.5 default is 1,048,576 wire bytes (`node_modules/.pnpm/fastify@5.8.5/node_modules/fastify/lib/config-validator.js`). The independent 512 KiB batch threshold does not rely on that limit: older observations and other ingest paths can have larger bodies. No ingest limit changes.

## Correctness and failure semantics

Each group uses a fresh catalog SQL snapshot. There is no reuse across pages or runs, and no positive or negative result is persisted. A body removed or repaired after a group snapshot is seen on the next visit; this is bounded prefetch within the current page, not a claim that all eight reads occur at each row's later processing instant. The existing append/erasure fences and fact custody remain unchanged.

Reference values are copied before the asynchronous query and checked again before each result is consumed. A changed row reference uses the ordinary current-reference read; an answer from the old reference cannot be attached to the replacement. Body availability is decided by the joined body key, not by the value being JSON `null`. Missing objects, missing bodies and representation mismatches remain the same explicit unavailable outcomes. Large bodies are deferred, never classified as missing.

A failed batch falls back to individual reads. The ordinary seam retains ownership of per-row counters, warnings and `CapturePayloadUnavailableError`; one batch connection error does not classify all eight observations as unreadable. If an individual fallback also fails, that row stays transient and unstamped while healthy siblings continue. Successful runs issue fewer queries; a transient batch failure adds one failed query before the existing per-row behavior.

Every resolved row still runs the original parser, binding checks, team-export target checks, event append, dedup and stamp handling. Valid zero-draft bodies retain the existing stamp semantics. Unavailable bodies still throw before parsing and cannot be stamped as zero drafts. Late binding and parser version changes need no cache invalidation: the original logic runs on every visit. Dry runs and CLI replay use the same body semantics; exact one-row replay naturally uses a single catalog read. No parse version, event dedup key, source fact, traversal budget or durable cursor algorithm changes.

## Validation and commands

Author-side checks passed after the redesign: changed-file ESLint, `git diff --check`, benchmark syntax and `pnpm typecheck` strictness ratchet (1,897 existing errors, no new debt). These are static checks, not DB/runtime proof. Root should attach its actual test and benchmark receipts separately.

Run from the candidate worktree, with database jobs serialized:

```sh
pnpm exec vitest run tests/capture-payload-batch.integration.test.ts tests/capture-cas-read-seam.test.ts tests/capture-cas-read-seam.integration.test.ts tests/capture-payload-barrel.test.ts tests/canonicalize-sweep.integration.test.ts --maxWorkers=1 --no-file-parallelism

node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/performance-regression-2026-09-12/implementation/binding-wait-batch-benchmark.mjs --run-local
```

The new benchmark starts a disposable local PostgreSQL 16 container, runs the full migrations and accepts no DSN. It compares the actual HEAD driver with the current driver through the real repository, payload seam and parser. The synthetic corpus contains 4,000 observations, 90% presence around 500 B and 10% messages around 2 KiB, with frozen codec metadata. Bulk fixture insertion is only local setup; production writing is not bypassed by the implementation.

Expected pointer-read query count is 4,000 in the control and 500 in each batched run, including repeated runs after traversal reset. All 4,000 parser calls remain. All result counters and durable cursors must match. After replacing the local fixture with inline/no-reference bodies, both engines must issue zero catalog queries and produce identical results/cursors. The benchmark reports timings, actual body sizes, query counts and per-response row bounds, and asserts object-ID-bounded probes in both the first and final batch EXPLAIN. Local timings are not production forecasts. There is no cache fill phase in this redesign.

| Case | Fixture / required invariant |
| --- | --- |
| Mixed inline, pointer, dual, JSON null, absent object/body, wrong representation, 600 KiB body | Batched and single outcomes plus read counters match in inline/shadow/serve; large body remains readable |
| Inline-only, 17 pointers, too many explicit refs | Zero catalog queries for inline; three for 17 pointers; repository rejects more than eight refs |
| Batch-only failure, batch plus one fallback failure | Healthy siblings survive; unavailable reason is per-row and retryable |
| Reference changed after prefetch | Old body cannot be assigned to new reference |
| Removed then repaired body, new resolver on every visit | Removal is unavailable; repair is read on the next visit |
| Duplicate ref positions | Values match without sharing mutable decoded objects |
| Real driver repeated unmapped rows | Same replay debt, no stamps, same outcomes on repeated sweep |
| Binding repaired, dry run, ordinary run, CLI replay | Dry run does not stamp; ordinary run appends with original observation provenance; replay dedups |
| Real-shaped pointer corpus and deep group | Query count improves without skipping parser work; indexed probes do not rescan earlier prefixes |

## Coexistence, rollout and proposed decision

The earnings single-parse patch changes a different parser branch of the same driver. The disjoint unparsed/replay fix changes candidate selection. This patch replaces only the payload-resolution call for webhook rows and adds no family flags; root can integrate their textual overlap without changing any parse or traversal contracts. No migration or configuration flip is needed. Runtime rollback restores per-row catalog queries and leaves no optimization state to clean up.

Proposed decision for the coordinator after independent review: “Canonical webhook replay resolves pointer-only payloads through fresh envelope-authorized catalog batches of at most eight adjacent rows. Large bodies and inline/dual-copy paths retain individual reads. Batch failures fall back to existing per-envelope error handling, keeping unavailable bodies retryable and every parser/binding/stamp decision unchanged. This reduces database round trips, with no persistent cache, terminal stamp, new migration or claim of avoided parser work.”
