#!/usr/bin/env bash
# Restore drill of the ContentOps copy on the Mac: the newest copy in ~/Backups/contentops (or the
# dump given) goes into a throwaway PostgreSQL cluster of the VM's version, then the drill prints the
# row counts of the main tables restored, as the copy's manifest has them (counted in the dump's own
# snapshot: they must match exactly) and on the VM now (read-only). The copy is only read.
#   bash scripts/backup/restore-drill-contentops.sh [path/to/contentops.dump]
#
# The VM runs PostgreSQL 18 and this Mac's Homebrew has 14-16 only; a PostgreSQL 16 pg_restore cannot
# read an 18 archive. So the cluster is a container of the Docker image the VM runs
# (postgres:<postgresVersion from the manifest>, CONTENTOPS_DRILL_IMAGE to override), which must
# already be on this Mac: the drill pulls nothing and says so when Docker or the image is missing.
# The container has no network, mounts the copy's directory read-only, and is removed at the end
# with its data, whatever happens. No app runs on the restored data, so nothing on it can send.
# The VM keeps writing after the dump, so the VM is ahead on busy tables (action_log, hub_posts);
# a restored count different from the manifest's, or any restore error, fails the drill.
set -Eeuo pipefail
umask 077
host=${CONTENTOPS_BACKUP_HOST:-contentops-vm}
base=${CONTENTOPS_BACKUP_DIR:-$HOME/Backups/contentops}
database=contentops
src=${1:-}
# Dated names sort by time, and a glob expands sorted: the last one is the newest.
if [[ -z $src ]]; then for f in "$base"/[0-9]*Z/contentops.dump; do [[ -f $f ]] && src=$f; done; fi
[[ -n $src && -f $src ]] || { printf 'No copy found in %s\n' "$base" >&2; exit 1; }
copy_dir=$(cd "$(dirname "$src")" && pwd)
manifest="$copy_dir/manifest.json"
[[ -f $manifest ]] || { printf 'No %s next to the dump\n' "$manifest" >&2; exit 1; }
pg_version=$(jq -r '.postgresVersion // empty' "$manifest")
[[ -n $pg_version ]] || { printf '%s names no postgresVersion\n' "$manifest" >&2; exit 1; }
image=${CONTENTOPS_DRILL_IMAGE:-postgres:$pg_version}
need="The drill restores into the Docker image $image, the VM's PostgreSQL $pg_version (a 16 cannot read its dump)"
docker info >/dev/null 2>&1 || { printf '%s, and Docker is not running: start Docker Desktop and run the drill again.\n' "$need" >&2; exit 1; }
docker image inspect "$image" >/dev/null 2>&1 \
  || { printf '%s, and that image is not on this Mac. The drill pulls nothing: docker pull %s first.\n' "$need" "$image" >&2; exit 1; }

tables=()
while IFS= read -r t; do tables+=("$t"); done < <(jq -r '.rows | keys_unsorted[]' "$manifest")
[[ ${#tables[@]} -gt 0 ]] || { printf '%s has no row counts\n' "$manifest" >&2; exit 1; }
count_sql=""
for table in "${tables[@]}"; do
  [[ $table =~ ^[a-z_][a-z0-9_]*$ ]] || { printf 'Unexpected table name in the manifest: %s\n' "$table" >&2; exit 1; }
  count_sql+="${count_sql:+ union all }select '$table', count(*) from public.$table"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/contentops-restore-drill.XXXXXX")
name="contentops-restore-drill-$$"
started_container=""
cleanup() {
  [[ -z $started_container ]] || docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# A disposable cluster: durability off, room for index builds; no network, the copy read-only.
docker run -d --rm --pull never --name "$name" --network none --shm-size 1g \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB="$database" -v "$copy_dir:/copy:ro" "$image" \
  postgres -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c autovacuum=off \
  -c wal_level=minimal -c max_wal_senders=0 -c max_wal_size=8GB -c shared_buffers=512MB \
  -c maintenance_work_mem=512MB -c max_parallel_maintenance_workers=2 >/dev/null
started_container=1
# The image's first start runs initdb with a socket-only server, then restarts: ready on TCP means done.
ready=""
for ((i = 0; i < 120; i++)); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d "$database" 2>/dev/null && { ready=1; break; }
  sleep 1
done
[[ -n $ready ]] || { docker logs "$name" 2>&1 | tail -n 20 >&2; printf 'The drill cluster did not start\n' >&2; exit 1; }
psql_local=(docker exec -i "$name" psql -X -q -h 127.0.0.1 -U postgres -d "$database")

started=$(date +%s)
jobs=$(( $(sysctl -n hw.ncpu) / 2 )); (( jobs >= 2 )) || jobs=2; (( jobs <= 4 )) || jobs=4
# Owners and grants are the VM's roles, which this cluster does not have: restored as postgres.
docker exec "$name" pg_restore -h 127.0.0.1 -U postgres -d "$database" --no-owner --no-privileges \
  --jobs="$jobs" "/copy/$(basename "$src")" 2>"$work/restore.err" || true
restore_seconds=$(( $(date +%s) - started ))
errors=$(grep -c 'error:' "$work/restore.err" || true)

restored=$("${psql_local[@]}" -At -F ' ' -c "$count_sql") \
  || { printf 'Counting on the restored copy failed\n' >&2; tail -n 20 "$work/restore.err" >&2; exit 1; }
container=$(jq -r '.container // "contentops-db-1"' "$manifest")
# shellcheck disable=SC2029 # composed here on purpose
vm=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$host" "docker exec -e PGOPTIONS='-c default_transaction_read_only=on \
  -c statement_timeout=60s' $container psql -X -U postgres -d $database -At -F ' ' -c \"$count_sql\"" < /dev/null) || vm=""

printf 'copy:      %s (%s bytes, snapshot %s, ContentOps %s)\n' "$src" "$(wc -c < "$src" | tr -d ' ')" \
  "$(jq -r .snapshotAt "$manifest")" "$(jq -r '.contentopsVersion // "?"' "$manifest")"
printf 'restore:   %ss into PostgreSQL %s (image %s), %s jobs; %s errors\n' "$restore_seconds" \
  "$(docker exec "$name" postgres --version | awk '{ print $3 }')" "$image" "$jobs" "$errors"
{ grep 'error:' "$work/restore.err" || true; } | sed 's/^.*error: *//' | sort | uniq -c | head -n 20
printf '%-26s %12s %12s %12s %10s\n' table restored 'in copy' 'vm now' 'vm-copy'
mismatch=0
for table in "${tables[@]}"; do
  r=$(awk -v t="$table" '$1 == t { print $2 }' <<<"$restored")
  m=$(jq -r --arg t "$table" '.rows[$t]' "$manifest")
  v=$(awk -v t="$table" '$1 == t { print $2 }' <<<"$vm")
  [[ -n $r && $r == "$m" ]] || mismatch=1
  printf '%-26s %12s %12s %12s %10s\n' "$table" "${r:-?}" "$m" "${v:-?}" "$([[ -n $v ]] && echo $((v - m)) || echo '?')"
done
[[ -n $vm ]] || printf 'VM counts unavailable (ssh failed)\n'
(( errors == 0 && mismatch == 0 )) || { printf 'DRILL FAILED: see the errors and counts above\n' >&2; exit 1; }
printf 'drill ok\n'
