#!/usr/bin/env bash
# Daily snapshot of what lives only on this Mac, pushed to agency-de, one dated directory per day:
#   /var/backups/agency-mac/<UTC>/openclaw-workspace-chat/   Gengar's workspace (~/.openclaw/workspace-chat)
#   /var/backups/agency-mac/<UTC>/openclaw-workspace/        Bobr's workspace (~/.openclaw/workspace)
#   /var/backups/agency-mac/<UTC>/traffic-control/data/      control.sqlite and its own daily backups/
# Every snapshot is a full tree, but a file unchanged since the newest snapshot is a hard link to it
# (rsync --link-dest), so a day costs only what changed. Launchd runs the copy of this file in
# ~/Backups/agency-mac (install-backup-launchd.sh); after a change here, re-run the installer.
#   bash scripts/backup/push-mac-backups.sh
#
# The workspaces go without what is regenerable or not the agents' work (the list and the reasons:
# `excludes` below). control.sqlite is never copied raw while it may be written: sqlite3's online
# backup takes a consistent copy into a temp dir here first, and that copy must pass quick_check.
#
# On the server this writes only under /var/backups/agency-mac (created mode 700 on the first run)
# and refuses when less than 20 GB is free there (MAC_BACKUP_MIN_FREE_GB). Nothing is ever deleted
# there: a run that fails leaves its .incoming-<UTC>/ (files in it are mostly hard links, so it costs
# little); the JSON line counts them, and removing them, like any snapshot, is a person's call. The
# newest snapshot is found by name; there is no "latest" link to replace.
set -Eeuo pipefail
umask 077
host=${MAC_BACKUP_HOST:-root@152.53.191.242}
remote=${MAC_BACKUP_REMOTE_DIR:-/var/backups/agency-mac}
state=${MAC_BACKUP_DIR:-$HOME/Backups/agency-mac}
openclaw=${OPENCLAW_DIR:-$HOME/.openclaw}
traffic=${TRAFFIC_CONTROL_DIR:-$HOME/code/3-traffic/traffic-control}
min_free_gb=${MAC_BACKUP_MIN_FREE_GB:-20}
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)

# Left out of the workspaces (rsync patterns; a leading / anchors at the workspace root):
excludes=(
  # Dependency trees and interpreters' caches: re-created by an install from the lockfile.
  --exclude=node_modules/ --exclude=.venv/ --exclude=venv/ --exclude=__pycache__/
  --exclude=.pytest_cache/ --exclude=.mypy_cache/ --exclude=.ruff_cache/ --exclude=.cache/
  # OpenClaw's cache of images handed to the CLI (content-addressed, swept by its own TTL): copies
  # of media that is in media/inbound or in the chat itself.
  --exclude=/.openclaw-cli-images/
  # Copies of files the agent has sent (the originals are where it made them).
  --exclude=/media/outbound/
  # The agents' scratch by their own naming (Bobr's tmp/ is 130 MB of throwaway scans).
  --exclude=/tmp/ --exclude=/.tmp/
  # Downloaded third-party tool binaries kept beside one report (trufflehog, pnpm: 200 MB),
  # re-downloadable; the report and its source tree stay.
  --exclude=/reports/*/toolchain/
  # Leftovers of an interrupted git fetch, and Finder's metadata.
  --exclude=tmp_pack_* --exclude=.DS_Store
)
# What must be in a snapshot, or it is not one.
required=(openclaw-workspace-chat/MEMORY.md openclaw-workspace-chat/AGENTS.md openclaw-workspace-chat/SOUL.md
  openclaw-workspace/MEMORY.md openclaw-workspace/AGENTS.md traffic-control/data/control.sqlite)

for dir in "$openclaw/workspace-chat" "$openclaw/workspace" "$traffic/data/backups"; do
  [[ -d $dir ]] || { printf 'Missing %s\n' "$dir" >&2; exit 1; }
done
[[ -f $traffic/data/control.sqlite ]] || { printf 'Missing %s\n' "$traffic/data/control.sqlite" >&2; exit 1; }
[[ $remote =~ ^/[A-Za-z0-9/_.-]+$ ]] || { printf 'Unexpected remote directory %s\n' "$remote" >&2; exit 1; }
mkdir -p "$state"
# One push at a time.
lock="$state/.push-mac-backups.lock"
shlock -p $$ -f "$lock" || { printf 'Another push-mac-backups is running (%s)\n' "$lock" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/push-mac-backups.XXXXXX")
cleanup() {
  rm -rf "$work"
  rm -f "$lock"
}
trap cleanup EXIT
caffeinate -i -w $$ &
stamp=$(date -u +%Y%m%dT%H%M%SZ)
started=$(date +%s)

# traffic-control's database through sqlite's online backup (consistent even while it is written).
mkdir -p "$work/traffic-control/data"
db_copy="$work/traffic-control/data/control.sqlite"
sqlite3 "$traffic/data/control.sqlite" ".timeout 60000" ".backup '$db_copy'"
[[ $(sqlite3 "$db_copy" 'pragma quick_check') == ok ]] || { printf 'The copy of control.sqlite fails quick_check\n' >&2; exit 1; }
db_sha=$(shasum -a 256 "$db_copy" | awk '{ print $1 }')

# Server side, step 1: the directory, the free-space floor, the newest snapshot, this run's .incoming.
# shellcheck disable=SC2016 # expanded on the server
prepare='set -eu
umask 077
dir=$1 stamp=$2 floor_gb=$3
[ -e "$dir" ] || mkdir -m 700 "$dir"
[ -d "$dir" ] && [ ! -L "$dir" ] || { echo "$dir is not a directory" >&2; exit 1; }
free_kb=$(df -Pk "$dir" | awk "NR == 2 { print \$4 }")
[ "$free_kb" -ge $((floor_gb * 1024 * 1024)) ] || {
  echo "Only $((free_kb / 1024 / 1024)) GB free under $dir on $(hostname), need $floor_gb: not copying. Old snapshots are never deleted here." >&2
  exit 1
}
newest=$(ls -1d "$dir"/[0-9]*Z 2>/dev/null | tail -n 1)
mkdir "$dir/.incoming-$stamp"
echo "${newest##*/}"'
# shellcheck disable=SC2029 # the arguments are this side's values
newest=$(ssh "${ssh_opts[@]}" "$host" "bash -s -- $remote $stamp $min_free_gb" <<<"$prepare")
incoming="$remote/.incoming-$stamp"

vanished=0
# push <source dir> <destination under the snapshot> [rsync options...]
push() {
  local src=$1 dest=$2 rc=0
  shift 2
  local link=()
  [[ -z $newest ]] || link=(--link-dest="$remote/$newest/$dest/")
  rsync -a --numeric-ids -e "ssh ${ssh_opts[*]}" ${link[@]+"${link[@]}"} "$@" "$src/" "$host:$incoming/$dest/" || rc=$?
  # 24: a file vanished between the listing and its transfer (the agents keep writing): the rest is copied.
  [[ $rc -eq 24 ]] && { vanished=1; rc=0; }
  [[ $rc -eq 0 ]] || { printf 'rsync of %s failed (exit %s); %s:%s is left as it is\n' "$src" "$rc" "$host" "$incoming" >&2; exit 1; }
}
push "$openclaw/workspace-chat" openclaw-workspace-chat "${excludes[@]}"
push "$openclaw/workspace" openclaw-workspace "${excludes[@]}"
push "$work/traffic-control" traffic-control
push "$traffic/data/backups" traffic-control/data/backups

# Server side, step 2: the snapshot is complete and the database arrived intact, then its dated name,
# then what it cost: du counts a hard-linked file once, so the second number is what is new today.
# shellcheck disable=SC2016 # expanded on the server
finish='set -eu
dir=$1 stamp=$2 newest=$3 sha=$4; shift 4
cd "$dir/.incoming-$stamp"
for f in "$@"; do [ -s "$f" ] || { echo "$f is missing in the snapshot, it stays in .incoming-$stamp" >&2; exit 1; }; done
[ "$(sha256sum traffic-control/data/control.sqlite | cut -d " " -f 1)" = "$sha" ] \
  || { echo "control.sqlite differs from the copy sent, it stays in .incoming-$stamp" >&2; exit 1; }
cd "$dir"
mv ".incoming-$stamp" "$stamp"
for p in openclaw-workspace-chat openclaw-workspace traffic-control; do
  printf "part\t%s\t%s\t%s\n" "$p" "$(find "$stamp/$p" -type f | wc -l)" "$(du -sb "$stamp/$p" | cut -f 1)"
done
if [ -n "$newest" ]; then printf "new\t%s\n" "$(du -sk "$newest" "$stamp" | tail -n 1 | cut -f 1)"
else printf "new\t%s\n" "$(du -sk "$stamp" | cut -f 1)"; fi
printf "snapshots\t%s\n" "$(ls -1d [0-9]*Z | wc -l)"
printf "leftovers\t%s\n" "$(ls -1d .incoming-* 2>/dev/null | wc -l)"
printf "total\t%s\n" "$(du -sk . | cut -f 1)"
printf "free\t%s\n" "$(df -Pk . | awk "NR == 2 { print \$4 }")"'
# shellcheck disable=SC2029 # the arguments are this side's values
report=$(ssh "${ssh_opts[@]}" "$host" "bash -s -- $remote $stamp '$newest' $db_sha ${required[*]}" <<<"$finish")
duration=$(( $(date +%s) - started ))

field() { awk -F '\t' -v k="$1" '$1 == k { print $2 }' <<<"$report"; }
parts=$(awk -F '\t' '$1 == "part" { print $2 "\t" $3 "\t" $4 }' <<<"$report" \
  | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t")
      | {(.[0]): {files: (.[1] | tonumber), bytes: (.[2] | tonumber)}}) | add')
jq -n -c --arg host "$host" --arg path "$remote/$stamp" --arg linkedTo "$newest" --argjson parts "$parts" \
  --argjson newKb "$(field new)" --argjson snapshots "$(field snapshots)" --argjson leftovers "$(field leftovers)" \
  --argjson totalKb "$(field total)" --argjson freeKb "$(field free)" --argjson vanished "$vanished" \
  --argjson durationSeconds "$duration" \
  '{ok: true, host: $host, path: $path, linkedTo: ($linkedTo | select(. != "") // null), parts: $parts,
    newBytes: ($newKb * 1024), snapshots: $snapshots, incompleteLeftovers: $leftovers,
    snapshotsBytes: ($totalKb * 1024), freeGb: ($freeKb / 1048576 | floor), filesVanished: ($vanished == 1),
    durationSeconds: $durationSeconds}'
