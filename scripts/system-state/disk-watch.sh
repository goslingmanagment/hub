#!/usr/bin/env bash
# Says whether the Mac still has room: exit 0 with at least MAC_DISK_MIN_FREE_GB (40) free on the home volume,
# exit 1 with less. It changes nothing and deletes nothing. The reporter of «Система → Состояние» watches its
# launchd agent like any other, so two low readings in a row open the owner's matter, and it closes itself once
# there is room again. Why 40: the nightly copy of Hub's base refuses below 30 and writes about 4.
set -u
min_gb=${MAC_DISK_MIN_FREE_GB:-40}
free_kb=$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')
free_gb=$(( ${free_kb:-0} / 1024 / 1024 ))
# One line per run: the reporter dates a run by this log's mtime.
printf '%s free %s GB, need %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$free_gb" "$min_gb"
[[ $free_gb -ge $min_gb ]]
