# Independent post-release evidence review

Reviewer: `/root/w0_role_tests`. Local retained-evidence and Git inspection only;
no production calls, browser access, tests, source edits or deployment by reviewer.

**Outcome: the completed 4e18 deployment is supported by the receipts. No
unresolved release-evidence finding remains.** Stale local deployment/configuration
aliases found during review were corrected with coordinator authorization;
pre-edit copies and exact changed fields are retained. This is deployment
verification, not acceptance of the events migration or a stability guarantee.

## Source, artifact and execution

The release worktree remains clean at commit
`4e18d130ea6ca4b834141789265cce8442f8fcae`, tree
`372b84f04df46c3cb607d5d5eef9c8a7c401bb62`. The retained successful main CI
34798541588 names that commit. The preceding independent preflight already
verified its exact correspondence to the composed local test tree and all
1,592 source hashes: 3,751 unit passes, 9 existing skips and 96 serial PG passes.
Those prior validation receipts were not represented as tests of a new source.

The first pull exited 1 after GHCR refused authorization in the candidate phase.
Its log never reaches quiesce/recreate. It captured locks and rollback artifacts;
this is not an assertion that the attempt performed no filesystem/tag operations.
The following standard full-build run used the same worktree and dependency
checksum, loaded its new image through SSH and exited 0. Its success line is
14:58:50 UTC; process completion was recorded at 14:58:53.941 UTC.

The actual deployed image is:
`sha256:a8919d6a00d03471f1b84e0d15c4f55cdc8c0801beeb06c169b0942161ed6a1d`.
Corrected image inspection reports linux/amd64, source label `4e18d130ea6c` and
checksum `0667a9e9cd490c9c7ee729e146cfbfa2e432a5c983c3ceec9804f4d9eb24ccd4`.
All three application container inspections name that exact image. The report
correctly distinguishes this locally built artifact from the CI image `07cf…`
and published GHCR digest `afd05e…`. Source attribution rests on the frozen
build context, build/verification log and retained metadata, not an assertion
that the two images have identical bytes.

The ARM/QEMU Chromium failure is retained as an excerpt, not a full raw log or a
proven native runtime defect. The same candidate tag's native VPS smoke exited 0
with network disabled and no supplied environment credentials. The malformed
first post-image output remains retained; the separately hashed corrected read
resolves that formatting failure without replacing original evidence.

## Database and immediate health

All 26 stdout/stderr/deployment-log hashes present in execution receipts match
retained bytes. Both migration reads attest `read_only` and READ ONLY; the
retained SQL template explicitly requests repeatable read and bounded timeouts.
The full arrays of 187 IDs and applied timestamps are equal before and after.
Their IDs exactly equal all 187 candidate migration filenames: no pending or
applied-but-absent migration. The previous source-file parity review is retained;
this ledger comparison does not independently hash database object definitions.

Postgres has the exact same inspected image, start time, health and restart
count before and after. Its start remains 2026-09-13T00:08:24.898337483Z. Normal
promotion did not recreate it; the previously documented automatic-rollback
scope caveat remains true but was not exercised in this successful run.

The 14:59 runtime read reports API/worker/scheduler running and healthy with
zero restarts. Their new container starts are respectively 14:58:08.792,
14:58:14.756 and 14:58:08.779 UTC. The deployment log records protected sync
HTTP 200, successful same-origin HTML checks and a production-pinned CLI rebuild
with matching contract/capability verification. Ordinary health separately
reports API/database OK and one database probe of 1 ms, not a latency percentile.
Disk evidence reports 17,555,316 KiB available (16.74 GiB), 79% used. GC was off.

The retained worker tail has 19 JSON records from 14:58:17.434 through
14:59:31.170 UTC, below its 700-record cap. It contains no numeric error records
and shows three partial DM-conversation chunks each for lora-2 and lilly-2,
30 physical attempts in total with zero failed attempts in those summaries.
It supports immediate progress only. Neither the short interval nor a healthy
container proves resolution of prior media errors, complete capture or reader
freshness.

## Fresh configuration and preserved gates

The coordinator's sanitized authenticated configuration response is generated at
15:10:14.903 UTC and retained at 15:11:15.504 UTC. It identifies three active
application instances starting after this rollout, with matching reported values:
A0's original six pages / desired override version 1, earnings shadow `lilly-1`
/ version 1, and head catch-up `none` / version 4. Each item reports false drift
and pendingApply. String settings still have unknown/null boolean-state fields.
No per-role applied-version acknowledgement or historical continuity is exposed.
The UI/application start times differ normally from Docker container start times;
they are not substituted for each other. I inspected the retained subset, not the
live UI or an independently captured response. No flag mutation is reported.

A0's original start remains `2026-09-10T22:58:33.610Z`; C1's remains
`2026-09-11T01:05:57.089215Z`; both C2b states retain
`2026-09-12T23:38:22.888Z`. A0 acceptance and C1 completion remain false; C2b
retains one qualifying independent sweep and an undelivered final report.
The new runtime boundary is explicit. Savings of at least 50%, event-to-reader
latency and the remaining stage gates are not established by this deployment.
Migration 0192 is a separate next topic and is not part of this 187-migration
release. No B2 work is introduced.

## Local alias corrections

The review found two A0/C1 `latest_deployment` aliases pointing to September 12,
A0's matching preservation alias, stale current health/evidence wording about
unread flags, and C2b's stale failed configuration-attempt aliases. These were
updated from the current receipts. The original at-deployment boundary still
records the then-unverified flags; a separately dated configuration follow-up
now prevents it from being mistaken for the current read.

`state-before-post-review-alias-0.json` through `-3.json` preserve exact pre-edit
bytes, including the failed configuration attempt. `state-alias-review-changes.json`
lists changed fields and before/after hashes. No observation count, original
clock, acceptance gate or measurement receipt was changed. Existing historical
post-release measurement aliases retain their original, explicitly dated scope.

## Evidence fingerprints

- `REPORT.md`
  `6491f2e14f63e73599bc86814078c345949e4a256e10fc1f9e5d645769b2c925`
- `summary.json`
  `b1347d1846b7fa306dbe1534b66ca982751e09832b18b1fdb96072880a436dfd`
- `REVIEW-PREFLIGHT.md`
  `c3441ffff59885af25beae4827027b4cc0e6a3393d98c7b7f71c4daac3c4efb2`
- `candidate.json`
  `89949431116b8d8251f651eb1225c8415cf229cf7f6576458e40a233945ee1aa`
- `deploy-execution.json`
  `e00324e2d000cec28f8eb43ef7f93382ddee6c1f3ecdc20ff8e1ad39453e149e`
- `deploy-full-execution.json`
  `39d7549e10162d6ff2ead60e5f779c267a451bc175fcbd7379d309d13149b18e`
- `deploy.log`
  `1e749bbc5d1662fd7172ea065b67dbf3b9cbc40369643916da8e748e6e0bf6d4`
- `deploy-full.log`
  `3e648b8fda8e7e2f7c770681c346ad6603839b756fe87ace589c07161f82e60c`
- `post-runtime.stdout`
  `184f08899836f6aa5663981f9aecae1fb316645e2fc7a5a7c2e2cce3b737689a`
- `post-image-corrected.stdout`
  `76a06f6dc7085ed2a3b10dda245599b900b55d7863265a84c54c2b0c9aeadc78`
- `post-migrations.stdout`
  `96c5c4252a8328a157ae392bf2964be843fa31d604bbb748b75739c6c37c3443`
- `native-chromium-smoke.stdout`
  `b55baaaf411a9f613233af5e5cd9c63e285c80f6927842eeb43cdd6564f16ee0`
- `configuration-read.json`
  `2032530872dd6abc35adade6ed93e4ba4bcf9681db1748b133bddf56ddcfe377`
- `state-alias-review-changes.json`
  `502c42f0b8bfac99781024dd834ae4e6cca83ecec365f14aa06376646e6d1300`

The coordinator may append completion/review pointers after this review.
Those bookkeeping additions do not constitute another measurement.
