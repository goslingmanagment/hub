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

### Fresh capture during replay (Decision 279)

The reviewed follow-up gives never-parsed sync-pull capture an independent
durable sweep cursor. It selects version-zero rows before retained replay,
sharing the existing time and family page allowance with historical replay.
The first pass gets at most half; the second gets the unused allowance. A
separate CAS turn marker is saved before work so overshoot or a worker crash
gives the other pass first turn next time. After both passes run, new capture
starts first again. Historical replay retains its original cursor. Both passes use and
stamp the current v6 parser. This adds no flag, migration or provider requests.
The original page/run limits still apply, including completion of an in-flight
page after a time budget expires. Other families and CLI replay keep their
existing traversal.

Before approving its deployment, retain the version-zero count/oldest receipt
and the older-version backlog separately. After deployment, compare both over
successive completed sweeps: new capture must progress while replay also
advances. A shrinking total backlog alone does not prove fresh materialization.
Keep the head catch-up allowlist `none` during this verification. Check the
exact canary target in Agent transcript and finish the reply corpus comparison
before declaring acceptance. Do not infer a latency percentile from the
configured time budget.

For a separately approved code rollback, preserve all cursor rows, all parse
stamps and material events. The older binary ignores the extra cursor and
restores the old ordering; it cannot undo repaired data. See the bounded
read-only query in
`investigations/fansly-replay-freshness-2026-09-08/evidence/parse-lanes.sql`.

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
The canonicalizer's dry-run does not append events or stamp observations. The
standard runtime bootstrap still performs its configured OFAPI credential
preflight (`GET /whoami`) and records that proof before dispatching the command;
do not describe the entire CLI process as zero-HTTP or globally read-only.
Actual replay appends/stamps and needs the explicit yes above.

### A transcript timeout is an acceptance blocker

If a bounded transcript read times out, preserve the failed scope and follow its
narrow-window remedy once. If the same exact message still times out, stop that
page's acceptance and do not start the next page's replay. Other readable targets
can be checked with the excluded IDs explicitly listed; a reduced cohort does
not pass the original gate. Never raise the Agent statement timeout, bypass its
principal/evidence path, or treat v6 stamps as serving proof.

Decision 281 selects window candidate refs before loading their material while
retaining out-of-window versions for dominance. Its local benchmark is not proof
of production recovery. After a separately approved deployment, retry the exact
blocked targets, then complete the original cohort before resuming the already
approved remaining page scopes. No repeat replay is needed for an already-v6
window merely because its serving verification timed out.

Decision 282 scopes the chatless tombstone lookup to the current platform and
OFAPI binding. Its mixed-platform fixture removes a scan of unrelated cold
history, but production serving acceptance still requires the exact reads above.
A PostgreSQL timeout log may identify the failing statement without exposing
message bodies. Use the normal read_only role for diagnostics; if EXPLAIN is
permission-denied, preserve that denial and prepare an exact bounded proposal.
A separately approved one-time diagnostic exception is exhausted by its one
execution and does not change standing production access or authorize ANALYZE.

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
