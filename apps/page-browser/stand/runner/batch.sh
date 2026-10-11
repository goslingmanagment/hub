#!/bin/sh
# Stage-1 series (plan §5): each mandatory-condition scenario 50 times, the
# controls without the candidate mechanisms 10 times. Three parts, so three
# stands can run them side by side:
#   docker exec -d <project>-runner-1 sh /pb/stand/runner/batch.sh A|B|C
set -u
PART="${1:-A}"
OUT=/stand/results/batch-${STAND_NAME:-stand}-$PART-$(date -u +%Y%m%dT%H%M%SZ).log
run() { echo "=== $1 x$2 $(date -u +%H:%M:%S)" >> "$OUT"; node --no-warnings /pb/stand/runner/main.ts "$1" "$2" 2>&1 | grep '"scenario"' >> "$OUT"; }
case "$PART" in
  A)
    for s in ws-contexts ws-refused ws-blank-iframe ws-h2; do run "$s" 50; done
    for s in retry-refused retry-goaway retry-reset; do run "$s" 50; done
    run send-time 10
    run hub-slow-body 5
    run hub-gc-body 5
    for s in expiry-site-socks expiry-site-tcp expiry-hub-socks; do run "$s" 50; done
    for s in retry-refused-nogate retry-goaway-nogate retry-reset-nogate retry-refused-rtt0 retry-goaway-rtt0 retry-reset-rtt0 expiry-site-socks-nogate expiry-site-tcp-nogate expiry-hub-socks-nothing expiry-hub-socks-abortonly; do run "$s" 10; done
    ;;
  B)
    for s in loss-operator-kill loss-operator-kill-inflight loss-operator-hang loss-holder-kill loss-holder-kill-inflight loss-cdp-break loss-cdp-break-inflight; do run "$s" 50; done
    ;;
  C)
    for s in loss-cdp-drop loss-chrome-kill loss-planned-stop loss-cdp-break-late loss-cdp-break-late-inflight loss-holder-kill-late loss-open-window; do run "$s" 50; done
    for s in loss-cdp-break-late-nogate loss-open-window-late; do run "$s" 10; done
    ;;
esac
echo "=== done $(date -u +%H:%M:%S)" >> "$OUT"
