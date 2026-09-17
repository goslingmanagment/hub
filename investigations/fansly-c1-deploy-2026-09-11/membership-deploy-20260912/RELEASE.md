# C1 membership release — 12 September 2026

Release commit: `7aaa3185757e6a89d1b7427b0d54aa8720c74da4`.
Parents: production `02ff7e34239e` and PR166 `97fcbd031968`.
Tag: `release/fansly-c1-membership-20260912`.
The same C1 worktree is temporarily detached; its branch/PR remain unchanged.

The owner explicitly resumed implementation to completion and authorized all
deployments. This release adds follower membership diagnostics and forward
migration 0185. No flag, socket, A1, recovery or replay operation is included.

All 180 prior migration blobs and every unrelated 02ff path are preserved.
Only the exact reviewed C1 delta is added. Decision 294's refinement is placed
before the unchanged Decision 295. The assembly and source-export receipts are
in the C1 worktree's evidence/membership-20260912 directory.

## Verification

Fresh production read at 12:03 UTC: all three roles healthy, zero restarts,
02ff on image `sha256:8d6065ee434c1123ecd96831a176ea997504670182b0075a88bc827af4405653`.
Ordinary API/DB health passed; 23,300,804,608 bytes free. Before dispatch, verify
the same source and no concurrent deployment. Combined-source check, serial
Postgres suites, production build and both independent release reviews must pass.

Use the unchanged standard deployment:

```sh
bash scripts/deploy-production.sh --mode dist-only --no-image-gc root@45.8.230.111
```

Before dispatch, confirm the monitoring token is present without exporting its
value. The script can skip this check when the token is absent: an exit 0 with
`sync-health=skipped` does not pass this release's required gate. Acceptance
requires an actually executed protected check returning HTTP 200. This check
is part of the authorized deployment; do not repeat it as an ad hoc observation.
Retain actual result and timing,
ordinary health, dashboard, all three runtime labels and new migration evidence.
The script verifies labels for API/worker; explicitly verify scheduler too.
The CLI rebuild is warning-only on failure: separately verify its installed
source, symlink and successful capabilities before declaring completion.

## Rollback

Migration 0185 only replaces the restricted diagnostic function; old application
code remains compatible. It is absent from the deployment's rollback-compatible
allowlist, so schema change causes the script to skip automatic rollback.
Retain the previous 02ff image and release files; no image GC is requested.
If needed, restore that runtime image with the applied 0185 function retained.
Never edit or reverse applied SQL or delete captured diagnostic evidence.
A failed deploy gate remains failed until verified recovery; healthy containers
alone do not close it. A0's original observation clock is retained, with the
new runtime boundary recorded. No savings or fresh-event latency claim follows
from deployment success.
