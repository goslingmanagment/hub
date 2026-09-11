# Fansly C1 — followers reconcile diagnostics

Branch `feat/fansly-c1-followers`, based on main `f0a53aee` (C2a PR165).
Decision 291, migrations 0182–0183. This is the diagnostic portion of the single C1
[draft PR166](https://github.com/goslingmanagment/core/pull/166), not completed C1.
The measured cause and narrow fix remain pending.
No production deployment, new flag, cooldown or cadence change is implied.

Each incremental decision records the three existing OR predicates, including
the no-request combination. Queue requests optionally return the previous
request/applied sequences from the same locked row. Ordinary callers keep their
old return shape and no extra query is introduced. The diagnostic report exposes
bounded aggregates through a restricted read operation; missing, malformed,
duplicate and boundary receipts remain explicit unknowns. Pending work at request
time is not proof of how many completed generations absorbed those requests.

Final validation:

- `pnpm check`: 3148 passed in 286 unit files, 9 existing skips. Strictness
  remains 1908 known errors in 121 files; lint and dashboard build pass.
- Serial real Docker-Postgres: 50 tests in four files, zero skips, 25.12 seconds.
  Suites: `followers-diagnostics`, `generation-high-water`,
  `page-sync-lease-fencing` and `sync` (all `.integration.test.ts`).
- Fixtures exercise the real handler, telemetry, queue and presence writes with
  a stubbed provider: each OR branch and no request, concurrent queue receipts,
  unchanged default callers, missing telemetry after an injected DB failure,
  malformed/duplicate receipts, exclusive window boundaries, and actual
  restricted-role access. Existing generation and lease guards still pass.

Independent static review found no actionable issues after the atomic queue
receipt and unknown coverage were added. Final re-review also checked the typed
count result and malformed queue fixtures; the reviewer did not run tests.
`git diff --check` passes.

The only production read for this stage inspected role capabilities. The
retained [SQL](evidence/read-privileges.sql) and [output](evidence/read-privileges.txt)
confirm `read_only` in a READ ONLY transaction, with no selectable sync/follower
tables or applicable public report operation. The catalog's pg-boss function
entry was not invoked. No provider request, deployment, replay or flag flip was
performed. Production branch frequencies, eventual generation consolidation,
request savings and latency are not measured.

Next: an explicitly approved diagnostic deployment, retained bounded reports
and a completed-run timeline; then explain headline/active semantics, deletions
and pagination before adding the narrow fix to this same PR. Initial seeding is
a separate path. Follow the [runbook](../../docs/runbooks/fansly-followers-diagnostics.md).
This branch includes C2a, whose worker starts earnings v7 reparse; any deployment
approval must cover that scope and compatible readers. PR164 remains the earlier
A0-only target. Nothing here starts A0's seven-day clock or authorizes A1.

Main PR168 took Decision 286. The branch now merges main `940ec69f`; only
the C1 decision/runbook numbering changed. C1 remains one draft PR.
