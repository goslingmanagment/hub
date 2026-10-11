#!/bin/sh
# Final stage-1 series on one code version, four stands side by side:
#   docker exec -d <project>-runner-1 sh /pb/stand/runner/batch3.sh A|B|C|D
# Mandatory-condition scenarios 50 runs each, controls 10.
set -u
PART="${1:-A}"
OUT=/stand/results/final-${STAND_NAME:-stand}-$PART-$(date -u +%Y%m%dT%H%M%SZ).log
run() { echo "=== $1 x$2 $(date -u +%H:%M:%S)" >> "$OUT"; node --no-warnings /pb/stand/runner/main.ts "$1" "$2" 2>&1 | grep '"scenario"' >> "$OUT"; }
case "$PART" in
  A)
    for s in ws-contexts ws-refused ws-blank-iframe ws-h2 ws-sw-restart; do run "$s" 50; done
    run ws-frames 20; run rules 20; run rules-bypass 20; run ws-detect 5
    ;;
  B)
    for s in loss-operator-kill loss-operator-kill-inflight loss-operator-hang loss-holder-kill loss-holder-kill-inflight loss-cdp-break loss-cdp-break-inflight; do run "$s" 50; done
    ;;
  C)
    for s in loss-cdp-drop loss-chrome-kill loss-planned-stop loss-cdp-break-late loss-cdp-break-late-inflight loss-holder-kill-late loss-open-window loss-open-window-late; do run "$s" 50; done
    run loss-cdp-break-late-nogate 10
    ;;
  D)
    run smoke 50
    for s in retry-refused retry-goaway retry-reset; do run "$s" 50; done
    for s in retry-refused-rtt0 retry-goaway-rtt0 retry-reset-rtt0; do run "$s" 20; done
    run send-time 10
    for s in expiry-site-socks expiry-site-tcp expiry-hub-socks; do run "$s" 50; done
    run body-capture 20; run body-burst 5; run hub-slow-body 10; run hub-gc-body 5
    for s in retry-refused-nogate retry-goaway-nogate retry-reset-nogate expiry-site-socks-nogate expiry-site-tcp-nogate expiry-hub-socks-nothing expiry-hub-socks-abortonly; do run "$s" 10; done
    ;;
esac
echo "=== done $(date -u +%H:%M:%S)" >> "$OUT"
