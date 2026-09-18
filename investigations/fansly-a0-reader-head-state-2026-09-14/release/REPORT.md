# A0 reader-head diagnostic — production release and first evidence

[PR196](https://github.com/goslingmanagment/core/pull/196) merged as
`ac92197ba9760833ae035c3f5e8a90d084010fe6` and deployed successfully on
14 September at 16:29:26 UTC (wrapper finished 16:29:31). The merged tree is
identical to reviewed CI head `9aac9988`. All five required CI checks passed.
Local `pnpm check` passed 3,779 tests with nine existing skips; 84 PostgreSQL
tests passed serially. Independent correctness and readability review closed
before merge. The tests cover real Agent-reader precedence, tombstones, pending
content, page/group fences, pre-apply diagnostics, legacy nulls and the shared
query allowance. They do not prove complete production coverage.

The standard dist-only deployment preserved the existing clean dependency base,
PostgreSQL and all 189 prior migration identities/timestamps. Only additive
0194 was applied, at 16:28:50.211272 UTC. `read_only` can execute the fixed
diagnostic functions; direct message-table SELECT remains denied. No flag or
polling change was made. The release also contains the separately reviewed and
merged operator-only W0 tooling from [PR195](https://github.com/goslingmanagment/core/pull/195).

The actual runtime image is
`sha256:ca60d6371efa39d256c929eec025f05d78edf97dba21076b82f58b1f5f8cc01d`.
API, worker and scheduler were healthy with zero restarts immediately after
release and again at the retained 17:42 follow-up. PostgreSQL's observed image,
13 September start time, health and restart count are unchanged; the Docker
receipts do not include its container ID. Protected sync health returned 200 and
dashboard delivery passed; the production-pinned CLI was updated to this source.
The 16:31 and 17:46 configuration receipts show all three active roles reporting
the desired values: DM shadow six pages, earnings shadow Lilly-1 and head
catch-up none. Configuration override versions are respectively 1, 1 and 4;
per-role applied versions and continuous historical application remain unproved.

## Measured query cost

One serial read-only sample per page ran at 16:31:27–16:31:39 UTC, each with
100 current stored heads. Caller READ ONLY / REPEATABLE READ, 5s statement and
100ms lock limits, an external deadline and all raw results are retained in
[reader-cost](reader-cost). No retry, privilege fallback or provider request
was made. All six samples completed.

| Page | Planning ms | Execution ms | Shared hit/read blocks |
|---|---:|---:|---:|
| ari-1 | 15.761 | 128.655 | 1175 / 109 |
| lilly-1 | 5.109 | 4.818 | 1324 / 0 |
| lilly-2 | 5.117 | 70.977 | 1113 / 141 |
| lora-1 | 4.905 | 122.460 | 1035 / 270 |
| lora-2 | 4.821 | 96.664 | 1224 / 128 |
| lora-3 | 4.992 | 143.473 | 1102 / 188 |

The 4.818–143.473ms range is inner SQL execution in six different cache states.
It excludes planning, head selection, pool checkout, the old hot-material query,
scheduling and reader delivery. It is neither a p95/p99 nor a hot-path bound.
Sampling current stored threads also omits archive-only conversations with no
stored thread. The separate PR193 hot-query measurement remains historical;
adding these unmatched samples would not measure the combined runtime latency.

## First reader observations and remaining gates

The [17:42 cumulative snapshot](../../fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T174241Z/report.json)
contains 1,089 unique sweeps: 833 complete, 255 incomplete and one running.
All 1,009 rows from the preceding 11:06 export are unchanged. New fields are
known in 16 rows, null in one transition row and absent in 1,072 historical rows.
The 15 completed reader observations cover all six pages and sum to 47,482
advertised-head checks. The running row adds 500 checks of its processed prefix.
The export is non-atomic: its running row was updated 3.820251 seconds after the
nominal cutoff but within the export interval. It is not a frozen cutoff state.

Completed reader observations contain 38,179 materialized heads below their
candidate stops and two missing-head occurrences, one each in Lilly-2 generations
6917 and 6918. Aggregate counters cannot establish whether these are two unique
objects or prove provider loss. Generation 6918 also counted a flags change;
Lora-1 generation 4925 counted two exclusion-reason changes and Lora-2 generation
5572 counted one. Complete collection is not a discrepancy pass. The one sweep
crossing this deployment, Lilly-2 generation 6916, correctly retains null reader
coverage. No earlier evidence is recertified by the new fields.

A0 remains NO-GO for A1. The original clock is unchanged; seven calendar days,
coverage, outage/churn cases and discrepancy explanations remain distinct gates.
No HTTP savings or event-to-reader latency has been established. C2b still needs
its second qualifying natural daily walk; W0 needs the working Lilly-1 browser
context, paired delivery/presence and the actual continuity/recovery experiment.
No B0/B1/C2c advancement or B2 implementation is part of this release.

Independent [post-release review](REVIEW-POST-RELEASE.md) checked the deployment,
all six raw cost receipts and local runtime aliases. The
[first-observation review](../../fansly-a0-deploy-2026-09-11/activation/20260910T225618Z/snapshot-20260914T174241Z/REVIEW.md)
verified the A0 figures and corrected empty-cohort sums to null. The
[final narrative review](REVIEW-FINAL-NARRATIVE.md) records the release report's
evidence boundaries and resolved findings.
