# Static CI compiler heap exhaustion

PR185 head bfdb1440, run34793396023, job103821767892 failed during Typecheck.
The retained raw log records Node22 at approximately 2,030 MiB followed by
`FATAL ERROR: Ineffective mark-compacts near heap limit` and a SIGABRT from
`tsc --noEmit --pretty false`. This is a compiler-process heap failure, not a
passing strictness check. Earlier local full checks used an explicit 8 GiB heap.

The bounded follow-up sets NODE_OPTIONS=--max-old-space-size=4096 only on the
static CI job. It leaves type coverage, error budgets, integration jobs, test
scripts' explicit limits and production/runtime configuration unchanged.
Local full check at 4 GiB passed: 3,580 unit tests, nine existing skips,
strictness, lint and build. All pinned source/workflow hashes were unchanged
during validation; see `../static-heap-validation/`. Updated CI remains pending.
