# Fansly reply repair before A0

Scope: the P2 in the [8 September diagnostic](../../investigations/fansly-dm-diagnostic-2026-09-08/REPORT.md).
Implementation: decision 278; migration 0173; sync-pull v6. No new flag.

## Gate 1: deploy the reviewed prerequisite revisions

Requires an explicit owner yes in the implementation chat. Include both merged
PR revisions in the approval target and name the effects:

- 0172 creates/seeds known-head debt, with recovery allowlist `none`.
- 0173 adds two nullable reply clocks to the live and shadow archive; no bulk rewrite.
- v6 starts the existing bounded background reparse of retained sync-pull
  observations, including DM and purchase-history material. The version is
  family-wide: unchanged earnings/transaction facts are re-read and deduped too.
  This writes events/projections and uses database resources immediately after
  deploy. No new Fansly HTTP calls are made by reply replay.

Do not describe this deployment as waiting for a later replay switch. Do not
change the head-recovery allowlist, deep-history budgets or any other flag.
Use the existing production deployment runbook from the approved clean revision;
verify the exact image source revision, migrations, health, logs and free disk.

## Read-only acceptance

1. Record the sync-pull v6 backlog and canonicalizer/projection errors from
   permitted health/read surfaces and logs. Detached-partition or missing-body
   blockers mean incomplete repair, never a successful replay. Do not change
   database roles to bypass missing read access.
2. Re-read the six exact message IDs in
   [diagnostic reply evidence](../../investigations/fansly-dm-reply-material-2026-09-08/evidence/diagnostic-reply-serving-check.json)
   through the authenticated Hub transcript CLI. Check parent, root (where the
   retained raw contains one), text and attachments. The previously populated
   lilly-2 link must survive. Five missing of six is a sample, not a corpus count.
3. Compare raw reply fields against serving fields over a bounded declared
   cohort on all six pages. Count unavailable bodies, absent archive rows,
   wrong/null parents, wrong/null roots and stale/explicit-clear cases
   separately. Do not infer completeness from the canonicalizer backlog alone.
4. Record duration, event/DB growth and projection lag. This change adds common
   material for text messages whose raw explicitly observes reply fields,
   including nulls; most such messages may now produce additional projection
   material. No storage-savings or latency target is claimed in advance.

## Gate 2: optional scoped replay

Only if ordinary replay has not covered a specific retained window and its
partitions are attached, prepare exact account/window values and get separate
owner approval. Existing command (replace the placeholders before approval):

```sh
pnpm cli events:replay --kind dm_messages --account PAGE_ID --from FROM_ISO --to TO_ISO --parse-version 6 --dry-run
pnpm cli events:replay --kind dm_messages --account PAGE_ID --from FROM_ISO --to TO_ISO --parse-version 6
```

Run against the approved production runtime using the existing CLI runbook.
Do not use an inflated parse version (such as 99), reset stamps, launch archive
rebuild, or re-fetch provider history as a shortcut. Capture scanned/appended/
deduped/stamped/errors/partitionBlocked and verify transcript parity afterwards.
Dry-run is database-read-only; actual replay writes and needs the explicit yes.

## Shadow fidelity check (only for a separately approved rebuild)

The old shadow verifier does not compare reply clocks. Before any future
switch, compare them separately with the intended account scope using a
read-only transaction. Do not launch a rebuild as part of this reply repair.
If the read-only role lacks access, record the access blocker; do not bypass it.
A mismatch needs explanation (expected repair versus loss), not a blind switch.

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT count(*) AS reply_mismatches
FROM message_archive a
JOIN message_archive_shadow s
  ON (s.account_id,s.platform,s.message_ref) = (a.account_id,a.platform,a.message_ref)
WHERE a.account_id = :account_id
  AND (a.in_reply_to_ref,a.reply_metadata,a.reply_parent_observed_at,a.reply_root_observed_at)
      IS DISTINCT FROM
      (s.in_reply_to_ref,s.reply_metadata,s.reply_parent_observed_at,s.reply_root_observed_at);
COMMIT;
```

## Rollback and exit

A code rollback requires owner approval and leaves forward migrations, raw,
ledger facts and repaired archive intact. An old binary cannot correctly
replay v6 field clocks and restores v5's faulty reply handling; it is containment,
not a completed repair. Never promise rollback reverses parse stamps or events.

Exit only after the bounded production corpus proves preservation and repair,
with unresolved cases itemized, and the head/debt prerequisites have separately
passed their runbook. Until then A0 has not started. A0 provider-deleted heads
remain discrepancies; this repair does not claim complete edits/deletes.
