#!/bin/sh
# Stage-1 series on the final prototype (after Astra's reviews):
#   docker exec -d -e SERIES=<name> <project>-runner-1 sh /pb/stand/runner/batch5.sh A|B|C|D|E|F|G
# This only records what each scenario printed. The verdict of the series is
# verify-series.ts over the result files (the SERIES table there is this list).
set -u
PART="${1:-A}"
OUT=/stand/results/${SERIES:-last}-${STAND_NAME:-stand}-$PART-$(date -u +%Y%m%dT%H%M%SZ).log
# RUNS=<n>: a dry pass, every scenario n times (not a series: the verifier
# refuses its counts).
run() {
  set -- "$1" "${RUNS:-$2}"
  echo "=== $1 x$2 $(date -u +%H:%M:%S)" >> "$OUT"
  node --no-warnings /pb/stand/runner/main.ts "$1" "$2" > /tmp/batch-run.out 2>&1
  code=$?
  # A runner that died without its summary leaves a line too.
  grep '"scenario"' /tmp/batch-run.out >> "$OUT" || echo "=== no summary: $1 (exit $code)" >> "$OUT"
}
case "$PART" in
  A)
    for s in ws-contexts ws-refused ws-blank-iframe ws-h2 ws-sw-restart; do run "$s" 50; done
    run ws-tamper 20; run ws-handshake-outcome 20; run ws-frames 20; run rules 20; run rules-bypass 20; run ws-detect 5
    for s in site-redirect site-redirect-xhr hub-redirect; do run "$s" 20; done
    run xhr-parity 10
    run body-capture 20; run body-burst 5; run hub-slow-body 10; run hub-gc-body 5
    ;;
  B)
    for s in loss-operator-kill loss-operator-kill-inflight loss-operator-hang loss-holder-kill loss-holder-kill-inflight loss-cdp-break loss-cdp-break-inflight loss-cdp-drop loss-chrome-kill loss-planned-stop; do run "$s" 50; done
    run engine-loss-halt 20
    ;;
  C)
    for s in loss-cdp-break-late loss-cdp-break-late-inflight loss-holder-kill-late loss-open-window loss-open-window-late loss-responding loss-responding-late loss-new-connection loss-new-connection-late; do run "$s" 50; done
    run loss-cdp-break-late-nogate 10
    ;;
  D)
    run smoke 50
    for s in retry-refused retry-goaway retry-reset; do run "$s" 50; done
    for s in retry-refused-rtt0 retry-goaway-rtt0 retry-reset-rtt0 retry-post retry-post-slowcdp retry-post-large; do run "$s" 20; done
    run retry-post-large-nogate 10; run post-too-large 10
    run idle-ping 10; run idle-post 10; run send-time 10
    run slow-body-limit 10; run slow-body-limit-capture 5
    for s in expiry-site-socks expiry-site-tcp expiry-hub-socks; do run "$s" 50; done
    for s in retry-refused-nogate retry-goaway-nogate retry-reset-nogate expiry-site-socks-nogate expiry-site-tcp-nogate expiry-hub-socks-nogate; do run "$s" 10; done
    ;;
  # The deadline's other cases of the plan (§4.2, step 4), the engine's next
  # admission after them, the socket's deadline and the 408 repeat.
  E)
    for s in expiry-site-tls expiry-hub-tls expiry-hub-page-stop; do run "$s" 50; done
    run expiry-site-tls-nogate 10; run expiry-hub-page-stop-nogate 10
    run next-admission-expired 20; run next-admission-slow 20; run stale-after-limit 10
    run cancel-next-admission 20; run cancel-next-admission-pending 20
    for s in document-replaced-site document-replaced-site-simple document-replaced-hub; do run "$s" 10; done
    ;;
  F)
    for s in expiry-site-reused expiry-hub-reused expiry-site-operator-stop expiry-site-late-grant expiry-hub-late-grant retry-408; do run "$s" 50; done
    run expiry-site-reused-nogate 10; run expiry-site-operator-stop-nogate 10; run retry-408-nogate 10
    run ws-expiry-socks 50; run ws-expiry-tls 50
    ;;
  # The replies of CDP commands reach the operator later than the events.
  G)
    export STAND_CDP_REPLY_DELAY_MS=100
    for s in smoke body-capture hub-redirect site-redirect site-redirect-xhr loss-cdp-break-late-inflight; do run "$s" 20; done
    for s in ws-contexts xhr-parity retry-post; do run "$s" 10; done
    ;;
esac
echo "=== done $(date -u +%H:%M:%S)" >> "$OUT"
