#!/bin/sh
# Stage-1 series (plan §5): each mandatory-condition scenario 50 times, the
# controls without the candidate mechanisms 10 times.
#   docker exec -d pb-stand-runner-1 sh /pb/stand/runner/batch.sh
set -u
OUT=/stand/results/batch-$(date -u +%Y%m%dT%H%M%SZ).log
run() { echo "=== $1 x$2 $(date -u +%H:%M:%S)" >> "$OUT"; node --no-warnings /pb/stand/runner/main.ts "$1" "$2" 2>&1 | grep '"scenario"' >> "$OUT"; }
for s in ws-contexts ws-refused ws-blank-iframe ws-h2; do run "$s" 50; done
for s in retry-refused retry-goaway retry-reset; do run "$s" 50; done
run send-time 10
for s in expiry-site-socks expiry-site-tcp expiry-hub-socks; do run "$s" 50; done
for s in loss-operator-kill loss-operator-kill-inflight loss-operator-hang loss-holder-kill loss-holder-kill-inflight loss-cdp-break loss-cdp-break-inflight loss-cdp-drop loss-chrome-kill loss-planned-stop loss-cdp-break-late loss-cdp-break-late-inflight loss-holder-kill-late loss-open-window; do run "$s" 50; done
for s in retry-refused-nogate retry-goaway-nogate retry-reset-nogate expiry-site-socks-nogate expiry-site-tcp-nogate expiry-hub-socks-nothing expiry-hub-socks-abortonly loss-cdp-break-late-nogate loss-open-window-late; do run "$s" 10; done
echo "=== done $(date -u +%H:%M:%S)" >> "$OUT"
