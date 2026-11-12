#!/usr/bin/env bash
# Daily copy of the hub's business data onto this Mac, one dated directory per copy:
#   ~/Backups/agency-hub/<UTC>/hub-business.dump           pg_dump -Fc (business-dump.sh says what is in it)
#   ~/Backups/agency-hub/<UTC>/hub-unfinished-inputs.sql   the raw rows unfinished work still needs
#   ~/Backups/agency-hub/<UTC>/unfinished-inputs.sql       the selection that chose them
#   ~/Backups/agency-hub/<UTC>/manifest.json               bytes, tables, hub revision, duration, ...
# Launchd runs the copy of this file in ~/Backups/agency-hub (install-backup-launchd.sh); after a
# change here or in business-dump.sh or unfinished-inputs.sql, re-run the installer.
#   bash scripts/backup/pull-backup.sh
#
# Both files come from ONE snapshot: a psql session on production exports it and stays open while
# it copies the raw rows that unfinished-inputs.sql names, then pg_dump starts on the same snapshot
# and the session ends. Everything streams over ssh into .incoming-<UTC>/, and the directory gets
# its dated name only after the checks, so a dated directory is always a verified copy.
#
# Nothing is ever deleted here except this run's own .incoming-<UTC>/ when it fails: every copy
# stays until a person removes it. The JSON line it prints says how many there are and their size.
set -Eeuo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
host=${HUB_BACKUP_HOST:-root@152.53.191.242}
base=${HUB_BACKUP_DIR:-$HOME/Backups/agency-hub}
# A dump without business data is a few MB of schema; the real one is gigabytes.
min_bytes=${HUB_BACKUP_MIN_BYTES:-268435456}
pg_bin=${HUB_PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
ssh_opts=(-o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
psql_remote="docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' agency-hub-postgres-1 \
psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d agency_hub_core"
end_marker='-- end of unfinished-work inputs'

[[ -x $pg_bin/pg_restore ]] || { printf 'No pg_restore in %s (brew install postgresql@16)\n' "$pg_bin" >&2; exit 1; }
for f in business-dump.sh unfinished-inputs.sql; do
  [[ -f $here/$f ]] || { printf 'Missing %s next to %s\n' "$f" "$0" >&2; exit 1; }
done
mkdir -p "$base"
# Nothing here deletes an old copy (how many to keep is the owner's call), so this guard is what
# keeps a forgotten Mac from filling up: below the floor the run refuses and says so.
min_free_gb=${HUB_BACKUP_MIN_FREE_GB:-30}
free_kb=$(df -Pk "$base" | awk 'NR == 2 { print $4 }')
[[ ${free_kb:-0} -ge $((min_free_gb * 1024 * 1024)) ]] || {
  printf 'Only %s GB free under %s, need %s: not copying. Old copies are never deleted here.\n' \
    "$(( ${free_kb:-0} / 1024 / 1024 ))" "$base" "$min_free_gb" >&2
  exit 1
}
# One copy at a time: a second run while one streams would double the load on production.
lock="$base/.pull-backup.lock"
shlock -p $$ -f "$lock" || { printf 'Another pull-backup is running (%s)\n' "$lock" >&2; exit 1; }
holder="" dumper=""
cleanup() {
  [[ -z $holder ]] || kill "$holder" 2>/dev/null || true
  [[ -z $dumper ]] || kill "$dumper" 2>/dev/null || true
  [[ -z ${incoming:-} ]] || rm -rf "$incoming"
  rm -f "$lock"
}
trap cleanup EXIT
# The Mac does not fall asleep in the middle of a copy (caffeinate ends with this script).
caffeinate -i -w $$ &
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/$stamp"
incoming="$base/.incoming-$stamp"
mkdir "$incoming"
dump="$incoming/hub-business.dump"
inputs="$incoming/hub-unfinished-inputs.sql"

# What wrote the data: the API image's source revision (read as scripts/deploy.sh reads it) and the
# contract hash of /api/v1/health, which carries no git revision itself. Not critical.
revision=$(ssh "${ssh_opts[@]}" "$host" "id=\$(docker ps -q --filter label=com.docker.compose.service=api \
  --filter label=com.docker.compose.project.working_dir=/opt/agency-hub | head -1) && [ -n \"\$id\" ] && docker image inspect \
  -f '{{index .Config.Labels \"agency-hub.source-revision\"}}' \"\$(docker inspect -f '{{.Image}}' \"\$id\")\"" \
  2>/dev/null) || revision=""
contract=$(ssh "${ssh_opts[@]}" "$host" "curl -fsS -m 10 http://127.0.0.1:3000/api/v1/health" 2>/dev/null \
  | jq -r '.contractHash // empty' 2>/dev/null) || contract=""

# Waits until <file> holds a line matching <pattern>, while the holder session lives.
await() {
  local i
  for ((i = 0; i < $3 * 2; i++)); do
    grep -q -- "$2" "$1" 2>/dev/null && return 0
    kill -0 "$holder" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

started=$(date +%s)
# The snapshot holder: one psql session fed through a FIFO in .incoming (on this Mac, not the server).
mkfifo "$incoming/holder.in"
# shellcheck disable=SC2029 # the command is composed here on purpose
ssh "${ssh_opts[@]}" "$host" "$psql_remote" < "$incoming/holder.in" > "$incoming/holder.out" 2> "$incoming/holder.err" &
holder=$!
exec 3> "$incoming/holder.in"
printf '%s\n' "set statement_timeout = '120s';" "set idle_in_transaction_session_timeout = 0;" \
  "begin isolation level repeatable read read only;" "select pg_export_snapshot() || ' ' || now();" >&3
await "$incoming/holder.out" . 60 || { cat "$incoming/holder.err" >&2; printf 'No snapshot from production\n' >&2; exit 1; }
read -r snapshot as_of < "$incoming/holder.out"
as_of=${as_of:?}

# The raw rows unfinished work needs, as a psql script restore-drill.sh loads after pg_restore.
# Each COPY repeats the selection: it is small (seconds), and no temp table is possible read-only.
refs=$(cat "$here/unfinished-inputs.sql")
obs="select distinct observation_id as id, observation_received_at as received_at from refs where observation_id is not null"
raw="select distinct raw_payload_id as id from refs where raw_payload_id is not null"
cas="select o.payload_bucket_month as bucket_month, o.payload_object_id as object_id from observations o
  join ($obs) k using (id, received_at) where o.payload_object_id is not null
  union select p.payload_bucket_month, p.payload_object_id from sync_raw_payloads p
  join ($raw) k using (id) where p.payload_object_id is not null"
copy_block() { # <table> <select over the CTE refs>
  printf '\\echo %s\n' "'COPY public.$1 FROM stdin;'"
  printf 'copy (with refs as (\n%s\n) %s) to stdout;\n' "$refs" "$2"
  printf '\\echo %s\n' "'\\\\.'"
}
{
  printf '\\set as_of %s\n' "'$as_of'"
  printf '\\echo %s\n' "'-- hub unfinished-work inputs, as of $as_of'"
  printf '\\echo %s\n' "'-- expect <work> <state> <rows> <rows whose input is present on production>'"
  printf "select '-- expect' || chr(9) || work || chr(9) || coalesce(state, '-') || chr(9) || count(*)
  || chr(9) || count(*) filter (where present) from (\n%s\n) x group by work, state order by work, state;\n" "$refs"
  # Catalog rows before their bodies and locations, which reference them.
  copy_block capture_payload_objects "select c.* from capture_payload_objects c join ($cas) k using (bucket_month, object_id)"
  copy_block capture_payload_locations "select c.* from capture_payload_locations c join ($cas) k using (bucket_month, object_id)"
  copy_block capture_json_hot_bodies "select c.* from capture_json_hot_bodies c join ($cas) k using (bucket_month, object_id)"
  copy_block capture_byte_hot_bodies "select c.* from capture_byte_hot_bodies c join ($cas) k using (bucket_month, object_id)"
  copy_block observations "select o.* from observations o join ($obs) k using (id, received_at)"
  # Their dedup keys, so a frame captured again after a restore is not journaled twice.
  copy_block observation_keys "select ok.* from observation_keys ok join observations o
    on ok.source = o.source and ok.idempotency_key = o.idempotency_key and ok.observation_id = o.id
    join ($obs) k on k.id = o.id and k.received_at = o.received_at"
  copy_block sync_raw_payloads "select p.* from sync_raw_payloads p join ($raw) k using (id)"
  copy_block fansly_ws_decode_receipts "select d.* from fansly_ws_decode_receipts d
    where d.state in ('pending', 'debt') or d.live_state = 'pending'"
  printf '\\echo %s\n' "'$end_marker'"
} >&3
await "$incoming/holder.out" "^$end_marker\$" 600 \
  || { cat "$incoming/holder.err" >&2; printf 'Copying the unfinished-work inputs failed\n' >&2; exit 1; }

# The dump, on the same snapshot.
# shellcheck disable=SC2029 # the snapshot id is this side's value
ssh "${ssh_opts[@]}" "$host" "bash -s -- $snapshot" < "$here/business-dump.sh" > "$dump" &
dumper=$!
# pg_dump writes nothing before it has taken the snapshot; then the holder may end.
while [[ ! -s $dump ]] && kill -0 "$dumper" 2>/dev/null; do sleep 1; done
printf 'commit;\n' >&3
exec 3>&-
wait "$holder" || { cat "$incoming/holder.err" >&2; printf 'The snapshot session failed\n' >&2; exit 1; }
holder=""
wait "$dumper" || { printf 'pg_dump failed (exit %s), not kept\n' "$?" >&2; exit 1; }
dumper=""
duration=$(( $(date +%s) - started ))

tail -n +2 "$incoming/holder.out" > "$inputs"
rm "$incoming/holder.in" "$incoming/holder.out" "$incoming/holder.err"
[[ $(tail -n 1 "$inputs") == "$end_marker" ]] || { printf 'The unfinished-work inputs are cut short, not kept\n' >&2; exit 1; }
cp "$here/unfinished-inputs.sql" "$incoming/unfinished-inputs.sql"

size=$(wc -c < "$dump" | tr -d ' ')
[[ $size -ge $min_bytes ]] || { printf 'Backup looks empty (%s bytes), not kept\n' "$size" >&2; exit 1; }
"$pg_bin/pg_restore" --list "$dump" > "$incoming/toc.txt" \
  || { printf 'pg_restore --list cannot read the dump, not kept\n' >&2; exit 1; }
# TOC lines: "<id>; <catalog oid> <oid> <TYPE...> <schema> <name> <owner>".
tables=$(awk '$4 == "TABLE" && $5 != "DATA" && $5 != "ATTACH"' "$incoming/toc.txt" | wc -l | tr -d ' ')
with_data=$(awk '$4 == "TABLE" && $5 == "DATA"' "$incoming/toc.txt" | wc -l | tr -d ' ')
# The business tables must carry their data, whatever the size says.
for table in users pages fans transactions message_archive publications agent_keys config_settings; do
  awk -v t="$table" '$4 == "TABLE" && $5 == "DATA" && $6 == "public" && $7 == t { found = 1 } END { exit !found }' \
    "$incoming/toc.txt" || { printf 'The dump has no data for public.%s, not kept\n' "$table" >&2; exit 1; }
done
rm "$incoming/toc.txt"

# "-- expect<TAB>work<TAB>state<TAB>rows<TAB>inputs present" lines of the inputs file, as JSON.
unfinished=$( { grep "^-- expect"$'\t' "$inputs" || true; } | cut -f 2- \
  | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t")
      | {work: .[0], state: .[1], rows: (.[2] | tonumber), inputsPresent: (.[3] | tonumber)})')
jq -n --arg createdAt "$stamp" --arg host "$host" --arg snapshotAt "$as_of" --argjson bytes "$size" \
  --argjson tables "$tables" --argjson tablesWithData "$with_data" --arg revision "$revision" \
  --arg contract "$contract" --argjson durationSeconds "$duration" \
  --argjson inputsBytes "$(wc -c < "$inputs" | tr -d ' ')" --argjson unfinished "$unfinished" \
  '{createdAt: $createdAt, host: $host, snapshotAt: $snapshotAt, file: "hub-business.dump", bytes: $bytes,
    tables: $tables, tablesWithData: $tablesWithData,
    unfinishedInputs: {file: "hub-unfinished-inputs.sql", bytes: $inputsBytes, work: $unfinished},
    hubRevision: ($revision | select(. != "") // null), contractHash: ($contract | select(. != "") // null),
    durationSeconds: $durationSeconds}' > "$incoming/manifest.json"

# Only a checked copy gets a dated name: the drill reads dated ones only.
mv "$incoming" "$target"
incoming=""
copies=0 total=0
for dir in "$base"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z; do
  [[ -d $dir ]] || continue
  copies=$((copies + 1))
  total=$((total + $(find "$dir" -type f -exec stat -f %z {} + | awk '{ s += $1 } END { print s + 0 }')))
done
jq -c --arg path "$target" --argjson copies "$copies" --argjson copiesBytes "$total" \
  '{ok: true, path: $path, bytes, tables, tablesWithData, inputsBytes: .unfinishedInputs.bytes,
    unfinishedRows: ([.unfinishedInputs.work[].rows] | add // 0), hubRevision, durationSeconds,
    copies: $copies, copiesBytes: $copiesBytes}' "$target/manifest.json"
