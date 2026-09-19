# Full CI: worker imports and explicit latency benchmarks

The performance comparison changes only test infrastructure. Its application
source and lockfile match main at `91ecd2c0456be5adad890b7c6c68d7a74fcbc229`, merged
at `9693ed16bcba4b510455ab4aff03b43be74bd0b8` before measuring. The subsequent
regression run exposed a pre-existing typed-export scheduling defect; its
separate correction and added cases are described below. This extends PR #225.

## Accepted changes

- Workers import the template name, injection key and Vitest context types
  from a dependency-free module. Previously their DB helper imported global
  setup, unnecessarily loading its Testcontainers graph in isolated workers.
- The worker loads the production migration runner only when a test requests
  a partial schema (`through`). Global setup still migrates the template with
  that production runner. Import failure is inside the cleanup boundary and
  occurs before acquiring the migration client.
- The earnings audit scale test keeps the real Docker psql transport, 120,000
  observations, 1,000 projected receipts, the exact 151-burst assertion and
  all existing correctness assertions. Its synthetic 100ms delay per burst
  now runs only when `FANSLY_AUDIT_BENCHMARK_OUTPUT` is set. The saved measurement
  records the actual configured delay.

Ordinary CI no longer simulates 100ms WAN latency in that scale test. The
explicit benchmark retains that scenario, and real reader/SQL timeouts are
unchanged. This removes at least 15.1s of deliberate waiting from that test;
it is not a claim about rounded runner billing or production performance.

## Deliberately retained

Per-file isolation, serial DB files, two unit workers, the complete dynamic
database reset, fresh storage-health samples, real authentication and all
test selections are preserved by the optimization. The separate scheduling
correction adds three regression cases.

Two workers per DB shard are unsafe without additional work: integration
files alter the cluster-wide `read_only` role and some advisory-lock probes
are not scoped to their own database. Independent databases alone do not
isolate those operations. Reusing password hashes would also change the
authentication fixture's audit/observation side effects. Neither change is
included.

A prior disposable-DB probe measured 30 complete resets: about 3.018s in total,
of which 2.881s was TRUNCATE. Combining tiny seed queries would not address the
dominant work. No handwritten table list, blanket transaction rollback or
weakened cleanup was introduced.

## Independent review

The separate reviewer found no blocking findings in the implemented patch.
It checked module augmentation and injection keys, lazy-import failure
cleanup, benchmark metadata, and interactions with the whole PR after merging
current main. It did not run a competing Vitest suite. Dynamic verification
is recorded separately below.

## Verification

Local runs use Node 22, macOS ARM64 and Docker Desktop, with only one Vitest
suite at a time. The before/after comparison uses the same application source,
test selection and worker settings. These are full-suite measurements without
CI proof reuse; they are not fresh-machine or GitHub billing measurements.

Raw reports, logs, source hashes and timing data are retained outside the
implementation worktree in
`investigations/ci-cost-2026-09-16/cold-implementation/` in the original checkout.

| Same-selection comparison | Before | After |
|---|---:|---:|
| Unit, 357 files / 4,297 passed / 9 existing skips | 106.40s | 104.24s |
| DB shard 3, 78 files / 834 passed | 226.60s | 216.79s |
| DB shard 3, import phase | 48.41s | 40.28s |

Times are Vitest wall time, except the explicitly named import phase. JSON
reports confirm identical test identities and statuses for each comparison.
The compared DB shard does not contain the scale test, so its observed 9.81s
reduction is independent of the removed artificial wait. This is one local
before/after pair, not a statistically established percentage or a hosted
savings estimate. The unit difference is small enough to treat as noise.

### Pre-existing scheduling defect found during acceptance

The initial DB shard 2 run had 13 failures in `ofapi-typed-exports.integration.test.ts`;
the other 949 cases passed. A paired single-file check reproduced five failures
both with and without the infrastructure changes (13 passed in each version).
The unoptimized control restored the original tracked helpers from `9693ed16`
and restored the optimized files afterward.

Task creation and approval write `next_attempt_at` using the Node clock, and
lease acquisition checks that same clock. The typed sweep alone used PostgreSQL
`now()` for its preliminary due-time filter. A database clock behind the host
can therefore hide an immediately runnable task. The correction samples the
host clock after cancellation recovery, preserving all lease, fencing and
deadline checks.

A deterministic regression controls only JavaScript `Date` to be 60 seconds
ahead of the real database. The original worker fails; the corrected worker
executes both a newly created and subsequently approved job. Two negative
cases preserve future `ready` and `retry_wait` jobs byte-for-byte, without
vendor requests. All 21 cases in the corrected file pass, including the
original 18. The independent reviewer found no blocking findings in this
correction or its tests.

The mixed-clock defect is proven by that red/green test. The original 13
failures lack a clock/error snapshot: adding a diagnostic SELECT made that
run pass, with no swallowed logger errors. The initial failures are consistent
with the defect, but their exact timing was not directly captured. No sleeps,
retries or fixture backdating were added to conceal it.

### Completed local acceptance

| Check | Result |
|---|---|
| Unit comparison, before the separate clock correction | 357 files; 4,297 passed; 9 existing skips; exact case/status equality |
| DB shards 1 / 2 / 3 | 741 / 965 / 834 passed; 235 files; zero skips; shard 2 rerun after clock correction |
| Full API file, including nightly-only cases | 104 passed |
| Partial migrations | Pool error handling, deployed migration-history continuation and fan-earnings status migration all passed |
| Explicit WAN benchmark | Both scale cases passed; saved corpus measurement confirms 100ms, 151 bursts and 120,000 observations; projection measurement confirms 1,000 rows |
| Types | Existing strictness budget satisfied: 1,893 known errors in 120 files; no new errors |
| Lint, workflow syntax | Passed |
| Contract regeneration and drift | Passed; no generated contract changes |

JSON selection checks confirm that the corrected shard removes none of its
962 original cases and adds exactly the three clock-regression cases. The
repeated shard passes all 965. Earlier failed runs are retained as evidence,
not overwritten or counted as successful validation.

The full hosted gate on the final commit, including every shard, unit tests
and native image smokes, is recorded in [PR #225](https://github.com/goslingmanagment/core/pull/225).
This report does not treat earlier proof-only or frontend-probe runs as
validation of the changed helper or worker. No production deployment or
main-only image publication is included in the local acceptance.
