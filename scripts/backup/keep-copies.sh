#!/usr/bin/env bash
# Keeps the newest <keep> dated copies in <dir> and removes the older ones, oldest first:
#   bash keep-copies.sh <dir> <keep> <newest>
# A dated copy is a directory named <YYYYMMDD>T<HHMMSS>Z (UTC); the pulls give a copy that name only
# after its checks. Nothing else in <dir> is touched: a run's .incoming-<UTC>/, logs/, the scripts,
# links. <newest> is the copy the calling run has just made and checked: it always stays and counts
# among the <keep>, even when a wrong clock gave it an older name. Prints how many copies it removed.
# pull-backup.sh and pull-contentops-backup.sh call it only after their own copy is in place, so a
# run that fails removes nothing. Plain bash 3.2: launchd runs the pulls with macOS /bin/bash.
set -Eeuo pipefail
usage='usage: keep-copies.sh <dir> <keep> <newest>'
dir=${1:?$usage}
keep=${2:?$usage}
newest=${3:?$usage}
[[ $keep =~ ^[1-9][0-9]*$ ]] || { printf 'keep must be a whole number of copies, at least 1 (got %s)\n' "$keep" >&2; exit 1; }
[[ -d $dir/${newest##*/} && ! -L $dir/${newest##*/} ]] \
  || { printf 'No copy %s in %s: nothing removed\n' "${newest##*/}" "$dir" >&2; exit 1; }

others=()
for copy in "$dir"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z; do
  if [[ -d $copy && ! -L $copy && ${copy##*/} != "${newest##*/}" ]]; then
    others+=("$copy")
  fi
done
# Glob order is name order, and for these names that is time order: the oldest come first.
removed=0
excess=$(( ${#others[@]} - (keep - 1) ))
if (( excess > 0 )); then
  for copy in "${others[@]:0:excess}"; do
    rm -rf -- "$copy"
    removed=$((removed + 1))
  done
fi
printf '%s\n' "$removed"
