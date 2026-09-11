# Select completed runs before loading monitor payload

The monitor now selects a completed run ID before loading its stats and error
payload. The existing historical physical-attempt calculation is unchanged.
This is a separate health-query fix, outside the C1 follower-policy PR.

## Production boundary

The owner-approved EXPLAIN-only operation at 11 September 17:35 UTC selected
wide completed-run ranking in the deployed monitor reader. It ran once inside
READ ONLY, without executing the SELECT. Its estimated costs do not identify
the cause of the 150-second protected-health timeouts, worker pool checkout
failure or A0 material-check timeouts. The privilege exception is consumed.
The exact operation is documented in [C1's reviewed plan report](
https://github.com/goslingmanagment/core/blob/cce46569d5a61385db87751e118ca93a8fcb401d/investigations/fansly-c1-followers-2026-09-10/HEALTH-PLAN-20260911T173528Z.md).

## Change and local measurement

Previously, the completed-run selector carried each historical run's wide stats
and error fields through ranking. It now ranks narrow run IDs by the same
`finished_at DESC, id DESC` keys and loads the selected payload by primary key.
The SQL statement snapshot, completed-outcome filters, old-history selection,
page/stream scope, status/trigger mapping and duration expression are preserved.

The existing Docker-Postgres scale fixture was extended with synthetic 1280-character
stats content and 256-character error text for historical runs. It contains six
pages, 17 streams, 166286 runs, 665120 attempts, 1163960 events, 132000 fan links,
48000 threads and 576000 messages. This is synthetic scale, not copied user data.

Each scenario uses the same database for baseline and candidate, warms both,
then alternates their order across three samples each. Every returned field of
all 102 rows is compared on warm-up and every sample. Timings are observations,
not flaky pass/fail thresholds.

| Attempt history | Baseline median | Candidate median | Reduction |
|---|---:|---:|---:|
| All successful | 979.8 ms | 778.2 ms | 20.6% |
| Failed attempts on roughly 1/31 of runs | 944.1 ms | 754.9 ms | 20.0% |
| No successful attempt | 1004.4 ms | 807.6 ms | 19.6% |
| One old success cohort, then failure debt | 926.7 ms | 711.5 ms | 23.2% |

The completed WindowAgg estimated row width falls from 1674 to 36 bytes, followed by 102
primary-key lookups returning one row each. Physical WindowAgg is unchanged.
Temporary blocks written for the complete query rise from 3205 to 3983, so no
claim of reduced temp storage or overall I/O is made. Local latency is not a
production distribution or proof that the deployment gate will pass.

Physical-attempt aggregate rewrites were tried first and rejected because they
regressed failure-heavy fixtures. They are not part of this diff. Their raw
measurements and patches remain locally in the sibling physical-history
investigation; no unmeasured reduction of historical failure debt is introduced.

## Reproduction and validation

`measurement.json` retains all samples, plan timings and artifact hashes. Full
plans are local `paired.json`; the SQL/parameters for the original main
`b48f173d` reader are versioned as `baseline.sql` and `baseline-params.json`.
The fixture strips generated trailing whitespace only; the receipt records both
SQL hashes. Copy `benchmark.ts` to `tests/sync-monitor-benchmark.integration.test.ts`,
run that single test, then remove the copied file:

```sh
pnpm exec vitest run --no-file-parallelism tests/sync-monitor-benchmark.integration.test.ts
```
 Do not overlap another Vitest run. The generated paired report
contains SQL, inputs and plans for both variants.

The measured run passed nine checks: the benchmark plus eight monitor tests.
The five new completed-run cases cover finish/start ordering, ID ties, historical
results, page/stream isolation, excluded running/unfinished rows, selected payload,
all four completed outcomes and the default source/status mapping.
Full check and final integration results are recorded in `VALIDATION.md`.

Two independent reviewers checked correctness, readability and the measured
plans. The implementation adds one primary-key join without new abstractions,
flags or schema changes. Findings and exact reviewed source hashes are in `REVIEW.md`.

This branch is not deployed. Production still runs C1 diagnostic source `d47dc9b0`
with applied migrations 0182/0183; a deployable revision must preserve that state.
The current main-based branch alone is not a prepared replacement image. A future
approved deployment must pass the ordinary protected-health gate. A0 acceptance,
C1 policy evidence, A1, event latency and physical HTTP savings remain open.
