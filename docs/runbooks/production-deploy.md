# Production revision guard

Use a current `scripts/deploy-production.sh` and a clean committed source tree
for every mode (full, dist-only, auto and pull). Tracked changes and untracked
release inputs are refused. Fetch the deployed commit's Git history first.

While holding the remote deployment lock, the driver reads the actual images
of API, worker and scheduler, including stopped containers. Ordinary deploys
must contain every deployed commit. A missing/dirty/unknown revision, partial
stack or inspection failure stops deployment before image tagging, migrations
and service stops. It repeats the check before quiesce and refuses an external
image replacement during its build. An entirely empty role inventory is
allowed, subject to the existing infrastructure checks.

For an intentional rollback or divergent replacement, use the current driver
with a separate clean source checkout and the exact currently deployed label:

```bash
git fetch origin
git worktree add /tmp/hub-rollback <reviewed-target-commit>
/path/to/current/hub/scripts/deploy-production.sh \
  --source-dir /tmp/hub-rollback \
  --replace-deployed <current-12-hex-revision> \
  --mode full root@server
```

The expected current revision must match **every** role; it is checked again
after the build. The override is CLI-only and does not bypass clean-source,
Git-history, migration compatibility, infrastructure or health checks. Use
dist-only only when the target's dependency-checksum clean base is available.
The production-pinned Hub CLI is rebuilt from the selected source checkout.

This is a guard in the deployment driver. A historical copy of the script or
direct root-level Docker commands can bypass it; do not use an old checkout's
script as the driver. A driver must be updated before launching deployments.
Automatic rollback of a failed deployment retains its existing safeguards and
does not invoke the ancestry guard.

The source tree is checked at several stages, but local full/dist builds read
it from disk: keep the selected checkout untouched until deployment finishes.
