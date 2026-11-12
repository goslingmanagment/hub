#!/usr/bin/env bash
# Restore drill on the Mac: the newest copy in ~/Backups/agency-hub (or the dump given) goes into a
# throwaway PostgreSQL 16 cluster in a temp dir (homebrew binaries, a free localhost port), then its
# hub-unfinished-inputs.sql is loaded on top. It prints the row counts of ten business tables next to
# the same counts read from production now (read-only), and the unfinished work by state with how
# many of its raw inputs are present after the restore (production's numbers come from the copy
# itself, taken in the dump's snapshot: all of them must be there). The cluster and its directory
# are removed at the end, whatever happens. The copy is only read. No app runs on the restored data,
# so nothing on it can send anything.
#   bash scripts/backup/restore-drill.sh [path/to/hub-business.dump]
# Production keeps writing after the dump, so a busy table shows production ahead by the rows of the
# hours since the copy was taken (and expired sessions make it behind); an empty restored table, or one
# far from production, is the failure to look for.
set -Eeuo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
host=${HUB_BACKUP_HOST:-root@152.53.191.242}
base=${HUB_BACKUP_DIR:-$HOME/Backups/agency-hub}
pg_bin=${HUB_PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}
src=${1:-}
# Dated names sort by time, and a glob expands sorted: the last one is the newest.
if [[ -z $src ]]; then for f in "$base"/[0-9]*Z/hub-business.dump; do [[ -f $f ]] && src=$f; done; fi
[[ -n $src && -f $src ]] || { printf 'No copy found in %s\n' "$base" >&2; exit 1; }
[[ -x $pg_bin/pg_restore ]] || { printf 'No PostgreSQL 16 in %s (brew install postgresql@16)\n' "$pg_bin" >&2; exit 1; }
copy_dir=$(dirname "$src")
inputs="$copy_dir/hub-unfinished-inputs.sql"
[[ -f $inputs ]] || { printf 'No %s next to the dump\n' "$inputs" >&2; exit 1; }
# The selection the copy was taken with; the repo's when the copy carries none.
selection="$copy_dir/unfinished-inputs.sql"
[[ -f $selection ]] || selection="$here/unfinished-inputs.sql"
as_of=$(sed -n 's/^-- hub unfinished-work inputs, as of //p' "$inputs" | head -n1)
[[ -n $as_of ]] || { printf '%s has no snapshot time\n' "$inputs" >&2; exit 1; }

tables=(users pages fans transactions message_archive publications agent_keys config_settings
  chatter_activity_minutes auth_sessions)
count_sql=""
for table in "${tables[@]}"; do
  count_sql+="${count_sql:+ union all }select '$table', count(*) from public.$table"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/hub-restore-drill.XXXXXX")
data="$work/data"
cleanup() {
  [[ -f $data/postmaster.pid ]] && "$pg_bin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

port=""
for ((i = 0; i < 50; i++)); do
  candidate=$((20000 + RANDOM % 20000))
  nc -z 127.0.0.1 "$candidate" 2>/dev/null || { port=$candidate; break; }
done
[[ -n $port ]] || { printf 'No free port found\n' >&2; exit 1; }

# The postmaster on macOS refuses to start without a valid locale in its environment.
LC_ALL=en_US.UTF-8 "$pg_bin/initdb" -D "$data" -U postgres -A trust -E UTF8 --locale=en_US.UTF-8 >"$work/initdb.log" 2>&1 \
  || { cat "$work/initdb.log" >&2; exit 1; }
# A disposable cluster: durability off, room for big index builds.
# TCP on 127.0.0.1 only, no unix socket.
LC_ALL=en_US.UTF-8 "$pg_bin/pg_ctl" -D "$data" -l "$work/server.log" -w -o "-p $port -c listen_addresses=127.0.0.1 -c unix_socket_directories='' \
  -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c autovacuum=off -c wal_level=minimal \
  -c max_wal_senders=0 -c max_wal_size=16GB -c shared_buffers=1GB -c maintenance_work_mem=1GB \
  -c max_parallel_maintenance_workers=4" start >/dev/null \
  || { cat "$work/server.log" >&2; exit 1; }
psql_local=("$pg_bin/psql" -X -q -h 127.0.0.1 -p "$port" -U postgres)
"${psql_local[@]}" -d postgres -c 'create database agency_hub_core'

started=$(date +%s)
jobs=$(( $(sysctl -n hw.ncpu) / 2 )); (( jobs >= 2 )) || jobs=2; (( jobs <= 8 )) || jobs=8
# Owners and grants are production's roles, which this cluster does not have: restored as postgres.
"$pg_bin/pg_restore" -h 127.0.0.1 -p "$port" -U postgres -d agency_hub_core --no-owner --no-privileges \
  --jobs="$jobs" "$src" 2>"$work/restore.err" || true
restore_seconds=$(( $(date +%s) - started ))
# The raw rows unfinished work needs, into the tables whose data the dump leaves out.
"${psql_local[@]}" -d agency_hub_core -v ON_ERROR_STOP=1 -f "$inputs" >"$work/inputs.log" 2>&1 \
  || { tail -n 20 "$work/inputs.log" >&2; printf 'Loading %s failed\n' "$inputs" >&2; exit 1; }

# The one expected kind of error: a foreign key from a copied table into a table whose data is not
# in the copy (business-dump.sh names them). Anything else fails the drill.
errors=$(grep -c 'ERROR:' "$work/restore.err" || true)
unexpected=$(grep 'ERROR:' "$work/restore.err" | grep -vc 'violates foreign key constraint' || true)

restored=$("${psql_local[@]}" -d agency_hub_core -At -F ' ' -c "$count_sql") \
  || { printf 'Counting on the restored copy failed\n' >&2; tail -n 20 "$work/restore.err" >&2; exit 1; }
production=$(ssh -o BatchMode=yes "$host" "docker exec -e PGOPTIONS='-c default_transaction_read_only=on \
  -c statement_timeout=30s' agency-hub-postgres-1 psql -X -U postgres -d agency_hub_core -At -F ' ' \
  -c \"$count_sql\"") || production=""

unfinished=$({ printf "select work, coalesce(state, '-'), count(*), count(*) filter (where present) from (\n"
  cat "$selection"; printf '\n) x group by 1, 2 order by 1, 2;\n'; } \
  | "${psql_local[@]}" -d agency_hub_core -v ON_ERROR_STOP=1 -v as_of="$as_of" -At -F $'\t') \
  || { printf 'Reading the unfinished work on the restored copy failed\n' >&2; exit 1; }

# The snapshot time from the copy itself (pg_restore's "Archive created at" names the Mac's zone
# for the server's clock).
printf 'copy:      %s (%s bytes, snapshot %s)\n' "$src" "$(wc -c < "$src" | tr -d ' ')" "$as_of"
printf 'restore:   %ss into PostgreSQL %s, port %s; %s errors, %s unexpected\n' "$restore_seconds" \
  "$("$pg_bin/postgres" --version | awk '{print $3}')" "$port" "$errors" "$unexpected"
{ grep 'ERROR:' "$work/restore.err" || true; } | sed 's/^.*ERROR: *//' | sort | uniq -c | head -n 20
printf '%-26s %14s %14s %10s\n' table restored production prod-copy
short=0
for table in "${tables[@]}"; do
  r=$(awk -v t="$table" '$1 == t { print $2 }' <<<"$restored")
  p=$(awk -v t="$table" '$1 == t { print $2 }' <<<"$production")
  [[ -n $r && $r -gt 0 ]] || short=1
  printf '%-26s %14s %14s %10s\n' "$table" "${r:-?}" "${p:-?}" "$([[ -n $r && -n $p ]] && echo $((p - r)) || echo '?')"
done
[[ -n $production ]] || printf 'production counts unavailable (ssh failed)\n'

# Unfinished work: production's side is the copy's own "-- expect" lines (same snapshot as the dump).
printf '\nunfinished work as of %s\n' "$as_of"
printf '%-30s %-24s %10s %10s %10s %10s\n' work state 'prod rows' 'prod input' 'rows' 'input'
missing=0
expected=$({ grep "^-- expect"$'\t' "$inputs" || true; } | cut -f 2-)
while IFS=$'\t' read -r w st rows present; do
  [[ -n $w ]] || continue
  got=$(awk -F '\t' -v w="$w" -v s="$st" '$1 == w && $2 == s { print $3 "\t" $4 }' <<<"$unfinished")
  got_rows=${got%%$'\t'*}; got_present=${got##*$'\t'}
  [[ -n $got ]] || { got_rows=0; got_present=0; }
  (( got_rows >= rows && got_present >= present )) || missing=1
  printf '%-30s %-24s %10s %10s %10s %10s\n' "$w" "$st" "$rows" "$present" "$got_rows" "$got_present"
done <<<"$expected"
[[ -n $expected ]] || printf '(none)\n'
(( unexpected == 0 && short == 0 && missing == 0 )) || { printf 'DRILL FAILED: see the errors and counts above\n' >&2; exit 1; }
printf 'drill ok\n'
