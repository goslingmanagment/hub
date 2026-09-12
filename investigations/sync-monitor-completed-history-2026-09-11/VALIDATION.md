# Validation — 11 September 2026

Base main: `b48f173d93e3693550e2db139de3b11107d44ce2`.
Source SHA256: `681aa3c2a22f580aef6ba722268e319cba891fe432f28db83231b29e0105a87d`.
Monitor test SHA256: `0fa3a1b362fe2b033d81eea507986a4da085425ddc99afd9dadcd41f3bb63108`.

- `pnpm check`: exit 0; **3237 passed, nine existing skips, 295 test files**.
  Strictness ratchet: 1901 known errors in 121 files, within the existing budget.
  ESLint and the dashboard production build passed. The build retains its
  existing large-chunk warning; no size reduction is claimed.
- Real Docker Postgres 16, serial execution: **20 passed, zero skips, two suites**,
  13.82 seconds:
  ```sh
  pnpm exec vitest run --no-file-parallelism \
    tests/sync-monitor.integration.test.ts tests/sync.integration.test.ts
  ```
- The separate scale benchmark plus monitor regressions passed **nine checks**,
  76.50 seconds. Four fixtures compared every returned SQL field across 102 rows
  on warm-up and three alternating measured samples. The estimated completed WindowAgg row width changed
  from 1674 to 36 bytes; the physical-history window remains unchanged.
- `git diff --check`: passed for the runtime, tests and normalized fixture.
  Artifact hashes, all timings and the baseline whitespace-normalization boundary
  are retained in `measurement.json`; full generated plans and logs remain local.

This proves local compatibility and the measured fixture improvement. It does not
prove production health latency, A0 coverage, event latency or HTTP savings.
No production action, flag or migration belongs to this change.
