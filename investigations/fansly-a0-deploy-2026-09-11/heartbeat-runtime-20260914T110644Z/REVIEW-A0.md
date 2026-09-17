# Independent A0 observation review — 14 September, 11:06 UTC

Verdict: **passed; no actionable findings**. Local evidence review only; no
production calls, tests, source, state, configuration or automation changes.

Verified all 15 manifest hashes, current/prior raw-report hashes, normalized/raw
equality, read_only and READ ONLY receipts, exact invocation and original clock.
The report correctly preserves its non-atomic boundary.

Independently recomputed 1,009 unique sweep keys: **937 unchanged +72 new complete**,
twelve per page, giving 757 complete /252 incomplete. All page totals and latest
finish times match raw values. The +12 repeated Lilly-2 missing-hot-head observations
and zero new other discrepancy counters are accurate. Reason-field coverage remains
separate: 470 known, 538 absent, one null. Historical null boundaries, unknown material
checks and G4830 are retained; none is silently converted into certified zero.

Recomputed HTTP totals and signed bucket differences: **+5,397 attempts**, one
Lilly-1 earnings timeout retry, no new failed/429 outcomes. Media-stats attempt
buckets are unchanged; the report does not claim recovery. HTTP unknown-run change
6→4 is exactly the two dated earnings buckets changing by -1, correctly reported
as cumulative classification rather than proven repair. DM failed/lost/unknown
34/8/1 and null-byte coverage remain explicit. No savings or latency inference is made.

The original earliest seven-day report remains **17 September 22:58:33.610 UTC**;
calendar age is distinct from acceptance. A0 stays NO-GO and A1 is not authorized.
The quiet recommendation is consistent with continued six-page progress and no
newly established owner action. Runtime/configuration and current deployment-gate
proof remain separate coordinator responsibilities.

| Artifact | SHA-256 |
|---|---|
| Normalized report | bd1d703647c28e385f2ce16fd02dee97160d282623736faa3509d6f4e96d29a2 |
| Summary | e92ef053e97632b67832f9b01d61803e94071237c80277e1cc4140c66b5faca8 |
| REPORT.md | 594a7338d9ad5eb8a7612bc304202a580589a7871b42a2719eff91c790b1e576 |
| Artifact manifest | a206f4438805e9efb6cdf3689a40a67f95d9b06fed2dbff5ac51f49bf65a4dd0 |

[Machine-readable receipt](review-a0-receipt.json) retains the verification scope.
