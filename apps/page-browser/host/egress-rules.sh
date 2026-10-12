#!/usr/bin/env bash
# The host's layer of the page containers' isolation (plan §4.5): it holds
# even if a container's own nftables rules (init-net) were gone.
#
# - Forwarded (DOCKER-USER): a page's address in pb-egress reaches only its
#   own page's SOCKS5 (IP and port); any other address of pb-egress, none.
#   In pb-control only `sync` opens the page's RPC (7700) and `api` its RPC
#   and screen (7700, 6901); a page opens nothing there — not Hub's
#   containers, not another page.
# - To the host itself (INPUT: its bridge addresses, its public address):
#   nothing from a page network but sync's and api's own traffic.
# Traffic inside one bridge reaches iptables only through br_netfilter:
# `deploy-page-browser.sh host` loads it, and this refuses to run without it.
#
# Built from the pages' env files ($PB_BASE/pages/*/page.env, and a
# page.env.next while page.sh switches that page) into new chains under a
# fresh name, jumped to first; only then are the previous chains unhooked
# and deleted. A run that fails before its hooks removes its own chains; an
# interrupted one leaves an extra, older set hooked — each set alone admits
# only what its pages may do — and the next run removes it. One run at a time
# (flock).
#
# Installed by scripts/deploy-page-browser.sh, run by page.sh after every
# page change and at boot by page-browser-egress.service.
#
#   egress-rules.sh apply | show
set -euo pipefail

BASE="${PB_BASE:-/opt/agency-hub/page-browser}"
CONTROL_PREFIX="${PB_CONTROL_PREFIX:-10.230.0}"
EGRESS_PREFIX="${PB_EGRESS_PREFIX:-10.230.1}"
CONTROL_SUBNET="$CONTROL_PREFIX.0/24"
EGRESS_SUBNET="$EGRESS_PREFIX.0/24"
SYNC_IP="$CONTROL_PREFIX.2"
API_IP="$CONTROL_PREFIX.3"
LOCK="${PB_EGRESS_LOCK:-/run/lock/page-browser-egress.lock}"
IPT=(iptables -w 10)

fail() {
  echo "egress-rules: $*" >&2
  exit 1
}

# Chains of earlier runs: PB-FWD-<id>, PB-IN-<id>.
old_chains() {
  "${IPT[@]}" -S | sed -n 's/^-N \(PB-\(FWD\|IN\)-[0-9a-f-]*\)$/\1/p' | grep -vx -e "$NEW_FWD" -e "$NEW_IN" || true
}

HOOKED=0
# A run that fails before hooking its chains leaves none of them behind.
drop_unhooked() {
  [[ "$HOOKED" == 0 ]] || return 0
  local chain
  for chain in "$NEW_FWD" "$NEW_IN"; do
    "${IPT[@]}" -D DOCKER-USER -j "$chain" 2>/dev/null || true
    "${IPT[@]}" -D INPUT -j "$chain" 2>/dev/null || true
    "${IPT[@]}" -F "$chain" 2>/dev/null || true
    "${IPT[@]}" -X "$chain" 2>/dev/null || true
  done
}

apply() {
  [[ "$(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null)" == "1" ]] \
    || fail "br_netfilter is off: traffic inside a bridge would pass unfiltered (run deploy-page-browser.sh host)"
  local run env_file pages=0 egress control socks_ip socks_port
  # iptables names hold 28 characters: PB-FWD- + 10 + - + 6.
  run="$(date +%s)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  NEW_FWD="PB-FWD-$run"
  NEW_IN="PB-IN-$run"
  "${IPT[@]}" -N "$NEW_FWD"
  "${IPT[@]}" -N "$NEW_IN"
  trap drop_unhooked EXIT

  "${IPT[@]}" -A "$NEW_FWD" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  shopt -s nullglob
  for env_file in "$BASE"/pages/*/page.env "$BASE"/pages/*/page.env.next; do
    egress="$(sed -n 's/^PB_EGRESS_IP=//p' "$env_file")"
    control="$(sed -n 's/^PB_CONTROL_IP=//p' "$env_file")"
    socks_ip="$(sed -n 's/^PB_SOCKS_IP=//p' "$env_file")"
    socks_port="$(sed -n 's/^PB_SOCKS_PORT=//p' "$env_file")"
    [[ "$egress" =~ ^[0-9.]+$ && "$control" =~ ^[0-9.]+$ && "$socks_ip" =~ ^[0-9.]+$ && "$socks_port" =~ ^[0-9]+$ ]] \
      || fail "$env_file is incomplete"
    "${IPT[@]}" -A "$NEW_FWD" -s "$egress" -d "$socks_ip" -p tcp --dport "$socks_port" -j RETURN
    "${IPT[@]}" -A "$NEW_FWD" -s "$egress" -j DROP
    "${IPT[@]}" -A "$NEW_FWD" -s "$SYNC_IP" -d "$control" -p tcp --dport 7700 -j RETURN
    "${IPT[@]}" -A "$NEW_FWD" -s "$API_IP" -d "$control" -p tcp -m multiport --dports 6901,7700 -j RETURN
    "${IPT[@]}" -A "$NEW_FWD" -d "$control" -j DROP
    "${IPT[@]}" -A "$NEW_FWD" -s "$control" -j DROP
    pages=$((pages + 1))
  done
  # Any other address of the page networks: a container no page file names.
  "${IPT[@]}" -A "$NEW_FWD" -s "$EGRESS_SUBNET" -j DROP
  "${IPT[@]}" -A "$NEW_FWD" -s "$SYNC_IP" -j RETURN
  "${IPT[@]}" -A "$NEW_FWD" -s "$API_IP" -j RETURN
  "${IPT[@]}" -A "$NEW_FWD" -s "$CONTROL_SUBNET" -j DROP

  "${IPT[@]}" -A "$NEW_IN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "${IPT[@]}" -A "$NEW_IN" -s "$SYNC_IP" -j RETURN
  "${IPT[@]}" -A "$NEW_IN" -s "$API_IP" -j RETURN
  "${IPT[@]}" -A "$NEW_IN" -s "$CONTROL_SUBNET" -j DROP
  "${IPT[@]}" -A "$NEW_IN" -s "$EGRESS_SUBNET" -j DROP

  "${IPT[@]}" -I DOCKER-USER 1 -j "$NEW_FWD"
  "${IPT[@]}" -I INPUT 1 -j "$NEW_IN"
  HOOKED=1
  local chain
  for chain in $(old_chains); do
    case "$chain" in
      PB-FWD-*) while "${IPT[@]}" -D DOCKER-USER -j "$chain" 2>/dev/null; do :; done ;;
      PB-IN-*) while "${IPT[@]}" -D INPUT -j "$chain" 2>/dev/null; do :; done ;;
    esac
    "${IPT[@]}" -F "$chain"
    "${IPT[@]}" -X "$chain"
  done
  echo "egress-rules: applied for $pages page state(s)"
}

show() {
  "${IPT[@]}" -S DOCKER-USER
  "${IPT[@]}" -S INPUT | grep -- '-j PB-' || true
  "${IPT[@]}" -S | grep -E '^-A PB-(FWD|IN)-' || true
}

case "${1:-}" in
  apply)
    exec 9>"$LOCK"
    flock -w 30 9 || fail "another run holds $LOCK"
    apply
    ;;
  show) show ;;
  *) echo "usage: $0 apply | show" >&2; exit 2 ;;
esac
