# Thirteen-agent optimization and architecture search

Owner instruction: launch 10 additional agents, then add three independent architecture agents, all gpt-6-astra / max, aggressively search additional synchronization optimizations and useful techniques. Analysis and evidence only; no implementation or deployment authorized by this task.

Repository: /Users/dmitriy/code/goose/hub. Checkout: b48f173d93e3693550e2db139de3b11107d44ce2. Compare actual source to the production revision in production-revision.txt; if that file is initially empty, report the known prior production reference 4310680dc2f923955295f85491eb6cf43d9bb82a and recheck the file before finalizing. Never assume main equals deployed code. Other tasks actively work in this repository and in adjacent investigations. Preserve their files.

Read CLAUDE.md first, quick reference in docs/decisions.md, relevant stage spec, and investigations/sync-algorithm-audit-2026-09-13/REPORT.md. That prior audit is the known-findings baseline, not evidence that every candidate is correct. Do not reproduce its list with different wording.

## Required standard

Work as a skeptical performance engineer. Trace actual runtime callers and identify work that grows with historical data, fan/media count, number of pages, chunks, retries, or concurrent jobs. Challenge expensive architecture and hidden feedback loops, but preserve its necessary guarantees. Prefer a small precise algorithmic improvement over a generic rewrite.

Find NEW optimizations or materially improve a known idea with a concrete design and evidence. Look deliberately for read/write/parse amplification, repeated hydration, N+1 I/O, no-op writes, overwide JSON, redundant passes, inefficient indexes, excessive lock holding, synchronous serial bottlenecks, inappropriate fairness, caching with provable invalidation, unnecessary provider calls, and opportunities to coalesce work. Explore less obvious techniques relevant to your assigned scope.

Do not fill a quota with weak suggestions. No generic 'add Redis', 'increase workers', 'lower polling', 'batch everything', or 'add an index' without exact query, data path, invariants and a concrete validation method. State when no worthwhile new optimization survives scrutiny.

For each surviving idea provide:
1. Exact source path:line, current caller and activation conditions; whether present in main AND production.
2. Actual repeated work and growth variable; a quantitative cost model from the code. Distinguish CPU/I/O/bytes/round-trips/HTTP/latency, and local speedup from whole-system gain.
3. Concrete improved algorithm and minimal practical change, including invalidation/recovery semantics.
4. Proof: lightweight local synthetic benchmark, actual-function harness, generated SQL inspection, or a precise trace. Label source-only hypotheses honestly. Never invent measurements.
5. Preservation of capture-first, account ordering, idempotency, erasure fences, leases, cursor completeness, money units, provider backoff and manual controls.
6. Expected benefit with explicit assumptions; implementation complexity; regression tests and canary metrics; counterarguments and failure cases.
7. Priority and whether this is a new idea, a deeper version of known work, or already deployed (exclude the latter from savings totals).

Use no production SSH/SQL/provider calls from subagents. Root owns any shared measurement. Do not run Vitest/Testcontainers or broad package installs; propose test artifacts for root if needed. Small isolated read-only source/CPU models are allowed; no long benchmark that monopolizes the machine. No commits, branches, product code changes, migration changes, or edits outside your own numbered output directory. Do not spawn further agents: the owner asked for thirteen additional agents on a specific model/effort.

Write REPORT.md in Russian in your assigned directory; optional probe scripts/results alongside. Start with your strongest 2–4 surviving opportunities. Finish with rejected hypotheses and a short reproducibility/limitations section. Supply a machine-readable findings.json array with id, title, scope, priority, evidence_level, source_refs, deployed_status, benefit_model, risks, implementation_size, and known_baseline_relation. Notify root early about concrete discoveries, then finalize your report without waiting for a reply.

## Assigned scopes

01 queue_sql: scheduler/executor SQL, wakeup lifecycle, leasing, duplicate scheduling, control-plane allocation.
02 dm_material: DM upsert/summary/archive/readthrough; repeated history scans and per-message work.
03 capture_storage: raw/CAS capture payload storage, compression/read seam, serialization and memory.
04 canonicalization: parsing/replay/dedup/domain-event append; batching and scan elimination.
05 projections: projection registry/work allocation/event filtering/watermarks/recovery.
06 fans_audience: fan identity/hydration/subscriptions/followers, bulk writes, rollups and reference reuse.
07 fansly_http: provider request economics, pagination, combined calls, retries and transport reuse across Fansly lanes.
08 ofapi_mirror: current OFAPI capture jobs, subscription/audience, credits, scheduled mirror and webhook paths; exclude retired DM crawler from live proposals.
09 observability: health, metrics, sync monitor, telemetry/logging, expensive observation of synchronization itself.
10 cross_pipeline: independent whole-pipeline optimization, backpressure, coalescing, materialized dirty queues, capacity/cost model and interaction audit of the other nine reports.

11 system_end_to_end: new explicit owner request. Independently trace the WHOLE Hub system across runtime roles, sync/capture, data ownership, serving, observability and user-visible outcomes. Identify system interactions, bottlenecks, failure/latency amplification and underused capabilities; distinguish this from agent10's deduplication of optimization proposals.
12 greenfield: new explicit owner request. Design how you would build this system from scratch for its CURRENT single-agency requirements and realistic scale. Treat implementation as uncommitted proposal. Separate stable product invariants from historical implementation choices; do not erase required preservation, money, auth, erasure, recovery or platform constraints. Compare current vs target and give a practical migration path.
13 radical_alternative: new explicit owner request. Explore a materially different synchronization/system architecture, not a cosmetic rewrite. Compare at least two serious alternatives and select/reject with explicit constraints, provider capability assumptions and crossover/cost conditions. Speculation must be labelled. Search primary public docs if needed, but no provider account calls, production mutations or data uploads. Explain what could make the proposal worse than the existing system and how to falsify it cheaply.
