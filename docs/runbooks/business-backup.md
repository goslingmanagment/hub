# Daily copies: the hub, ContentOps, what lives only on the Mac

## All copies

| What | From | To | When | How to restore | Not covered |
|---|---|---|---|---|---|
| Hub business data | agency-de, `agency-hub-postgres-1` (PostgreSQL 16) | Mac `~/Backups/agency-hub/<UTC>/` | daily 05:20 Moscow, `ru.gosling-agency.hub-backup` | `scripts/backup/restore-drill.sh`; for real: [below](#restoring-for-real) | raw capture and event stream (schema only, a full copy needs bought space), pg-boss backlog; the copy is on the Mac only |
| ContentOps database | VM `contentops-vm` on the owner's PC, compose `db` service (`contentops-db-1`, PostgreSQL 18.6) | Mac `~/Backups/contentops/<UTC>/contentops.dump` + `manifest.json` | daily 05:45 Moscow, `ru.gosling-agency.contentops-backup` | `scripts/backup/restore-drill-contentops.sh`; for real: [ContentOps](#contentops-database) | the media: 275 GB of blobs and 86 GB of derived files (needs bought space); the copy is on the Mac only |
| Gengar's workspace | Mac `~/.openclaw/workspace-chat` | agency-de `/var/backups/agency-mac/<UTC>/openclaw-workspace-chat/` | daily 06:05 Moscow, `ru.gosling-agency.mac-backup-push` | `rsync -a` the snapshot back ([below](#what-lives-only-on-the-mac)) | the excluded files (list below); OpenClaw's config and sessions outside the workspace |
| Bobr's workspace | Mac `~/.openclaw/workspace` | agency-de `/var/backups/agency-mac/<UTC>/openclaw-workspace/` | same run | same | same |
| traffic-control | Mac `~/code/3-traffic/traffic-control/data/`: `control.sqlite` and its own daily `backups/` | agency-de `/var/backups/agency-mac/<UTC>/traffic-control/data/` | same run | copy `control.sqlite` back while traffic-control is not running | — |
| ledger, TaskIndex | agency-de | Mac `~/Backups/ledger/` (every 6 h), `~/Backups/taskindex/` (daily 04:30) | their own launchd agents, from their repos | their repos' `deploy/` | unchanged by this; unlike the copies above they keep only the last 120 / 30 copies |

Nothing above deletes an old copy or snapshot (ledger and TaskIndex aside): how many to keep is the
owner's call. Each run refuses below a free-space floor instead: 30 GB on the Mac for the two pulls,
20 GB on agency-de's `/var` for the push.

## Hub business data

The hub's production database has no other copy. Once a day the owner's Mac pulls a `pg_dump` of
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

### How it works

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

### Run by hand

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

### Restoring for real

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

## ContentOps database

ContentOps (a VM on the owner's PC) had no copy of its database: the catalog, the custom orders,
the content plan, the journal. `scripts/backup/pull-contentops-backup.sh` (Mac) copies the whole
`contentops` database, about 240 MB compressed, in half a minute:

- It finds the `db` container of the compose project `/opt/contentops` and the deployed tag
  (`git describe` there), both read-only. One read-only psql session exports a snapshot and counts
  the main tables in it; `pg_dump -Fc` runs on that snapshot (`nice -n 19`, read-only,
  `--lock-wait-timeout=30s`) and streams over ssh into `.incoming-<UTC>/`; the session ends. Nothing
  is written on the VM, which transcodes all day.
- Checks before the dated name: at least 64 MB (`CONTENTOPS_BACKUP_MIN_BYTES`); the VM's own
  `pg_restore --list` reads the table of contents from this copy's bytes (fed over ssh: only the
  header and the TOC are read); every main table has its data in the dump, and the core ones
  (models, pages, people, catalog, blobs, orders, migrations, journal) are not empty.
- `manifest.json`: bytes, sha256, tables, the main tables' row counts in the dump's snapshot,
  ContentOps version, last schema migration, PostgreSQL version, duration. One JSON line on stdout.
- The media are not copied: 275 GB of blobs on the PC's C: and 86 GB of derived files on E:. That
  needs bought space (the owner's list).

```bash
bash scripts/backup/pull-contentops-backup.sh       # one copy now (one at a time)
bash scripts/backup/restore-drill-contentops.sh     # newest copy → throwaway cluster → counts vs copy and VM
```

The VM runs PostgreSQL 18.6; this Mac's Homebrew has 14–16, and a PostgreSQL 16 `pg_restore`
cannot read an 18 archive (`unsupported version (1.16) in file header`). So the drill restores
into a container of the image the VM runs, `postgres:18.6`, which is already on the Mac (the drill
never pulls one; without Docker or the image it says so and stops). The container has no network,
mounts the copy's directory read-only and is removed with its data at the end. It prints the main
tables restored, in the copy's manifest and on the VM now: restored must equal the manifest
exactly (same snapshot); the VM is ahead on busy tables by what was written since.

Restoring for real: on a fresh ContentOps `db` (its first start creates the roles
`contentops_migrate`, `contentops_app` and the empty database, `ops/db/init-roles.sh` of
contentops), `pg_restore -U postgres -d contentops contentops.dump` with a PostgreSQL 18
`pg_restore` (the `db` container's own): owners and grants come back as they were. The drill uses
`--no-owner --no-privileges` only because its cluster has no such roles. The bytes the catalog
points at must be where `/srv/content` was; the database alone shows the catalog with its files
missing.

After a checked copy the script tells ContentOps so (optional): when `~/.config/agency/contentops-backup-report.env`
exists with `CONTENTOPS_URL` and `CONTENTOPS_TOKEN` (a ContentOps staff agent's token), it posts the copy's time, size
and digest to `POST /api/v1/admin/backup-checkpoints`, and ContentOps' «Состояние» says «Копия базы: сегодня 05:45».
A failed report never fails the copy.

## What lives only on the Mac

`scripts/backup/push-mac-backups.sh` (Mac) pushes a daily snapshot to agency-de,
`/var/backups/agency-mac/<UTC>/`, with `openclaw-workspace-chat/` (Gengar), `openclaw-workspace/`
(Bobr) and `traffic-control/data/`. Unchanged files are hard links into the newest snapshot
(`rsync -a --link-dest`), so a day costs only what changed. The first snapshot is about 1 GB.

- traffic-control: `control.sqlite` goes through sqlite3's online backup into a temp dir first
  (never a raw copy of a live database), must pass `pragma quick_check`, and arrives with the same
  sha256; its own daily copies `data/backups/` go as they are.
- Left out of the workspaces (patterns in the script): `node_modules`, virtualenvs and interpreter
  caches (re-created from lockfiles); `.openclaw-cli-images/` (OpenClaw's image cache for the CLI,
  swept by its own TTL); `media/outbound/` (copies of files the agent sent); the root `tmp/` and
  `.tmp/` (the agents' scratch; Bobr's is 130 MB of throwaway scans); `reports/*/toolchain/`
  (downloaded tool binaries, 200 MB); git's `tmp_pack_*` leftovers; `.DS_Store`. Memory, skills,
  `MEMORY.md`/`AGENTS.md`/`SOUL.md`, `work/`, automations, received media, the workspace's git and
  the archive of old worktrees all stay.
- On agency-de it writes only under `/var/backups/agency-mac` (created mode 700) and refuses below
  20 GB free (`MAC_BACKUP_MIN_FREE_GB`). A snapshot gets its dated name only when the required
  files (both workspaces' `MEMORY.md`, `AGENTS.md`, Gengar's `SOUL.md`, `control.sqlite`) are in it.
  A failed run leaves its `.incoming-<UTC>/` there (nothing on the server is deleted by it); the
  JSON line counts them as `incompleteLeftovers`, with `newBytes` (today's cost), `snapshots`,
  `snapshotsBytes` and `freeGb`.
- Restoring: `rsync -a root@152.53.191.242:/var/backups/agency-mac/<UTC>/openclaw-workspace-chat/ <dir>/`
  (stop the OpenClaw gateway before writing into a live workspace); `control.sqlite` is copied back
  while traffic-control is not running. Not covered: OpenClaw's config, sessions and logs outside
  the two workspaces (`~/.openclaw/openclaw.json`, `agents/`, …), and anything else on the Mac.

```bash
bash scripts/backup/push-mac-backups.sh             # one snapshot now (one at a time)
```

## Install, update, remove

```bash
bash scripts/backup/install-backup-launchd.sh                        # all three agents
bash scripts/backup/install-backup-launchd.sh contentops mac-push    # only those
bash scripts/backup/install-backup-launchd.sh --uninstall [<job>...] # removes the agents and the copied scripts, keeps copies and logs
```

| Job | Agent | Moscow | Runs the copy in |
|---|---|---|---|
| `hub` | `ru.gosling-agency.hub-backup` | 05:20 | `~/Backups/agency-hub` (`pull-backup.sh`, `business-dump.sh`, `unfinished-inputs.sql`) |
| `contentops` | `ru.gosling-agency.contentops-backup` | 05:45 | `~/Backups/contentops` (`pull-contentops-backup.sh`) |
| `mac-push` | `ru.gosling-agency.mac-backup-push` | 06:05 | `~/Backups/agency-mac` (`push-mac-backups.sh`) |

Launchd runs the copies, so re-run the installer for a job after changing its scripts. It converts
the Moscow times into the Mac's local time at install. Logs: `<directory>/logs/<script>.log|.err`.
The drills are run by hand from the repo.
