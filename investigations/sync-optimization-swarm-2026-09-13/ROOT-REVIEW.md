# Root independent review notes

Source baseline main b48f173d93e3 / deployed74aac5093cfc. No product source edits.

- Planner duplicate ensure verified directly: apps/runtime/src/services/sync/planner.ts:50 and :87. Repository implementation and exact trace are agent01 deliverables; removing the inner ensure globally would affect other callers, so use an internal prepared-state boundary or narrowly scoped option, preserving standalone API behavior.
- Executor fetchLock serializes queue pulls, yet each configured worker separately sleeps for PAGE_EXECUTOR_IDLE_POLL_MS after an empty fetch (executor.ts:1227–1276). A shared dispatcher proposal must wake again on job completion, preserve shutdown handling and keep localActiveGroups registration before releasing fetch serialization. Queue group/lease correctness remains separate from idle cost.
- Codec probe reviewed: loads actual codec source and production git object, rejects mismatch; patches only scalar encodeString in an in-memory copy, never object key traversal/validation; isolated child processes for fixture timings. Full UTF16 scalar corpus + surrogate contexts is meaningful byte-contract evidence. The extreme long-string fixture is adversarial, not representative fleet traffic. maxRSS includes module loading/transpilation and is not an isolated codec allocation result.
- Readthrough double row read is conditional on legacy/reconcile flags and must not enter current fleet totals without a config/workload snapshot.
- Rejected root hypothesis: CAS seam read mode does not load effective config per payload; it uses module-local mode. Only genuinely repeated config callers elsewhere could support a separate proposal.
- Amdahl scenarios saved separately; no measured baseline fraction and no whole-system acceleration claim.

- Report01 wording corrected by root: the planner holds row locks for selected fleet states; this is not a table-wide exclusive lock. Statements about unchanged UPDATEs do not establish measured WAL bytes.

- Independently repeated exact codec parity on Node22.23.2/Linux arm64 using isolated Docker: all86807 byte cases +11 invalid cases matched. DM median2.008→0.357ms; catalog6.376→1.579ms. Shared-host/CPU-quota timing is illustrative; raw results and environment caveats in root-node22-codec. This removes runtime-version parity uncertainty but not production workload attribution.

## Cross-layer findings checked during architecture wave

- Source confirms global `createDomainEventHub` drains one captured account head in an unbounded inner loop before taking another dirty account. Production already replaced expensive bounds lookup with getAccountHighWater; only fairness remains new. A per-batch quantum is a latency improvement, not necessarily fewer total ledger reads. Moving type filters into this gapless stream cannot silently remove seqs from continuity validation.
- Source confirms `loadSpendingContext` queries latest500 active transactions, sums them in JS dollars and presents a lifetime-style aggregate. Agent11 actual-function/formatter witness covers501rows. Correct fix requires named lifetime-gross/category semantics in exact mills; page_fans LTV or spenderLifetime cannot be blindly substituted because their basis may differ. Treat separately from sync savings.
- Source confirms AI union applies tail LIMIT after cross-store dedup and tombstones. Naively LIMIT each source can return too short/wrong final tail when overlapping/deleted refs consume candidates; require adaptive bound proof or incremental serving index, not simple LIMIT pushdown.
- Architectural dirty-generation scheduling can reduce discovery scans and bound latency, but adds durable writes/fanout. It is not automatically cheaper for current small fleet; require crossover vs measured poll cost and keep certified full reconciliation.

## Third wave independent source checks

- `runCanonicalization` source unconditionally builds all page/native maps and reads historical bindings before choosing families/candidates, then reports global binding-conflict state. Agent04 traces further incident recovery writes. Narrow readers must never declare a global incident recovered merely from a scoped healthy result.
- Subscriber rollup source checked: date_series range join compares UTC-date-cast start/end; retired end uses PostgreSQL LEAST(ends_at,last_seen_at). Root initially challenged ceil-vs-floor; actual code uses explicit UTC::date, so preserve floor/day-inclusive semantics. NULL start/current expiry needs whole generated date range; inactive both-null end must contribute no active interval. No PG performance claim from a Python/JS equivalent model.
- Registry and selected projection callbacks checked: typed event metadata exists, while readers request full `de.data` then filter. Agent05 verifies all14 callbacks and per-run bounds; qualify the multiplicity as repeated reading of each consumer delta, never14 historical scans per idle tick.

- Root executed original subscriber-rollup SELECT and proposed interval-edge SELECT on isolated PostgreSQL16.15: 220 page/timezone comparisons,1928synthetic rows, bidirectional EXCEPT ALL, one transaction, all equal. Covers empty/all-null/future/reversed/UTC-boundary and seeded cases in UTC/Moscow/NewYork/Apia. No production timing or lease/erasure integration proof. First attempt hit Docker initdb temporary-server shutdown; readiness now checks PID1 final postgres before pg_isready; first failure retained, successful container cleaned.
- Production container identity rechecked2026-09-12T23:49:31Z: API/worker/scheduler unchanged74aac5093cfc. Read-only Docker inspect only, no SQL or provider traffic.

- Artifact review: all completed report Markdown links resolve.216 source references resolve in the checkout, owned evidence directory or pinned production Git object. `packages/shared/src/http-request-scope.ts` exists only in production74aac and was verified with git cat-file; do not mistake its absence in main for a fabricated source.
- Root independently confirmed workboard event subscriber passes singletonKey+startAfter5 while ensureWorkboardQueues requests standard policy and generic createQueue does not reconcile existing policy. The current queue DDL remains unmeasured; policy/code-only change cannot be assumed to migrate existing jobs.
