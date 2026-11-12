#!/usr/bin/env bash
# Installs the Mac's reporter of «Система → Состояние» as a launchd agent that runs every 5 minutes:
#   ru.gosling-agency.system-state → python3 <dir>/report.py --config <config>
# It copies report.py into its own directory (~/Library/Application Support/gosling/system-state by default,
# logs in <dir>/logs/). The config stays where it is (~/.config/agency/system-state.json by default):
# draft it first with generate-config.py and review it. Re-running replaces the copy and the agent;
# --uninstall removes the agent and the copied script, the config and the logs stay.
#   bash scripts/system-state/install-launchd.sh [--uninstall] [--config PATH]
set -Eeuo pipefail
here=$(cd "$(dirname "$0")" && pwd)
domain="gui/$(id -u)"
label=ru.gosling-agency.system-state
dest=${SYSTEM_STATE_DIR:-$HOME/Library/Application Support/gosling/system-state}
config=${SYSTEM_STATE_CONFIG:-$HOME/.config/agency/system-state.json}
plist="$HOME/Library/LaunchAgents/$label.plist"

uninstall=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --uninstall) uninstall=1; shift ;;
    --config) config=$2; shift 2 ;;
    *) printf 'usage: %s [--uninstall] [--config PATH]\n' "$0" >&2; exit 2 ;;
  esac
done

if [[ -n $uninstall ]]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist" "$dest/report.py"
  printf 'uninstalled %s (config %s and logs in %s kept)\n' "$label" "$config" "$dest/logs"
  exit 0
fi

[[ -f $config ]] || { printf 'No config at %s: draft it with generate-config.py --out %s and review it\n' "$config" "$config" >&2; exit 1; }
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$config"
mkdir -p "$dest/logs" "$(dirname "$plist")"
chmod 700 "$dest"
cp "$here/report.py" "$dest/report.py"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/env</string>
		<string>python3</string>
		<string>$dest/report.py</string>
		<string>--config</string>
		<string>$config</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>StartInterval</key>
	<integer>300</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$dest/logs/report.log</string>
	<key>StandardErrorPath</key>
	<string>$dest/logs/report.err</string>
</dict>
</plist>
PLIST
plutil -lint -s "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
printf 'installed %s → %s/report.py every 5 min, config %s\n' "$plist" "$dest" "$config"
