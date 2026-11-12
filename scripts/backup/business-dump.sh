#!/usr/bin/env bash
# The hub's business data as one `pg_dump -Fc` stream on stdout. scripts/backup/pull-backup.sh runs
# it on agency-de over ssh (`ssh <host> 'bash -s' -- <snapshot> < business-dump.sh > hub-business.dump`),
# so the server needs no copy of this file and gets no file from it: the dump goes straight to stdout.
# <snapshot> (optional) is a pg_export_snapshot() id: the puller holds it open and copies the raw rows
# that unfinished work still needs (unfinished-inputs.sql) in the same snapshot, so the two files of
# one copy agree.
#
# EVERY table's schema is in the dump. Only the DATA of the raw capture and engine tables listed
# below is left out (about 67 of the 80 GB, sizes of 2026-11-12, indexes included). Everything a
# person or money depends on stays: people and access (users, auth_sessions, agent_keys), pages and
# fans, money (transactions, tips, payouts), the message archive, publications, shift reports,
# customs, config_settings. A table that is not listed here is copied with its data, so a
# new table is in the copy until someone adds it here on purpose.
#
# Locks: pg_dump reads one REPEATABLE READ, READ ONLY snapshot and holds ACCESS SHARE on every table
# until it ends. That blocks no read or write, only DDL (a migration, a new partition), which waits
# for the dump and makes every later query of that table wait behind it. Hence the run at 02:20 UTC
# (05:20 Moscow) must end before the partition job at 03:10 UTC and outside deploys, and
# --lock-wait-timeout makes the dump give up at start instead of queueing behind a DDL in progress.
set -euo pipefail

container=agency-hub-postgres-1
database=agency_hub_core

# Tables whose DATA is not copied (`--exclude-table-data-and-children`: the table and all its
# partitions). Exact names, not patterns, so a new table never drops out of the copy by its name.
excluded=(
  # Raw capture journal: every captured platform response (21.4 GB). Its facts are already in the
  # business tables; a restored copy simply starts the journal empty.
  public.observations
  # Dedup keys of that journal (1.2 GB): meaningless without the journal.
  public.observation_keys
  # Raw capture bodies, content-addressed (19.7 GB JSON; byte bodies empty today) ...
  public.capture_json_hot_bodies
  public.capture_byte_hot_bodies
  # ... and their identity catalog and locations (0.7 GB): pointers into the bodies above.
  public.capture_payload_objects
  public.capture_payload_locations
  # Raw responses of the sync engine (1.0 GB). One FK points here,
  # transaction_tip_contexts.(tip_message_)source_raw_payload_id: the tip and its message text are
  # columns of transaction_tip_contexts itself and stay, only these two lineage FKs cannot be
  # re-created on a restore (restore-drill.sh reports them as the expected errors).
  public.sync_raw_payloads
  # The canonical event stream derived from the journal (15.0 GB) and its dedup keys (5.8 GB). The
  # business state it feeds is materialized in the copied tables (fans, page_fans,
  # page_subscriptions, transactions, message_archive, ...). Lost on a restored copy until it is
  # captured again: the reads that go straight to the stream (new-subscriber list, link-fan period
  # starts, the agent journal, golden signals).
  public.domain_events
  public.domain_event_keys
  # Golden-signal latency samples (1.6 GB), ops data pruned after 14 days anyway.
  public.ops_metric_samples
  # Per-frame decode bookkeeping of the Fansly websocket capture (0.3 GB), keyed by observation id.
  # Its pending and debt rows are unfinished work: they go to the second file.
  public.fansly_ws_decode_receipts
  # pg-boss, the job queue (0.1 GB). A restored copy must not replay the backlog (sends, uploads);
  # the app re-creates its queues and schedules on start. pgboss.version is empty too: pg-boss of
  # the same version starts on it as is (it migrates only from a version it reads).
  'pgboss.*'
  # Detached domain_events months waiting for their drop (about 1 MB): event stream, as above.
  'tiered_pending_drop.*'
  # Superseded capture partitions parked before their drop (empty today): raw capture, as above.
  'capture_pending_drop.*'
)
# The raw rows that unfinished work still needs (a capture job's paid response awaiting its parse,
# a pending websocket frame, ...) are not lost with them: pull-backup.sh copies exactly those into
# the second file of the copy, hub-unfinished-inputs.sql.

args=()
[[ -z ${1:-} ]] || args+=("--snapshot=$1")
for table in "${excluded[@]}"; do args+=("--exclude-table-data-and-children=$table"); done

# No -t and no -i: stdout stays binary-clean and nothing reads this script's stdin (bash -s does).
exec docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$container" \
  nice -n 19 pg_dump -U postgres -d "$database" --format=custom --lock-wait-timeout=30s "${args[@]}"
