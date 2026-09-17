# Independent PR193 deployment and measurement preflight

Reviewer: `/root/w0_role_tests`. Local source, Git objects and retained receipts
only; no tests, production calls or deployment performed by reviewer.

**No actionable finding in the prepared protocol or migration delta.** This is
conditional readiness: PR193's CI was still running at review, and the final
merged-main commit/image and completed deployment gates must be retained before
measurement. This review does not assert that migration 0192 is already applied.

## Exact candidate and migration inventory

Reviewed topic head: `3446cbd3b8a228b01a6395123a74ba37c201894f`, based on
`4e18d130ea6ca4b834141789265cce8442f8fcae`. The previously reviewed function,
runbook and tests remain unchanged. The source review and passing 3,753-unit /
45-PG receipts live in the topic investigation; no duplicate tests were run here.

All eight preflight stdout/stderr hashes verify; all four commands exited 0.
The 15:13 migration receipt reports `read_only` and READ ONLY. Its retained SQL
explicitly requests REPEATABLE READ with 5-second statement and 100-ms lock
limits. There are 187 applied IDs and 188 candidate files. The only pending file
is `0192_fansly_dm_shadow_material_probe.sql`; no applied ID is absent. Every
one of the 187 existing migration Git blobs exactly matches prior release 4e18.

The runtime receipt still shows 4e18 / image `a891…`, all four containers healthy
with zero restarts and unchanged starts. Disk has 17,552,572 KiB available at
79% used; the lock check exited 0 with no existing lock output. These are the
retained 15:13 preflight observations, not a replacement for deploy-time checks.

The diff changes no dependency manifests, lockfile or Dockerfile. Standard
`dist-only` therefore fits the previously established 4e18 clean full base and
checksum `0667a9e9cd490c9c7ee729e146cfbfa2e432a5c983c3ceec9804f4d9eb24ccd4`.
The existing script verifies the labeled base before building, carries the full
migration directory in the overlay, and refuses build failure. Do not enable
its unlabeled-base bypass. Apps scope and GC-off preserve the intended normal
promotion scope. Additive 0192 is in the application-rollback allowlist; it may
remain unused after rollback. The previously reviewed automatic rollback can
still recreate Postgres, unlike normal apps promotion.

## Fixed once-only measurement protocol

`measure-material.py` names exactly ari-1, lilly-1, lilly-2, lora-1, lora-2 and
lora-3. It creates a new output directory with `exist_ok=False`, preventing an
accidental second invocation against the same evidence directory. It performs
one serial call per page, no automatic retries and no provider requests.

Each call uses only the existing `read_only` login, starts a READ ONLY,
REPEATABLE READ transaction, sets deadlines in separate SQL statements before
the probe, exports identity/settings, invokes the fixed function once with 100
as its sample cap, and rolls back. The page labels are fixed source constants,
not caller-controlled SQL. There is no privileged-login fallback or table grant.

The remote psql process has an 8-second timeout plus 1-second kill grace; the
local subprocess has at most 20 seconds and is shortened by the remaining
45-second invocation budget. A failed process, timeout or invalid receipt stops
later calls. Those pages, unvisited pages and `no_sample` pages remain unmeasured.
Local timeout does not prove immediate remote cancellation; server/remote limits
remain separate protection, and no further page is dispatched after failure.
Normal Python execution is required because the private collector uses assertions
for receipt-shape and identity checks; do not launch it with optimization enabled.

Raw stdout/stderr bytes, their hashes, SQL text, command, timestamps and local
elapsed time are retained. The final release evidence must also bind this script
and the measured SQL to the exact merged deployment revision; the current topic
head is not a substitute for that forthcoming deployment receipt.

A successful process exit alone is not the measurement verdict: inspect the
written summary and `unmeasuredPages`. `measured` is emitted only after the fixed
plan/identity checks; a timeout's partial output is never promoted into a timing.
The collector records the material plan's planning/execution time and block
counts separately from local elapsed time. It does not calculate predicate
results, reader completeness, event-to-reader latency or savings. The biased
current-head sample and cache/instrumentation limitations in D332 still apply.
No flag, observation clock, stage gate or provider-side deletion policy changes.

## Reviewed SHA-256

- `measure-material.py`
  `7c4ed697bad6d7e56cb014b5b65ccf57b40e43721eae0f1e5ddf14d1613e183f`
- `preflight-migration-comparison.json`
  `364cf4146fbbaf1bb79ca0440f519b490f7e69cd2cd1f18898ee5672d921d82a`
- `preflight-migrations.sql`
  `059d0219ecc3e415cfab91594a5a42af044af49ee855f408723e74633ca7e086`
- `preflight-migrations.stdout`
  `a634a4eed5de961c4e991469d8c0357e6ba25ea16313e0db395ed182e6e80f7a`
- `preflight-runtime.stdout`
  `184f08899836f6aa5663981f9aecae1fb316645e2fc7a5a7c2e2cce3b737689a`
- `preflight-disk.stdout`
  `1cbe95b5a1ea998536f5ff96de19546ff9b78eaa80df521c0a49f52e311f8a89`
- `0192_fansly_dm_shadow_material_probe.sql` in the topic worktree
  `4c6a00a4d533562e6520de855454a68459d8ac80c50b376247b5a16a707cab1d`

Final exact-main composition, CI completion, deployment/post-migration checks
and the once-only measurement remain coordinator actions after this review.
