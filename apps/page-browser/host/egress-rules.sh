#!/usr/bin/env bash
# The host's layer of a page container's egress (plan §4.5): in Docker's
# DOCKER-USER chain, a page container's address in pb-egress reaches only
# its own page's SOCKS5 (IP and port); any other address of pb-egress
# reaches nothing. The container's own nftables rules (init-net) are the
# first layer; this one holds even if they were gone.
#
# Built from the pages' env files (/opt/agency-hub/page-browser/pages/*/page.env:
# PB_EGRESS_IP, PB_SOCKS_IP, PB_SOCKS_PORT) into a fresh chain, which then
# takes the place of the old one in one jump swap: no instant without rules.
# Installed by scripts/deploy-page-browser.sh, run by it after every page
# change and at boot by page-browser-egress.service.
#
#   egress-rules.sh apply | show
set -euo pipefail

BASE="${PB_BASE:-/opt/agency-hub/page-browser}"
CHAIN=PB-EGRESS
NEXT=PB-EGRESS-NEXT
IPT=(iptables -w 10)

subnet() {
  docker network inspect pb-egress --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
}

apply() {
  local egress_subnet env_file pages=0
  egress_subnet="$(subnet)"
  [[ -n "$egress_subnet" ]] || { echo "egress-rules: no network pb-egress" >&2; exit 1; }
  "${IPT[@]}" -N "$NEXT" 2>/dev/null || "${IPT[@]}" -F "$NEXT"
  shopt -s nullglob
  for env_file in "$BASE"/pages/*/page.env; do
    local PB_EGRESS_IP="" PB_SOCKS_IP="" PB_SOCKS_PORT=""
    PB_EGRESS_IP="$(sed -n 's/^PB_EGRESS_IP=//p' "$env_file")"
    PB_SOCKS_IP="$(sed -n 's/^PB_SOCKS_IP=//p' "$env_file")"
    PB_SOCKS_PORT="$(sed -n 's/^PB_SOCKS_PORT=//p' "$env_file")"
    [[ "$PB_EGRESS_IP" =~ ^[0-9.]+$ && "$PB_SOCKS_IP" =~ ^[0-9.]+$ && "$PB_SOCKS_PORT" =~ ^[0-9]+$ ]] \
      || { echo "egress-rules: $env_file is incomplete" >&2; exit 1; }
    "${IPT[@]}" -A "$NEXT" -s "$PB_EGRESS_IP" -d "$PB_SOCKS_IP" -p tcp --dport "$PB_SOCKS_PORT" -j RETURN
    "${IPT[@]}" -A "$NEXT" -s "$PB_EGRESS_IP" -j DROP
    pages=$((pages + 1))
  done
  # Any other address of pb-egress — a container no page file names.
  "${IPT[@]}" -A "$NEXT" -s "$egress_subnet" -j DROP
  "${IPT[@]}" -I DOCKER-USER 1 -j "$NEXT"
  while "${IPT[@]}" -D DOCKER-USER -j "$CHAIN" 2>/dev/null; do :; done
  "${IPT[@]}" -F "$CHAIN" 2>/dev/null || true
  "${IPT[@]}" -X "$CHAIN" 2>/dev/null || true
  "${IPT[@]}" -E "$NEXT" "$CHAIN"
  echo "egress-rules: applied for $pages page(s)"
}

case "${1:-}" in
  apply) apply ;;
  show) "${IPT[@]}" -S DOCKER-USER; "${IPT[@]}" -S "$CHAIN" 2>/dev/null || true ;;
  *) echo "usage: $0 apply | show" >&2; exit 2 ;;
esac
