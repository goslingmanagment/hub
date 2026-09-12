# C1-preserving health release candidate

PR172 merged as `c0cd21c3e9c85a795c71e05e4a887aaf252f3270` after all five CI
checks passed. That main is integrated into C1; combined local validation and
both independent reviews passed. The candidate revision is recorded in PR166.
Deployment requires owner approval. The 17:35 UTC EXPLAIN approval is consumed.

## Composition

The existing C1 branch now includes main with
[PR172](https://github.com/goslingmanagment/core/pull/172). C1 diagnostics match
deployed source `d47dc9b09f87988a53bd80435f0d11534beba15c`; all applied migration
files, including 0182/0183, are retained byte for byte.

The release also includes main's already merged
[PR171](https://github.com/goslingmanagment/core/pull/171): the Overview interface,
revenue drilldown API and generated contract change. It is not a health-only
release relative to current production. Dependencies and the deploy script are
unchanged. C1 remains a diagnostic draft with its follower policy unchanged.

The only merge conflict was in the decision log. Main's decisions are retained
and C1 is now Decision 294. All 179 deployed migration files and all six C1
runtime and migration paths introduced after `32478124` are unchanged.

## Local validation

The combined tree passed:

- `pnpm check`: 3251 passed, nine existing skips, 296 test files; typecheck,
  lint and dashboard build passed with the existing strictness budget.
- `pnpm build:production`: passed, including the backend and dashboard.
- Serial Docker-Postgres: 81 passed, zero skips, seven suites, 24.34 seconds.
  Suites: followers-timeline, followers-diagnostics,
  generation-high-water, page-sync-lease-fencing, sync, sync-monitor and
  revenue-drilldown (all `.integration.test.ts`).
- Regenerated contracts match their committed artifacts.
- Migration-file equality against deployed `d47dc9b0`; the migrator's filename
  tracking alone does not prove that file contents stayed unchanged.

The checks cover C1 receipts and access boundaries, queue/lease/generation
guards, absence grace, completed-run selection and the incoming revenue API.
They do not establish provider completeness or production latency. Source and
log hashes are retained in `evidence/health-release-20260911/validation.json`.
Both reviewers verified the source and log hashes and found no remaining code
issue. Stale release-status wording and an unlabelled historical validation block
were corrected and rereviewed. The review is recorded in `REVIEW.md`.

## Prepared operation and verification

Only after a fresh explicit owner approval of the final commit:

```sh
scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111
```

Before dispatch, check the approved commit, clean tracked source, current runtime
revision and image, migration hashes and dependency compatibility. An intervening
production change requires reassessing the candidate against that source.
Use the existing deploy locks, schema guards and rollback path.

The standard API, worker, scheduler, source-label and dashboard checks must run.
The protected sync-health check must actually execute and return its pages
payload; a missing monitoring token or skipped gate is not acceptance. A 503 with
pages is accepted by the existing script but still reports unhealthy sync state
and does not pass the A0 or C1 acceptance gates. Preserve that distinction.

Keep the standard production-pinned CLI rebuild and capabilities verification:
the incoming Overview API changes the contract. Record the deployment exit,
actual running image/source and health results separately. Ordinary health is
not a substitute for the protected sync-health gate.

There are no new flags, migrations, replays or socket operations. A0 keeps its
original seven-day clock and incomplete cohorts. The code rollback target is
the captured C1 image with the same migration set; never remove retained facts
or applied read functions. Physical HTTP savings and event latency remain
unmeasured, and local query timings do not establish production improvement.
