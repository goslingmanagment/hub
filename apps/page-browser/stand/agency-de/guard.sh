#!/usr/bin/env bash
# The stand's guard on the production server (owner's decision №14): while
# the stand exists, every 5 s it measures Hub's own health answer (the API
# plus a `select 1` on Hub's database) and the host, and stops every stand
# container at once when
#   - one answer takes over 500 ms, fails, or is not 200;
#   - the last 6 answers (30 s) average over 50 ms;
#   - MemAvailable falls under 4 GiB;
#   - the 1-minute load average exceeds 6 (8 cores).
# Hub's baseline on 2026-10-12: 2–3 ms, 12 GB available, load 0.3.
#
# After a trip the file TRIPPED stays, and any stand container that runs
# again is stopped at once until stand.sh clear-trip removes it.
# Runs as a transient systemd unit (stand.sh guard-start); nothing of it
# survives a reboot.
set -uo pipefail

DIR="${PB_GUARD_DIR:-/opt/pb-stand/guard}"
URL="${PB_GUARD_URL:-http://127.0.0.1:3000/api/v1/health}"
INTERVAL_S=5
MAX_ONE_MS=500
MAX_AVG_MS=50
WINDOW=6
MIN_AVAILABLE_KB=$((4 * 1024 * 1024))
MAX_LOAD=6
STAND_LABEL=agency.stand=pb-stand
BUILDER=buildx_buildkit_pb-stand-builder0

mkdir -p "$DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$DIR/guard.log"; }

stop_stand() {
  local ids
  ids="$(timeout 10 docker ps -q --filter "label=$STAND_LABEL")"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && timeout 30 docker stop -t 3 $ids >/dev/null 2>&1
  if timeout 10 docker ps -q --filter "name=^${BUILDER}\$" | grep -q .; then
    timeout 30 docker stop -t 2 "$BUILDER" >/dev/null 2>&1
  fi
  [[ -n "$ids" ]] && log "stopped: $(echo $ids | wc -w) stand containers"
}

trip() {
  log "TRIP: $*"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$DIR/TRIPPED"
  stop_stand
}

samples=()
minute_start=$SECONDS
log "start: window ${WINDOW}x${INTERVAL_S}s, one <= ${MAX_ONE_MS} ms, avg <= ${MAX_AVG_MS} ms, available >= $((MIN_AVAILABLE_KB / 1024)) MiB, load <= ${MAX_LOAD}"
while true; do
  started=$SECONDS
  out="$(curl -s -o /dev/null --max-time 2 -w '%{http_code} %{time_total}' "$URL" || true)"
  code="${out%% *}"
  ms="$(awk -v t="${out##* }" 'BEGIN { printf "%d", t * 1000 }')"
  [[ "$code" == "200" ]] || ms=2000
  samples+=("$ms")
  (( ${#samples[@]} > WINDOW )) && samples=("${samples[@]:1}")
  sum=0; max=0
  for s in "${samples[@]}"; do sum=$((sum + s)); (( s > max )) && max=$s; done
  avg=$((sum / ${#samples[@]}))
  available="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)"
  load="$(cut -d' ' -f1 /proc/loadavg)"

  reason=""
  if [[ "$code" != "200" ]]; then reason="Hub health answered '${code}'"
  elif (( ms > MAX_ONE_MS )); then reason="Hub health took ${ms} ms"
  elif (( ${#samples[@]} == WINDOW && avg > MAX_AVG_MS )); then reason="Hub health averaged ${avg} ms over $((WINDOW * INTERVAL_S)) s"
  elif (( available < MIN_AVAILABLE_KB )); then reason="MemAvailable $((available / 1024)) MiB"
  elif awk -v l="$load" -v m="$MAX_LOAD" 'BEGIN { exit !(l > m) }'; then reason="load ${load}"
  fi

  if [[ -f "$DIR/TRIPPED" ]]; then
    stop_stand
  elif [[ -n "$reason" ]]; then
    trip "$reason"
  fi

  printf '%s ms=%s avg=%s available_mib=%s load=%s tripped=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ms" "$avg" "$((available / 1024))" "$load" \
    "$([[ -f "$DIR/TRIPPED" ]] && echo yes || echo no)" > "$DIR/last"
  if (( SECONDS - minute_start >= 60 )); then
    log "sample: last=${ms} ms max30s=${max} ms avg30s=${avg} ms available=$((available / 1024)) MiB load=${load}"
    minute_start=$SECONDS
  fi
  sleep $(( INTERVAL_S - (SECONDS - started) > 0 ? INTERVAL_S - (SECONDS - started) : 0 ))
done
