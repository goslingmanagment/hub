# Daily copy of the hub's business data

The production database has no other copy. Once a day the owner's Mac pulls a `pg_dump` of
everything a person or money depends on; the raw capture and the engine's own tables are copied
as schema only (about 67 of the 80 GB, see the list and the reason for each table in
`scripts/backup/business-dump.sh`). The raw rows that unfinished work still needs go into a second
file of the same copy. A full copy of the raw capture needs bought space and is not part of this.

| What | Where |
|---|---|
| The dump | `~/Backups/agency-hub/<UTC>/hub-business.dump` (`pg_dump -Fc`, PostgreSQL 16) |
| Raw inputs of unfinished work | `~/Backups/agency-hub/<UTC>/hub-unfinished-inputs.sql` (psql script of `COPY` blocks) and the selection that chose them, `unfinished-inputs.sql` |
| What it is | `~/Backups/agency-hub/<UTC>/manifest.json`: bytes, tables, tables with data, snapshot time, unfinished work by state, hub revision (the API image's source revision), `/api/v1/health` contract hash, duration |
| How many | every copy is kept: nothing deletes a copy (deleting backups is the owner's call). Each run prints how many copies there are and their total size, and refuses to start when less than 30 GB is free on the Mac's disk (`HUB_BACKUP_MIN_FREE_GB`) |
| When | daily 05:20 Moscow (02:20 UTC), launchd agent `ru.gosling-agency.hub-backup`, logs in `~/Backups/agency-hub/logs/` |

## How it works

- `scripts/backup/pull-backup.sh` (Mac) opens one read-only psql session on production that
  exports a snapshot and, in it, copies the raw rows named by `unfinished-inputs.sql`. Then it sends
  `business-dump.sh` over ssh (`bash -s`), which runs `pg_dump --snapshot` inside
  `agency-hub-postgres-1` and streams it to stdout, and the session ends. Both files describe the
  same instant. Nothing is written on the server. Everything lands in `.incoming-<UTC>/`; it gets
  its dated name only if the dump is not obviously empty, `pg_restore --list` reads it, the business
  tables carry data and the inputs file is complete. One JSON line on stdout.
- Unfinished work that needs raw rows (`unfinished-inputs.sql` explains each): capture jobs
  awaiting their parse (the paid response), finished steps of unfinished collection jobs, sync
  attempts captured but not applied, parse quarantine, OnlyFans media source bytes, pending
  websocket decode receipts (with the receipts), link-fan journal pages after the projection's
  cursor, and never-parsed observations of the last hour (the canonicalizer's in-flight work).
- Production load: one connection for the dump, one READ ONLY snapshot, the client under `nice`;
  the inputs take about 30 s before it. The dump holds ACCESS SHARE on every table until it ends
  (about 10 minutes): reads and writes go on, DDL waits. Migrations take no `lock_timeout`, so do
  not deploy while a dump runs; the daily slot ends well before the partition job at 03:10 UTC.

## Run by hand

```bash
bash scripts/backup/pull-backup.sh      # one copy now (one at a time; a second run refuses)
bash scripts/backup/restore-drill.sh    # newest copy → throwaway local cluster → counts vs production
```

The drill restores the dump into a PostgreSQL 16 cluster in a temp dir on a free localhost port,
loads `hub-unfinished-inputs.sql` on top, and deletes the cluster afterwards. It prints:

- the row counts of ten business tables restored and on production now (read-only). Production
  keeps writing, so a busy table is ahead by the hours since the dump; an empty restored table fails
  the drill;
- the unfinished work by state as production had it in the dump's snapshot (rows, and rows whose
  raw input production had) next to the restored copy. Any input production had and the copy lacks
  fails the drill.

The only restore errors it accepts are foreign keys into tables whose data is not copied (today the
two lineage keys of `transaction_tip_contexts` into `sync_raw_payloads`; the tip and its text are in
the copy).

## Install, update, remove

```bash
bash scripts/backup/install-backup-launchd.sh             # copies the scripts to ~/Backups/agency-hub, loads the agent
bash scripts/backup/install-backup-launchd.sh --uninstall # removes the agent and the copied scripts, keeps copies and logs
```

Launchd runs the copies in `~/Backups/agency-hub`, so re-run the installer after changing
`pull-backup.sh`, `business-dump.sh` or `unfinished-inputs.sql`. It converts 05:20 Moscow into the
Mac's local time at install.

## Restoring for real

`pg_restore --no-owner --no-privileges -d <empty database> hub-business.dump`, then
`psql -v ON_ERROR_STOP=1 -d <database> -f hub-unfinished-inputs.sql` (as in the drill). What a
restored copy does not have:

- the raw capture history and the event stream (`domain_events`): replays and repairs over history
  have nothing to read, and reads that go to the stream directly (new-subscriber list, link-fan
  period starts, the agent journal, golden signals) start empty;
- observations below their family's current parse version that were parsed at an older one (the
  replay after a parser bump), and never-parsed observations older than the last hour (mostly kinds
  nothing consumes yet);
- domain events appended in the last seconds before the snapshot and not yet projected;
- the pg-boss backlog and schedules: the app re-creates queues and schedules on start, and no
  queued send is replayed. Turn off the outgoing workers before an app ever runs on a copy.
