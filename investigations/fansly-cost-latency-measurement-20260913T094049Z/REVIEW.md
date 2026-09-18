# Independent cost and latency review — 13 September 2026

Verdict: no open actionable findings in the final MEASUREMENT.md, HTTP-REPORT.md, LATENCY-FEASIBILITY.md, calculations and receipts. This is approval of the measurement and its limits, not achievement of the migration target.

Scope: independent local recomputation of retained HTTP reports, all page/source/stream/operation/outcome attempt totals, coverage, timestamp differences and hashes; review of the accepted plan §1/T0, Decision 284 and the measurement reader. The latency source audit is a separate analyst contribution; this reviewer checked metric validity and the retained query/sample, without repeating that broad code audit. No tests, production/provider/UI calls, Git operations or application edits were performed. Only this REVIEW.md was written.

## Confirmed measurements

- Both HTTP windows are exact half-open UTC days, 5→6 and 12→13 September, on the same six page IDs/labels. Retained attempts are 30,684→37,268: +6,584 (+21.4574%), or −21.4574% nominal reduction. The 15,342 threshold is half of this retained baseline, not a complete-traffic acceptance denominator.
- Retry ordinals are 875→963; retry-state rows 875→964; failed-state rows 290→321. These are overlapping subsets of attempts, not extra requests. Zero HTTP 429 and unknown-byte counts 1,547→1,671 agree with raw groups. Known payload bytes are not wire bytes or monetary cost.
- Baseline run-loss completeness is unknown: all 7,125 overlapping runs lack counters; loss sums stay null. Current 8,539 overlapping runs have known zero reported loss, with four boundary runs. These scoped zeros neither establish baseline completeness nor cover browser/bootstrap or other uninstrumented traffic.
- Historical Sep 5 attempt groups exactly match the original T0 slice; current Sep 12 groups exactly match the earlier morning snapshot. Original six-day total is 183,416, mean 30,569.333/day, range 29,670–31,732. The current day is 21.9130% above that mean. These equalities do not recover missing telemetry.
- Calendar/page matching is not workload matching: dm_messages adds 4,209 attempts and fan_earnings 2,046; their causes and freshness parity are not established. Full polling is retained and no request-suppression treatment is measured. Causal migration savings remain unknown; ≥50% is not demonstrated.

The permitted head-debt sample contains seven rows on five pages in the frozen 08:47:14.306804–09:47:14.306804 UTC window. Six paired captured_at − first_observed_at values are 12.054088–701.216417 seconds; one row lacks a receipt. Hash, selection predicates and arithmetic match. These are selected list-discovery/debt-to-hot-receipt markers, not event receipt-to-reader latency. Debt recovery attempt counters of zero are explicitly distinct from physical HTTP attempts.

The reported event-path N=0/unmeasured denotes no qualifying sample from an implemented B0/B1 event path in this packet/current stage state. It is not a quantitative production event census or measured zero latency. No p95/p99, first-visible time or parity across chat-list/archive/Read Plane is inferred from provider timestamps, mutable projections, PostgreSQL transaction time or health timing. Existing capture/reader stage prerequisites remain; observation duration alone cannot create the missing metric.

## Evidence binding

| Retained input | SHA-256 |
|---|---|
| [baseline-day-reread/report.json](baseline-day-reread/report.json) | `25675d975fdd62cdfe5373580fc63b0db80973084f0a3b6cfc0dd3622f33a5e2` |
| [current-day/report.json](current-day/report.json) | `9a8c9c33703abb489d40aff3892753f0e9ef36643e2220af765157d3f8a418cb` |
| [head-latency-sample.json](head-latency-sample.json) | `30812866ced34ce7cbf25d525ea7ebc9c7803adbff05942adb39efa6ac925db5` |
| [runtime.stdout](runtime.stdout) | `5a05c9f729ef7e148b91839c916e8aeb1f8da90f2db393ec2c1cb20245d38a18` |
| [http-summary.json](http-summary.json) | `24c9c03693638563bcb3fec47cfa42dc83b2bf877e0af5433eaee0db44096a9a` |
| [summarize-http.py](summarize-http.py) | `618689f50437408dedd5a6b4708c1850a2951760f85b13101de830b1e8d39344` |

Both HTTP report manifests and original read receipts match normalized data and read_only / READ ONLY identity. The five final source/report hashes in http-source-receipt.json were independently checked. Manifest records 0/292 refer to shadow sweeps, not HTTP attempts. Runtime labels identify the retained 380326368fe3/c443947a3569 image with three healthy roles and zero restarts; this does not prove fresh configuration, a deployment gate or metric coverage.

Closed clarifications: MEASUREMENT links now resolve to the actual HTTP/latency reports; debt attempt counters are named explicitly; unknown baseline completeness is not called proven loss. The local reproduction script now asserts exact UTC-midnight endpoints before marking exactHalfOpenDays true. No remaining findings.
