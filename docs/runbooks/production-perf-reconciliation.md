# Reconcile the deployed performance fixes with main

Decision 321 restores deployed behavior on main `0a08365f`. The source manifest
and read-only migration/runtime receipts are retained in
[Git history](https://github.com/goslingmanagment/core/tree/ecc864dadebfe200107d07319054df5b4c4385f3/investigations/production-perf-parity-2026-09-14).

Before a deployment from main, reconcile the remaining C1 membership changes in
PR166 and the feature-controls dashboard branch. Passing this PR's tests does
not prove full production parity or authorize a deployment.

## Applied migration history

Keep `0185_fansly_followers_membership_read.sql` and
`0186_ops_metrics_recent_series.sql` under their original names and with their
original bytes. They were applied on production before 0187–0191. The production
ledger confirms names and dates; it does not store content hashes. Unit pins
compare the restored files with the identified production source revision.

The Postgres regression builds the deployed prefix through 0186, advances it
through current migrations, and checks that the restored ledger entries retain
their original timestamps. Fresh database creation remains covered by the common
integration template. Do not edit the migration runner or rewrite a ledger to
make an inconsistent database pass.

A development database built from the incomplete main may already contain later
migrations without 0185/0186. The runner must reject that out-of-order history;
recreate only disposable test databases, or prepare a separate reviewed repair
for a database containing data that must be preserved.

## Runtime and rollback

No new flag is added. Keep current main's tested image delivery and infrastructure
handling. The original 0186 index is additive and remains explicitly compatible
with application rollback; the migration itself is never rolled back.

Before any separately authorized deployment, retain the actual image/source,
migration names, configuration and relevant healthy roles. Do not reuse the
historical performance measurements as a measurement of the reconciled build.
If validation finds a regression, stop before deploying and fix the candidate.
Disk or temporary-probe cleanup is a separate production action; this runbook
does not authorize pruning images or deleting remote paths.
