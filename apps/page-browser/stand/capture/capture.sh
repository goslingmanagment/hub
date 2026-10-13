#!/bin/sh
# The capture at the operating system's level (plan §4.5): run in the page
# container's network namespace (Compose `network_mode: service:browser`,
# page.stand.yml), it writes every packet that is not loopback — one line
# each — to the results volume, a new file every start. The runner judges
# the lines (runner/capture.ts): what left the page container other than to
# its SOCKS5 and the operator's RPC answers went past the proxy — and a
# capture without the run's sentinels is no evidence at all.
set -eu
dir="/stand/results/capture/${PB_SUITE_CAPTURE_NAME:?the page}"
mkdir -p "$dir"
file="$dir/$(date -u +%Y%m%dT%H%M%S%3NZ)-$$.txt"
echo "capture: $file" >&2
exec tcpdump -i any -nn -tt -l --immediate-mode 'not net 127.0.0.0/8' > "$file" 2> "$file.log"
