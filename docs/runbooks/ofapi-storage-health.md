# OFAPI mirror storage-health gate

The OFAPI mirror refuses every new governed vendor dispatch when the latest
filesystem sample is missing, older than two hours, failed, or at/above the
configured disk threshold. Captured responses already in Postgres remain
locally replayable; the gate must not be bypassed with an uncaptured live GET.

## Inspect

1. Read the owner capture-operator status endpoint and find `storageHealth`.
2. Check the worker log for `Startup disk usage check complete` or
   `Disk usage check failed to stat the filesystem`.
3. Confirm the database and worker see the same VPS volume. Production uses
   `statfs("/")` because Postgres and the worker share that physical disk.
4. Treat `storage_unhealthy` budget denials as containment, not as a vendor or
   chatter failure. They do not count toward the per-principal storm breaker.

## Recover safely

1. Pause capture globally before filesystem maintenance.
2. Free space only from known disposable operating data (old build caches,
   rotated host logs, unused container layers). Do not delete observations,
   domain events, coverage proofs, message material, credit ledgers, or export
   artifacts to make the alert disappear.
3. Restart the worker for its startup check, or wait for the hourly scheduled
   check. A successful fresh sample automatically makes admission eligible
   again.
4. Verify the stored sample is healthy and recent, then resume the global
   control with the expected control version.
5. Confirm that parked jobs resume without a jump in dispatch or credit rate.

If safe headroom cannot be restored, keep capture paused. Moving immutable
facts to an approved off-box tier is a separate owner decision; deleting them
is not a recovery procedure.
