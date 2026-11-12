#!/usr/bin/env bash
# Daily copy of the ContentOps database onto this Mac, one dated directory per copy:
#   ~/Backups/contentops/<UTC>/contentops.dump   pg_dump -Fc of the whole `contentops` database
#   ~/Backups/contentops/<UTC>/manifest.json     bytes, sha256, tables, row counts of the main tables
#                                                in the dump's snapshot, ContentOps version, duration
# ContentOps runs in a VM on the owner's PC (`ssh contentops-vm`: compose project /opt/contentops,
# Postgres 18 in its `db` service). Its media (the blobs, 275 GB) are not part of this copy: that
# needs bought space. Launchd runs the copy of this file in ~/Backups/contentops
# (install-backup-launchd.sh); after a change here, re-run the installer.
#   bash scripts/backup/pull-contentops-backup.sh
#
# Nothing is written on the VM. One read-only psql session there exports a snapshot and counts the
# main tables in it; pg_dump starts on that snapshot (read-only, under nice, --lock-wait-timeout)
# and streams over ssh into .incoming-<UTC>/ here, then the session ends, so the counts and the dump
# describe the same instant (restore-drill-contentops.sh compares them). The directory gets its dated
# name only after the checks: not empty, the VM's own pg_restore reads its table of contents (this
# Mac has no PostgreSQL 18, and a PostgreSQL 16 pg_restore cannot read a 18 archive), every main
# table has its data in it and the core ones are not empty.
#
# Nothing is ever deleted here except this run's own .incoming-<UTC>/ when it fails: every copy
# stays until a person removes it. The JSON line it prints says how many there are and their size.
set -Eeuo pipefail
umask 077
host=${CONTENTOPS_BACKUP_HOST:-contentops-vm}
base=${CONTENTOPS_BACKUP_DIR:-$HOME/Backups/contentops}
project_dir=/opt/contentops
database=contentops
# A dump with the schema only is well under 1 MB; the real one is hundreds of MB.
min_bytes=${CONTENTOPS_BACKUP_MIN_BYTES:-67108864}
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
end_marker='-- end of counts'

# The main tables: each must have its data in the dump, and its row count in the snapshot goes into
# the manifest. The core ones (models, pages, people, the catalog, the bytes, orders, migrations)
# must not be empty; the others may legitimately be.
core_tables=(models accounts principals content_items assets asset_versions item_memberships blobs
  aliases placements custom_orders custom_order_deliveries schema_migrations action_log)
other_tables=(surfaces principal_grants api_tokens policy_settings sources source_objects inbox_groups
  review_cases posting_plan_rows custom_order_messages hub_posts)

mkdir -p "$base"
# Nothing here deletes an old copy (how many to keep is the owner's call), so this guard is what
# keeps a forgotten Mac from filling up: below the floor the run refuses and says so.
min_free_gb=${CONTENTOPS_BACKUP_MIN_FREE_GB:-30}
free_kb=$(df -Pk "$base" | awk 'NR == 2 { print $4 }')
[[ ${free_kb:-0} -ge $((min_free_gb * 1024 * 1024)) ]] || {
  printf 'Only %s GB free under %s, need %s: not copying. Old copies are never deleted here.\n' \
    "$(( ${free_kb:-0} / 1024 / 1024 ))" "$base" "$min_free_gb" >&2
  exit 1
}
# One copy at a time: a second run while one streams would double the load on the busy VM.
lock="$base/.pull-contentops-backup.lock"
shlock -p $$ -f "$lock" || { printf 'Another pull-contentops-backup is running (%s)\n' "$lock" >&2; exit 1; }
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
dump="$incoming/contentops.dump"

# The Postgres container of the compose project (read-only docker query), and what is deployed: the
# tag checked out in /opt/contentops (ops/README.md: it is installed from a tag).
# shellcheck disable=SC2029 # composed here on purpose
container=$(ssh "${ssh_opts[@]}" "$host" "docker ps --format '{{.Names}}' \
  --filter label=com.docker.compose.project.working_dir=$project_dir --filter label=com.docker.compose.service=db" \
  < /dev/null | head -n 1)
[[ $container =~ ^[A-Za-z0-9_.-]+$ ]] || { printf 'No running db container of %s on %s\n' "$project_dir" "$host" >&2; exit 1; }
# shellcheck disable=SC2029
version=$(ssh "${ssh_opts[@]}" "$host" "git -C $project_dir describe --tags --always" < /dev/null 2>/dev/null) || version=""
psql_remote="docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $container \
psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d $database"

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
# The snapshot holder: one psql session fed through a FIFO in .incoming (on this Mac, not the VM).
mkfifo "$incoming/holder.in"
# shellcheck disable=SC2029 # the command is composed here on purpose
ssh "${ssh_opts[@]}" "$host" "$psql_remote" < "$incoming/holder.in" > "$incoming/holder.out" 2> "$incoming/holder.err" &
holder=$!
exec 3> "$incoming/holder.in"
printf '%s\n' "set statement_timeout = '600s';" "set idle_in_transaction_session_timeout = 0;" \
  "begin isolation level repeatable read read only;" "select pg_export_snapshot() || ' ' || now();" >&3
await "$incoming/holder.out" . 60 || { cat "$incoming/holder.err" >&2; printf 'No snapshot from the VM\n' >&2; exit 1; }
read -r snapshot as_of < "$incoming/holder.out"
as_of=${as_of:?}
[[ $snapshot =~ ^[0-9A-F-]+$ ]] || { printf 'Unexpected snapshot id from the VM: %s\n' "$snapshot" >&2; exit 1; }
# Row counts in the snapshot, as "-- rows<TAB>table<TAB>n" lines; then the server and schema versions.
{
  for table in "${core_tables[@]}" "${other_tables[@]}"; do
    printf "select '-- rows' || chr(9) || '%s' || chr(9) || count(*) from public.%s;\n" "$table" "$table"
  done
  printf "select '-- server' || chr(9) || split_part(current_setting('server_version'), ' ', 1);\n"
  printf "select '-- schema' || chr(9) || version || chr(9) || name from public.schema_migrations order by version desc limit 1;\n"
  printf '\\echo %s\n' "'$end_marker'"
} >&3
await "$incoming/holder.out" "^$end_marker\$" 600 \
  || { cat "$incoming/holder.err" >&2; printf 'Counting the main tables failed\n' >&2; exit 1; }

# The dump, on the same snapshot. Only pg_dump's client runs under nice; the VM transcodes all day.
# shellcheck disable=SC2029 # the snapshot id is this side's value
ssh "${ssh_opts[@]}" "$host" "docker exec -e PGOPTIONS='-c default_transaction_read_only=on' $container \
  nice -n 19 pg_dump -U postgres -d $database --format=custom --lock-wait-timeout=30s --snapshot=$snapshot" \
  < /dev/null > "$dump" &
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

counts="$incoming/holder.out"
server_version=$(awk -F '\t' '$1 == "-- server" { print $2 }' "$counts")
schema_version=$(awk -F '\t' '$1 == "-- schema" { print $2 " " $3 }' "$counts")
rows=$(awk -F '\t' '$1 == "-- rows" { print $2 "\t" $3 }' "$counts" \
  | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {(.[0]): (.[1] | tonumber)}) | add')

size=$(wc -c < "$dump" | tr -d ' ')
[[ $size -ge $min_bytes ]] || { printf 'Backup looks empty (%s bytes), not kept\n' "$size" >&2; exit 1; }
# The table of contents, read by the VM's own pg_restore from this copy's bytes fed over ssh: it
# reads only the header and the TOC (a few MB), nothing is written on the VM.
# shellcheck disable=SC2029
ssh "${ssh_opts[@]}" "$host" "docker exec -i $container pg_restore --list" < "$dump" > "$incoming/toc.txt" \
  || { printf 'pg_restore --list cannot read the dump, not kept\n' >&2; exit 1; }
# TOC lines: "<id>; <catalog oid> <oid> <TYPE...> <schema> <name> <owner>".
tables=$(awk '$4 == "TABLE" && $5 != "DATA" && $5 != "ATTACH"' "$incoming/toc.txt" | wc -l | tr -d ' ')
with_data=$(awk '$4 == "TABLE" && $5 == "DATA"' "$incoming/toc.txt" | wc -l | tr -d ' ')
for table in "${core_tables[@]}" "${other_tables[@]}"; do
  awk -v t="$table" '$4 == "TABLE" && $5 == "DATA" && $6 == "public" && $7 == t { found = 1 } END { exit !found }' \
    "$incoming/toc.txt" || { printf 'The dump has no data for public.%s, not kept\n' "$table" >&2; exit 1; }
done
for table in "${core_tables[@]}"; do
  n=$(jq -r --arg t "$table" '.[$t] // 0' <<<"$rows")
  [[ $n -gt 0 ]] || { printf 'public.%s is empty in the snapshot, not kept\n' "$table" >&2; exit 1; }
done
rm "$incoming/toc.txt" "$incoming/holder.in" "$incoming/holder.out" "$incoming/holder.err"
sha=$(shasum -a 256 "$dump" | awk '{ print $1 }')

jq -n --arg createdAt "$stamp" --arg host "$host" --arg container "$container" --arg snapshotAt "$as_of" \
  --argjson bytes "$size" --arg sha256 "$sha" --argjson tables "$tables" --argjson tablesWithData "$with_data" \
  --argjson rows "$rows" --arg version "$version" --arg schema "$schema_version" --arg pg "$server_version" \
  --argjson durationSeconds "$duration" \
  '{createdAt: $createdAt, host: $host, container: $container, snapshotAt: $snapshotAt,
    file: "contentops.dump", bytes: $bytes, sha256: $sha256, tables: $tables, tablesWithData: $tablesWithData,
    rows: $rows, contentopsVersion: ($version | select(. != "") // null),
    schemaVersion: ($schema | select(. != "") // null), postgresVersion: $pg,
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
  '{ok: true, path: $path, bytes, tables, tablesWithData, actionLogRows: .rows.action_log,
    contentItems: .rows.content_items, contentopsVersion, postgresVersion, durationSeconds,
    copies: $copies, copiesBytes: $copiesBytes}' "$target/manifest.json"
