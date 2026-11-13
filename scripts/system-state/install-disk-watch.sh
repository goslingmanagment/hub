#!/usr/bin/env bash
# Installs the watch of the Mac's free space as a launchd agent that runs every 30 minutes:
#   ru.gosling-agency.mac-disk-watch → bash <dir>/disk-watch.sh
# It copies disk-watch.sh next to the reporter (~/Library/Application Support/gosling/system-state by default),
# logs in <dir>/logs/. For Hub to see it, the reporter's config (~/.config/agency/system-state.json) needs its
# line in "launchd": generate-config.py drafts it, or add
#   { "key": "mac.launchd.mac-disk-watch", "label": "ru.gosling-agency.mac-disk-watch",
#     "title": "Место на маке (порог 40 ГБ)", "periodSeconds": 1800 }
# Re-running replaces the copy and the agent; --uninstall removes both, the logs stay.
#   bash scripts/system-state/install-disk-watch.sh [--uninstall] [--min-gb N]
set -Eeuo pipefail
here=$(cd "$(dirname "$0")" && pwd)
domain="gui/$(id -u)"
label=ru.gosling-agency.mac-disk-watch
dest=${SYSTEM_STATE_DIR:-$HOME/Library/Application Support/gosling/system-state}
plist="$HOME/Library/LaunchAgents/$label.plist"
min_gb=40

uninstall=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --uninstall) uninstall=1; shift ;;
    --min-gb) min_gb=$2; shift 2 ;;
    *) printf 'usage: %s [--uninstall] [--min-gb N]\n' "$0" >&2; exit 2 ;;
  esac
done
[[ $min_gb =~ ^[0-9]+$ ]] || { printf -- '--min-gb takes whole gigabytes, not %s\n' "$min_gb" >&2; exit 2; }

if [[ -n $uninstall ]]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist" "$dest/disk-watch.sh"
  printf 'uninstalled %s (logs in %s kept)\n' "$label" "$dest/logs"
  exit 0
fi

mkdir -p "$dest/logs" "$(dirname "$plist")"
chmod 700 "$dest"
cp "$here/disk-watch.sh" "$dest/disk-watch.sh"
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
		<string>$dest/disk-watch.sh</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>MAC_DISK_MIN_FREE_GB</key>
		<string>$min_gb</string>
	</dict>
	<key>StartInterval</key>
	<integer>1800</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$dest/logs/disk-watch.log</string>
	<key>StandardErrorPath</key>
	<string>$dest/logs/disk-watch.err</string>
</dict>
</plist>
PLIST
plutil -lint -s "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
printf 'installed %s → %s/disk-watch.sh every 30 min, low below %s GB free\n' "$plist" "$dest" "$min_gb"
