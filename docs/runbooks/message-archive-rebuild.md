# Message-archive shadow rebuild (W10, decision #134)

The only sanctioned way to rebuild `message_archive`. The old one-command
rebuild (delete + event replay) is lossy by construction — the replay reads
only ATTACHED `domain_events` partitions, and the delete destroys legacy-seed
rows (`source_event_id IS NULL`, `backfill_source IN
('dm_message_archive','hot_table')`) whose hot originals may already be
pruned; for those rows the archive IS the only copy. Decision #134 rejects
in-place rebuild; this is its shadow-build ritual.

## Preconditions (all of them, every prod run)

1. **E5 re-journal first** — the fidelity proofs must see the healed ledger.
2. **No erasure during the rebuild window** (W6 ⟂ W10): an erasure run
   deletes from `message_archive` but knows nothing about
   `message_archive_shadow` — a shadow built before the erasure would
   resurrect erased rows at switch. Finish or postpone erasure.
3. **No tiering run during a build** — a detach committing mid-build is
   caught by the gate re-check (the account's transaction aborts), but don't
   invite it: the tiering job runs 04:40 UTC, schedule around it.
4. **First prod run on one small account**, preflight output reviewed by the
   owner before the fleet run.
5. Migration 0083 applied (creates `message_archive_shadow`).

## R0 — preflight (read-only)

    pnpm cli archive:rebuild-preflight [--account <id>]

Per account: total rows, event-sourced rows, legacy seeds by source,
**unrecoverable-if-dropped** rows (legacy seeds with no surviving origin in
`dm_message_archive` OR the hot table — the corrected census that includes
`dm_message_archive` as a source), plus the detached-partition census
(pg_inherits vs `tiered_pending_drop` and detached-in-public leftovers).
Nonzero `detachedPartitionsHoldingEvents` for an account means the build will
hard-refuse for it — re-attach via the Stage 28.3 restore path
(`tiering:restore-drill`) first.

## R1 — shadow build (writes ONLY to message_archive_shadow)

    pnpm cli projection:rebuild message_archive [--account <id>]

Per account, one transaction, restartable (a re-run clears that account's
shadow scope first): (1) legacy-seed LIFT — verbatim copy, provenance
preserved, never re-derived; (2) event replay from seq 0 behind the HARD
detached-partition gate (checked at start AND at end of the transaction);
(3) account-scoped backfill re-run. The live table is not touched. Rollback
at this stage = simply don't switch (dropping the shadow is a separate owner
decision; nothing reads it).

The replay derives `text_plain` through the HTML-stripping writer (A51), so
rows projected before the strip existed come out healed — expect `text_plain`
diffs in R2 flagged `healedHtml: true`.

## R2 — fidelity proof (read-only, exit 1 on loss)

    pnpm cli archive:rebuild-verify [--account <id>] [--sample <n>]

Set-difference proof (shadow ⊇ old on `(account_id, platform, message_ref)`)
plus per-column material comparison (`text_plain`, `occurred_at`,
`price_mills`, `tip_amount_mills`, `deleted_at`, `conversation_ref`,
`fan_native_id`) with a bounded diff sample. **Nonzero missing rows = FAIL
(exit 1) — the switch refuses on the same condition.** Material mismatches
that are NOT `healedHtml` deserve a look before switching; `extra` rows
(shadow-only) are new coverage, not loss.

## R3 — atomic switch (OWNER-GATED)

1. Owner confirmation (structured gate, per house rules).
2. **Pause the archive sweep worker** for the window — on the VPS:

       docker compose stop worker

   (The sweep would otherwise read the pre-switch watermark and race the
   rename; every other `message_archive` writer lives in the worker too.)
3. Fresh `archive:rebuild-verify` (must be ok) — the pause froze the old
   table, so a clean verify now stays clean.
4. Dry-run, then execute:

       pnpm cli archive:rebuild-switch            # dry-run report
       pnpm cli archive:rebuild-switch --execute

   One transaction, serialized against builders by advisory lock: refuses on
   missing rows; renames old → `message_archive_retired_<ts>` (KEPT —
   capture-first; its drop is a separate owner decision), shadow →
   `message_archive`; moves the canonical index/constraint/sequence names to
   the live table; force-resets the `message_archive` projection watermark to
   the shadow's replay high-seq (delete + reinsert — the guarded upsert would
   keep a higher stale watermark and silently skip events); and bumps
   `archive_generation` (see below) in the same transaction.
5. Resume the worker:

       docker compose start worker

   The next sweep continues from the shadow's high-seq into the new table.

## Rollback

- **Before the switch:** nothing to roll back — the live table was never
  touched. Discarding the shadow is an owner decision.
- **After the switch:** reverse rename (`message_archive` ↔
  `message_archive_retired_<ts>`) with the worker paused; the retired table
  still exists in full. Restore the watermark rows from the retired-era
  values only if the new table wrote nothing yet — otherwise rebuild forward
  (a fresh shadow build is cheaper than reasoning about a half-written
  watermark).
- **MANDATORY after ANY manual rename** (the reverse rename above, or any
  other hand-run swap that changes which physical table answers as
  `message_archive`): bump the archive generation in the same psql
  transaction as the rename —

      update archive_generation
         set generation = generation + 1,
             bumped_at = now(),
             reason = 'manual rollback rename'
       where id = 1;

  Agent read cursors carry the generation they were minted under and are
  refused (`agent_cursor_invalid`, 400) once it moves. Skipping this bump lets
  a reader resume a cursor against a DIFFERENT physical table: it silently
  skips rows and still reports `snapshotExhausted: true` — a false "I read
  everything". The `archive:rebuild-switch` path does this for you; only
  hand-run renames need the statement.

## Interactions

- **Erasure (W6):** forbidden during the window — see precondition 2.
- **Tiering (Stage 28):** the gate makes a mid-build detach loud, and the
  first tierable partition ages out ~2027-01; re-attach before rebuilding.
- **Prune (Stage 28.2):** the hot-table prune gate
  (`countArchiveCoverageGaps`) keeps answering against the LIVE table
  throughout; R2 also reports the same question asked of the shadow.
