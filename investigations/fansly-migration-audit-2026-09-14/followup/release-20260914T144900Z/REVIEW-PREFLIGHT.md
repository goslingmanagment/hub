# Independent deployment preflight review

Reviewer `/root/w0_role_tests`, 2026-09-14T14:51:46.189168+00:00.
Local Git/artifact inspection and read-only GitHub checks only. No tests,
production requests, source changes or deployment were performed by reviewer.

**Ready to run the approved standard deployment of the exact candidate below;
no migration, source, test-receipt or flag blocker found. The existing rollback
scope limitation is explicitly retained. This is readiness, not a completed
production health gate or migration-stage acceptance.**

## Exact candidate and validation

- Commit **`4e18d130ea6ca4b834141789265cce8442f8fcae`**, tree
  **`372b84f04df46c3cb607d5d5eef9c8a7c401bb62`**. GitHub main and successful push CI run
  **34798541588** independently match this exact commit. All three integration
  shards, Static checks, Quality Gate and checked-image publication succeeded.
- Immutable image: **`ghcr.io/goslingmanagment/core/runtime@sha256:afd05e2d198529613ce769039dfad6774f206425d87c566fd6bb51c2fecf2954`**.
  The published receipt records image ID **`sha256:07cf00d61c476e30a9d0a7d135ca2e03d11c3cffc948c36522af26b3e9c74362`**.
  The standard pull path must inspect its platform, source revision and dependency
  checksum before any image promotion; the digest is not a mutable tag.
- Clean release worktree: `/Users/dmitriy/.codex/worktrees/hub-fansly-audit-release-20260914`. Its tree exactly equals the locally tested
  composed tree at `02d70db5`; all **1,592** retained source hashes match, tracked
  state is clean and no untracked release inputs were found. The stale main
  checkout at `b48f173d` is not the deployment source.
- The combined receipt manifest's five hashes and decompressed original-log hashes
  verify. `pnpm check`: **3,751 passed, 9 existing skips, 324 files**, including
  strictness/lint/build, exit 0. The **13 serial Docker-Postgres suites: 96 passed,
  zero skips**, exit 0. The current exact-main CI provides additional composition
  validation; no new local run was needed for this unchanged tree.

## Migrations and retained production behavior

All **187 migration filenames and Git blobs** exactly match production source
`380326368fe39a6a9d22eb73b0b955f8ecd7c3cc`, including every existing migration in
0178–0191 (0179 is absent from both source inventories). Exact applied files:
0185 SHA256 `bd9c2ee7987815ef6fd0f517a0783ead45954a2eb6ad7b5553c0075859940cb0`;
0186 SHA256 `8fde039eb9e8f0d211ab419f0cd7264e5186aa79d9e223c6a4a42a083d571b7e`.
The fresh retained 14:49 `read_only` / READ ONLY ledger independently contains
exactly those **187 IDs: zero pending and zero applied-but-absent migrations**.
Its SQL explicitly uses repeatable read, 5-second statement / 100-ms lock limits.
All eight preflight raw stdout/stderr hashes verify; four commands exited 0.

The retained preflight reports all four services healthy, zero restarts,
application source still `380326368fe3`, no deploy lock and **17.51 GiB** available.
This does not replace the script's fresh lock, migration, infrastructure and
capture-rewrite checks immediately before promotion.

The candidate preserves production migrations, configuration catalog/defaults,
startup and compose configuration. Its runtime differences are the reviewed
cooldown retention/incident visibility, DM history/exclusion fencing, earnings
claim/settlement and money-codec fixes, plus manual W0 probe helpers. Installing
those helpers does not start a socket or move A0/A1/B0/B1/C2c gates. Existing DB
allowlists remain the authoritative settings: deploy is not a flag flip. A long
provider cooldown can now open the existing incident on its first failure; the
provider deadline itself remains intact.

## Deployment gates and rollback limitation

The requested `--mode pull --recreate-scope apps`, with GC off, uses the existing
script. It verifies a clean unchanged checkout and immutable image metadata,
captures the previous image/release files/schema ledger, preserves matching
PostgreSQL/shared infrastructure on normal promotion, checks capture rewrites,
and verifies API, worker, scheduler, image labels, lifecycle capability and
same-origin dashboard afterward. The runtime source already advertises the
existing lifecycle capability; this is not a first enablement request.

**Automatic rollback can recreate PostgreSQL.** At script line 892, rollback
runs Compose `up --force-recreate --no-build` without app service names; the
`apps` scope narrows normal promotion only. Coordinator explicitly acknowledged
this existing behavior before proceeding. Do not promise PostgreSQL will remain
untouched after a failed rollout. Rollback also requires the captured image and
release files, compatible schema delta and preserved legacy-crawler retirement.
No schema delta is pending in this candidate; the script still rechecks it.

Protected sync-health verification uses its existing monitoring token when
configured and accepts a valid `pages` response with HTTP 200 or 503. Its outcome
must be retained; a skipped check is not a passed protected check, and a valid
503 response is not proof that every stream is healthy. Do not reuse the old
runtime's liveness as the new deployment gate. Final deployment verification and
continued shadow observation remain the coordinator's next actions.

## Evidence hashes

| Artifact | SHA256 |
|---|---|
| `candidate.json` | `89949431116b8d8251f651eb1225c8415cf229cf7f6576458e40a233945ee1aa` |
| `main-ci.json` | `5c1bbbeda2850cd458ebef8c35c22214b9324d79121a262a71df64ede1ac06ad` |
| `published-image-identity.txt` | `469ef2c6e7f014f170d49c6e5c7172ce625bc1922799171e8f85c9955f21242d` |
| `migration-comparison.json` | `7b04cbb1b1d1200fb734af9e6db610e90c1895b170c6e9ca882a0a473877a978` |
| `preflight-migrations.stdout` | `6d396cd074171a605c7f274500770b784d33428a8584199bf9ef1f539936290a` |
| `preflight-migrations.sql` | `059d0219ecc3e415cfab91594a5a42af044af49ee855f408723e74633ca7e086` |
| `preflight-runtime.stdout` | `ce86b1f34a99f064f1d6a675b293f6ba588407970a6a5591fe4b4a139d2146c4` |
| `preflight-disk.stdout` | `66be3b2c6c8bfc2de44c6689267670f54f462644ad6b50fa29d04279f0feb0f4` |

Deploy script SHA256: `92dba119fd4876c323b6f06f106aa8ae2ffec1a7abe3e65e154a28dcd817f8ff`.
Combined tests: `../final-candidate-tests/`; main CI:
https://github.com/goslingmanagment/core/actions/runs/34798541588.
This review makes no production savings, event-to-reader latency or stage-completion claim.
