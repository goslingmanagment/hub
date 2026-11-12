#!/usr/bin/env bash
# Installs the daily copies on this Mac as launchd agents. Each runs a copy of its scripts kept in
# its own directory (low priority, logs in <directory>/logs/):
#   hub         ru.gosling-agency.hub-backup         05:20 Moscow  pull-backup.sh, business-dump.sh,
#                                                                  unfinished-inputs.sql → ~/Backups/agency-hub
#   contentops  ru.gosling-agency.contentops-backup  05:45 Moscow  pull-contentops-backup.sh → ~/Backups/contentops
#   mac-push    ru.gosling-agency.mac-backup-push    06:05 Moscow  push-mac-backups.sh → ~/Backups/agency-mac
# With no job named, all three. Re-running it replaces the copied scripts and the agents. --uninstall
# removes the agents named (all three by default) and their copied scripts; the copies of the data
# and the logs stay.
#   bash scripts/backup/install-backup-launchd.sh [--uninstall] [hub|contentops|mac-push ...]
set -Eeuo pipefail
here=$(cd "$(dirname "$0")" && pwd)
domain="gui/$(id -u)"

# job <name>: sets label, dest, dest_var, run, files, utc_hour, utc_minute, moscow for that job.
job() {
  case $1 in
    hub)
      label=ru.gosling-agency.hub-backup dest=${HUB_BACKUP_DIR:-$HOME/Backups/agency-hub} dest_var=HUB_BACKUP_DIR
      run=pull-backup.sh files=(pull-backup.sh business-dump.sh unfinished-inputs.sql)
      utc_hour=2 utc_minute=20 moscow=05:20 ;;
    contentops)
      label=ru.gosling-agency.contentops-backup dest=${CONTENTOPS_BACKUP_DIR:-$HOME/Backups/contentops}
      dest_var=CONTENTOPS_BACKUP_DIR run=pull-contentops-backup.sh files=(pull-contentops-backup.sh)
      utc_hour=2 utc_minute=45 moscow=05:45 ;;
    mac-push)
      label=ru.gosling-agency.mac-backup-push dest=${MAC_BACKUP_DIR:-$HOME/Backups/agency-mac} dest_var=MAC_BACKUP_DIR
      run=push-mac-backups.sh files=(push-mac-backups.sh)
      utc_hour=3 utc_minute=5 moscow=06:05 ;;
  esac
  plist="$HOME/Library/LaunchAgents/$label.plist"
}

uninstall="" names=()
for arg in "$@"; do
  case $arg in
    --uninstall) uninstall=1 ;;
    hub | contentops | mac-push) names+=("$arg") ;;
    *) printf 'usage: %s [--uninstall] [hub|contentops|mac-push ...]\n' "$0" >&2; exit 2 ;;
  esac
done
[[ ${#names[@]} -gt 0 ]] || names=(hub contentops mac-push)

if [[ -n $uninstall ]]; then
  for name in "${names[@]}"; do
    job "$name"
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist"
    for f in "${files[@]}"; do rm -f "${dest:?}/$f"; done
    printf 'uninstalled %s (copies and logs in %s kept)\n' "$label" "$dest"
  done
  exit 0
fi

# launchd fires calendar jobs in the Mac's local time: Moscow (UTC+3, no DST) is fixed in UTC and
# moved into the current local offset. A zone with DST shifts it by an hour until the next install.
offset=$(date +%z)
sign=${offset:0:1}; offset_minutes=$((10#${offset:1:2} * 60 + 10#${offset:3:2}))
[[ $sign == "-" ]] && offset_minutes=$((-offset_minutes))

for name in "${names[@]}"; do
  job "$name"
  for f in "${files[@]}"; do
    [[ -f $here/$f ]] || { printf 'Missing %s next to %s\n' "$f" "$0" >&2; exit 1; }
  done
  local_minutes=$(( ((utc_hour * 60 + utc_minute + offset_minutes) % 1440 + 1440) % 1440 ))
  hour=$((local_minutes / 60)); minute=$((local_minutes % 60))
  mkdir -p "$dest/logs" "$(dirname "$plist")"
  chmod 700 "$dest"
  for f in "${files[@]}"; do cp "$here/$f" "$dest/"; done
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$dest/$run</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>$dest_var</key>
		<string>$dest</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>$hour</integer>
		<key>Minute</key>
		<integer>$minute</integer>
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$dest/logs/${run%.sh}.log</string>
	<key>StandardErrorPath</key>
	<string>$dest/logs/${run%.sh}.err</string>
</dict>
</plist>
PLIST
  plutil -lint -s "$plist"
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist"
  printf 'installed %s → %s/%s daily at %02d:%02d local (%s Moscow)\n' "$plist" "$dest" "$run" "$hour" "$minute" "$moscow"
done
