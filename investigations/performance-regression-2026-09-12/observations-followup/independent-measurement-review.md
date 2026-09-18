# Independent measurement review — observations follow-up

Reviewer: separate from fix author and root operator. This review reads existing evidence only; it ran no database commands, production commands, or test suites and changed no application code. Status: complete. The query-level optimization and reported before/after arithmetic are independently verified. Release comparison uses 4310680d → ea7a629c; the earlier 96a86c1f window remains historical. CPU results describe the measured operating windows and are not a load-controlled causal estimate. The after window contains additional diagnostic and application-query activity, retained in full below.

## Baseline window

The collector declares 13 samples 30 seconds apart and primary indices 2 through 12 before collection. The recorded primary window is 2026-09-12 20:51:00.000217–20:56:00.000119 UTC; monotonic duration is 299.999899392 s. All 13 snapshots are complete, use read_only with transaction_read_only=on, and have the same service start times, health, status and deployed revision 96a86c1fcdde. Database/WAL reset timestamps and the 259-table/739-index sets stay fixed. Independently checked cumulative counters are nondecreasing across every adjacent pair.

CPU recomputation agrees exactly with before-summary.json: PostgreSQL 0.303881795, worker 0.145725852, API 0.013452545 and scheduler 0.005450428 average cores; sum 0.468510620 cores. This is cgroup CPU time divided by elapsed time for these four services, not whole-host utilization. Each snapshot is sequential and takes 1.286–1.520 s, so samples are not atomic; maintain the same collector on both sides and avoid excessive decimal precision in the user report.

There are 91,094,660 observations index tuple fetches and 138 observation inserts in the primary window. The fetch count is repeated index-driven heap retrieval activity, not unique observations, SQL round trips or physical disk I/O. All but 20 of these fetches lie in the five half-minute intervals overlapping canonicalization. Five sweeps start and finish wholly inside the window: duration sum 55.181 s, mean 11.0362 s, range 10.868–11.375 s; scanned 20,001, unmapped 20,000, stamped 1, appended/deduped/errors/partition-blocks zero, all untruncated. Additional workload: 8 domain-event inserts, 31 sync-run inserts and 129 HTTP-attempt inserts. These are observable row/attempt counters, not interchangeable measures of processed workload.

The PostgreSQL log records one unrelated-classified 2,264.969 ms statement at 20:52:42.492 UTC, outside a canonicalization interval. Do not remove that interval from the predeclared window; retain it when discussing variability or identify its category from existing logs. No logged database errors/fatals or bind details and no new rollback, deadlock or temp-file counters occurred.

## Summarizer correction — resolved

The family regex omits real catch-all partitions. Include `_future` and `_pre_2024` suffixes, or derive partition membership from metadata. Before observations_future contributes 3,325 additional idx_scan but zero fetches/inserts; corrected observations idx_scan is 44,250. domain_events_future contributes 623 idx_scan plus 5 empty seq_scan, and domain_events_pre_2024 contributes 628 idx_scan. Corrected domain_events idx_scan is 10,028 and seq_scan is 20; idx_tup_fetch remains 3,145,910. Do not use unrestricted startswith, which would incorrectly include domain_events_smoke_checkpoint. The omission does not change headline CPU, observation heap-fetch or insert counts in this baseline. Root added explicit `_future` and `_pre_YYYY` matching and regenerated before-summary.json. Independently rechecked the corrected totals above; the after summary must use this same helper.

## Same-snapshot query pair

The four embedded pairs in generated-pair-probe.py match queries-before.json and queries-candidate-final.json exactly. The probe uses one REPEATABLE READ, read-only transaction, a 5 s statement timeout and 1 s lock timeout; full projected rows remain inside SQL. All four returned arrays match, with 200 rows for the populated webhook head and zero for the three caught-up families.

| Query | Execution ms before → after | Planning + execution ms before → after | Shared hit blocks before → after |
|---|---:|---:|---:|
| Populated webhook | 0.581 → 1.675 | 2.959 → 6.751 | 46 → 118 |
| Empty stats | 1542.805 → 2.378 | 1544.463 → 7.909 | 999397 → 730 |
| Empty engagement | 1181.404 → 1.181 | 1182.713 → 5.633 | 999398 → 83 |
| Empty command result | 1162.798 → 1.105 | 1164.106 → 5.214 | 999399 → 82 |

Each old empty query filters out 2,388,141 heap rows; each new plan avoids that scan. This supports the identified mechanism strongly. Shared physical-read counters are zero for both variants, so the evidence proves elimination of cached-buffer/heap work rather than a measured disk-read reduction. The populated head pays a small extra planning/execution cost that must not be hidden.

These are single warmed trials, executed old first after a result-equivalence pass, not randomized repetitions or a whole-application A/B. Report raw milliseconds/plan work with this scope, not an exact general speed multiplier or CPU saving. jsonb_agg has no explicit aggregate ORDER BY; its recorded equality is an observed ordered-array comparison through materialized ordered CTE scans, not a universal ordering proof. Separate repository tests retain qualified numeric ordering and compare complete results. The rejected analyze-guard.json experiment is not evidence for the final implementation.

## Test-only correction review

Verified tests/observations-replay-head.integration.test.ts line 210: replacing explicit source: undefined with { belowParseVersion: broad.belowParseVersion, kinds: broad.kinds } omits only source while preserving the other fields. JavaScript property access still yields undefined, so the source-free path remains exercised and compatible with exactOptionalPropertyTypes. expectLegacyRows still compares all mapped result fields, followed by equality of normalized SQL and bound values. Application source SHA-256 remains 66840f0208b377716f30ffc9905498b55daa18737c393fe56f53843ca59c1957. No rerun was performed by this reviewer.

## After-window acceptance

Use the same predeclared 2–12 sample selection on the final deployed revision, check all identities and counter/reset continuity within that window, aggregate full partitions, and count sweeps by actual start/end timestamps. Compare row/attempt workload and canonicalization work along with CPU. Any post-deploy CPU reduction is an observed operating-window result, not a load-normalized causal percentage, unless comparable workload can be established. The paired query evidence independently establishes the narrow optimization even if other live workloads differ.

## Replacement baseline after intervening production deployment

The intervening A0 deployment requires replacing the release-level baseline, not overwriting the first record. before-current-snapshots.json declares and completes the same 13-point/30-second protocol with primary indices 2–12, 2026-09-12 21:16:00.000112–21:21:00.000154 UTC, 300.000062079 s. Revision 4310680dc2f9, all service identities/health, read_only role and read-only mode, DB/WAL reset markers and table/index sets remain stable across all 13 points. All cumulative counters checked across every adjacent pair are nondecreasing. Snapshot spans are 1.235–2.581 s; source/test bytes of the final merge ea7a629ceb3ccad1e6456210181469fa27057ab6 remain identical to reviewed fix14219b68.

Independently recomputed primary counters:

- CPU: PostgreSQL 0.322347683, worker 0.198529629, API 0.012542884, scheduler 0.005613699; sum 0.539033895 average cores.
- Observations: 91,165,712 index tuple fetches, 64,465 index scans, 263 inserts, 47 updates, no deletes. Domain events: 3,140,802 index tuple fetches and 484 inserts. Sync runs: 54 inserts; HTTP attempts: 247 inserts.
- Database: 18,172 commits, 40,443,725 shared buffer hits, 45,082 block reads, no new rollback/deadlock/temp files. Cluster WAL: 48,990,818 bytes, 408,942 records and 5,801 full-page images.
- Five sweeps start and finish wholly inside the window: 11.097, 11.431, 11.870, 11.292 and 9.647 s; mean 11.0674 s, median 11.292 s. Scanned 20,043; unmapped 20,000; stamped 43; appended 479; deduped 618; errors/partition blocks zero, all untruncated.

The active sweep phase lies mainly in each latter half-minute, unlike the earlier96 window. The 21:18 and 21:19 sweeps cross the :30 boundary. Half-minute labels must follow actual timestamps; there is no fixed universal busy/quiet phase. Runtime error-code counters and PostgreSQL errors/fatals/bind-detail counts are empty; two slow observation statements (2,368.523 and 2,181.439 ms) are recorded at 21:18:33.226 and 21:19:32.854 UTC. The catalog workload also differs from the earlier96 window: 927 capture_payload_objects and 151 capture_json_hot_bodies index tuple fetches, although both windows contain 20,000 unmapped visits. This is another reason to use the replacement baseline and to retain these counters when assessing the after window.

## Final after-window verification and qualified verdict

The predeclared after window is 2026-09-12 21:29:00.000139–21:34:00.000115 UTC, 299.999965415 s, primary indices 2–12 of the complete 13-point series on ea7a629ceb3c. All 13 recorded service identities, health states and revision labels are consistent; role/read-only assertions, unchanged reset fields, stable table/index sets and cumulative counter monotonicity pass independent recomputation. No interval was removed or substituted. After-summary.json agrees with the raw snapshots, including the corrected partition aggregation.

| Measured quantity | Before-current 431 | After ea7 | Observed change |
|---|---:|---:|---:|
| Four service CPU, average cores | 0.539033895 | 0.446516781 | −17.16% |
| PostgreSQL CPU, average cores | 0.322347683 | 0.266754727 | −17.25% |
| Worker CPU, average cores | 0.198529629 | 0.135684356 | −31.66% |
| API CPU, average cores | 0.012542884 | 0.038231668 | +204.81% |
| Observations idx_tup_fetch | 91,165,712 | 24,100,500 | −73.56% |
| Observations seq_tup_read | 0 | 12,495,355 | New sequential-scan activity |
| Sum of those two observation counters | 91,165,712 | 36,595,855 | −59.86% |
| Mean completed canonical sweep | 11.0674 s | 3.5904 s | −67.56% |
| Median completed canonical sweep | 11.292 s | 2.857 s | −74.70% |

The sum is explicitly idx_tup_fetch + seq_tup_read, a convenient combined count of the recorded tuple-fetch/read activity. It is not unique rows, all index work, SQL requests, all reads or disk I/O; index-only work and unrelated tables are not covered. The decline in idx_tup_fetch alone (74%) must not be presented as a reduction in all observation reads. The combined-counter decline of 59.86% retains the new sequential activity and is a more informative compact report, with this definition.

Five sweeps both start and finish inside each primary window. After durations are 2.695, 2.857, 2.708, 4.967 and 4.725 s; the final sweep falls in 21:33:30–21:34:00 while the earlier four occupy the first half-minute. Thus the timestamp-based overlap calculation, not a fixed clock phase, is required. Before→after work: scanned 20,043→20,084, unmapped 20,000→20,000, stamped 43→84, appended 479→196, deduped 618→327. Every sampled canonical sweep has zero errors/partition blocks and is untruncated. This supports a substantially faster normal sweep for comparable dominant unmapped work, while appended event work and payload/read mix still differ.

The live workloads are not matched: observation inserts 263→185, domain-event inserts 484→199, HTTP-attempt inserts 247→322(+30.36%), sync-run inserts 54→48, capture_json_hot_bodies index tuple fetches 151→9,657. Database block-read counters increase 45,082→253,372(5.62×); they are not independently measured physical device I/O. Three temporary files total 48,489,438 bytes and eight rollbacks appear after, with no new deadlock. The 21:33:00–30 interval alone has 168,400 block reads and all three temp files while no canonical sweep overlaps it. Those counters cannot be assigned wholly to this fix or subtracted as a measured isolated CPU cost.

### Error and slow-query attribution

Existing sanitized PostgreSQL log evidence contains 11 diagnostic-shaped errors. Three precede the primary window: two shared_preload_libraries privilege denials and an ambiguous status reference at 21:28:58.906. Eight occur inside it, consistent with the eight rollback increments: invalid sync_stream literal, two page_sync_states denials, two ordinal_position references against a view lacking that column, denied pgboss schema access, an ungrouped received_at reference and a nonexistent schema_migrations.version column. The query shapes support diagnostic activity as the explanation, rather than a new runtime exception. A particular person/agent is not established by these records. Runtime error-code/exception logs remain empty; this is not a blanket statement that PostgreSQL logged no errors.

Two slow statements are ad hoc observation diagnostics: an idempotency-key hole census (2.079 s) and retained-body daily grouping (4.496 s). Other slow statements are real existing application paths: sync monitoring 4.908 s and canonical-latency percentile calculation 12.393 s. The latter matches apps/runtime/src/services/golden-signals.ts:135–142; both that source and the sync-monitor source are unchanged from 431 according to the reviewed three-path merge delta. Their exact CPU/I/O contribution is not separately measured. Root reports a sibling task's A0 read-report at 21:18:54–21:18:58 inside the before window, with no ownership of the after ad hoc queries; this remains operator-supplied context, not independent attribution.

One guarded replay statement itself took 2.085 s at 21:33:47.494. Its normalized SQL has two kind parameters and no explicit lower version floor, but bind values and result count are absent. It must remain visible as a slow replay occurrence; the evidence does not show that it was one of the three empty paired cases or establish a regression against its old form. The fix intentionally retains the original ordered lookup when eligible rows exist and leaves scoped/continuation calls unchanged. Do not claim that every replay query or every full scan has disappeared.

### Accepted report scope

Approved: same-snapshot paired SQL proves the three caught-up empty queries avoid the former 2.39-million-row heap walk, with the previously recorded small overhead on the populated head. In the complete predefined production windows, mean canonical sweep time fell 11.1→3.6 s, the defined sum of observation tuple counters 91.2→36.6 million (about 60% lower), and measured four-service CPU 0.539→0.447 average cores (17% lower). There are no logged canonicalization errors or new deadlocks in these windows, and all services remain on the verified release during collection.

Not approved: a universal 17% CPU saving caused solely by this fix; all reads reduced 74%; a claim that no PostgreSQL errors/slow queries occurred; assigning the extra diagnostic activity to a named agent without evidence; or selectively excluding busy intervals. The original after window remains the primary result. The existing latency/monitoring queries and the 2.085 s replay occurrence remain follow-up performance leads, not proven regressions introduced by this commit.

## Final report approval receipt

Reviewed REPORT.md, compare-windows.py, comparison.json and comparison-summary.log against the raw snapshots, runtime logs and sanitized SQL attribution. All reported primary-window figures and ratios agree. Independently verified the 15 continuation query pairs retain normalized SQL and bind parameters. The defined combined observation counter is exactly 36,595,855 after versus 91,165,712 before, down 59.85787398%; headline rounding to 36.6 million and 60% is appropriate when its definition and the live-workload limitation accompany it.

The report is approved on that measured scope: mean sweep 11.1→3.6 s, combined recorded tuple counters 91.2→36.6 million, observed four-service CPU 0.539→0.447 cores. It preserves the complete predefined windows and explicitly retains API CPU growth, additional sequential work, the eight primary diagnostic-shaped errors, the slow existing monitoring paths, the 2.085 s guarded replay occurrence and the populated-head overhead. There is no unresolved numerical or release-integration review finding. Two requested wording clarifications distinguish our own SQL-probe role/timeouts from the unattributed diagnostics and identify PostgreSQL blks_read by name rather than implying physical disk reads.

The root reports a later C2a deployment completing 21:39:27 UTC, after collection and the 21:34:15 final health check. This review's performance evidence remains 4310680d versus measured ea7a629c at the recorded times; it makes no claim that ea7 is still the currently running revision. Preservation and health of the later release are the root's separate verification, not a reason to relabel this window.
