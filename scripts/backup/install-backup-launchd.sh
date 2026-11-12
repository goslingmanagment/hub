#!/usr/bin/env bash
# Installs the daily copy of the hub's business data on this Mac: copies pull-backup.sh,
# business-dump.sh and unfinished-inputs.sql into ~/Backups/agency-hub and loads the launchd agent
# ru.gosling-agency.hub-backup (every day at 05:20 Moscow time, low priority, logs in
# ~/Backups/agency-hub/logs/). Re-running it replaces the three files and the agent. --uninstall
# removes the agent and those three files; the copies of the data and the logs stay.
#   bash scripts/backup/install-backup-launchd.sh [--uninstall]
set -Eeuo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${HUB_BACKUP_DIR:-$HOME/Backups/agency-hub}
label=ru.gosling-agency.hub-backup
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

case ${1:-} in
  "") ;;
  --uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist" "$dest/pull-backup.sh" "$dest/business-dump.sh" "$dest/unfinished-inputs.sql"
    printf 'uninstalled %s (copies and logs in %s kept)\n' "$label" "$dest"
    exit 0 ;;
  *) printf 'usage: %s [--uninstall]\n' "$0" >&2; exit 2 ;;
esac

# launchd fires calendar jobs in the Mac's local time: 05:20 Moscow (UTC+3, no DST) = 02:20 UTC,
# moved into the current local offset. A zone with DST shifts it by an hour until the next install.
offset=$(date +%z)
sign=${offset:0:1}; offset_minutes=$((10#${offset:1:2} * 60 + 10#${offset:3:2}))
[[ $sign == "-" ]] && offset_minutes=$((-offset_minutes))
local_minutes=$(( ((2 * 60 + 20 + offset_minutes) % 1440 + 1440) % 1440 ))
hour=$((local_minutes / 60)); minute=$((local_minutes % 60))

mkdir -p "$dest/logs" "$(dirname "$plist")"
chmod 700 "$dest"
cp "$here/pull-backup.sh" "$here/business-dump.sh" "$here/unfinished-inputs.sql" "$dest/"
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
		<string>$dest/pull-backup.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>HUB_BACKUP_DIR</key>
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
	<string>$dest/logs/pull-backup.log</string>
	<key>StandardErrorPath</key>
	<string>$dest/logs/pull-backup.err</string>
</dict>
</plist>
PLIST
plutil -lint -s "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
printf 'installed %s → %s/pull-backup.sh daily at %02d:%02d local (05:20 Moscow)\n' "$plist" "$dest" "$hour" "$minute"
