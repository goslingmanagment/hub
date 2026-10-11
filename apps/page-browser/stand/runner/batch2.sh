#!/bin/sh
# Series of the stage-1 items that do not need Fansly (5, 6, 11, 16, 17) and
# a repeat of the mandatory conditions on the full image (rules extension,
# environment, WebGL), on one stand.
set -u
OUT=/stand/results/batch-${STAND_NAME:-stand}-D-$(date -u +%Y%m%dT%H%M%SZ).log
run() { echo "=== $1 x$2 $(date -u +%H:%M:%S)" >> "$OUT"; node --no-warnings /pb/stand/runner/main.ts "$1" "$2" 2>&1 | grep '"scenario"' >> "$OUT"; }
run smoke 20
run rules 20
run rules-bypass 20
run body-capture 20
run body-burst 5
run ws-frames 20
run ws-contexts 20
run retry-goaway 20
run expiry-site-tcp 20
run loss-cdp-break-late 20
run loss-open-window 20
echo "=== done $(date -u +%H:%M:%S)" >> "$OUT"
