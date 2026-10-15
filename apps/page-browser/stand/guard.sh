#!/usr/bin/env bash
# The stand's guard on the production server (owner's decision №14; ported
# from the stage-2 stand, proto/project-browser stand/agency-de/guard.sh):
# while the stand exists, every 5 s it measures Hub's own health answer (the
# API plus a `select 1` on Hub's database) and the host, and stops every
# stand container (label agency.stand=pb-suite) at once when
#   - one answer takes over 500 ms, fails, or is not 200;
#   - the last 6 answers (30 s) average over 50 ms;
#   - MemAvailable falls under 4 GiB;
#   - the 1-minute load average exceeds 6 (8 cores).
# Hub's baseline on 2026-10-12: 2–3 ms, 12 GB available, load 0.3.
#
# After a trip the file TRIPPED stays, and any stand container that runs
# again is stopped at once until stand.sh clear-trip removes it; stand.sh
# refuses to build, start or run anything meanwhile.
# Runs as a transient systemd unit (stand.sh guard-start) with a whole core
# (a probe under a tight quota measures its own throttling, stage 2 finding
# 4); nothing of it survives a reboot.
set -uo pipefail

DIR="${PB_GUARD_DIR:-/opt/pb-suite/guard}"
URL="${PB_GUARD_URL:-http://127.0.0.1:3000/api/v1/health}"
# Where the host's memory and load are read, and PB_GUARD_ONCE=1 for one
# measurement and out: the guard's own test (tests/page-browser-stand-scripts.test.ts).
MEMINFO="${PB_GUARD_MEMINFO:-/proc/meminfo}"
LOADAVG="${PB_GUARD_LOADAVG:-/proc/loadavg}"
INTERVAL_S=5
MAX_ONE_MS=500
MAX_AVG_MS=50
WINDOW=6
MIN_AVAILABLE_KB=$((4 * 1024 * 1024))
MAX_LOAD=6
STAND_LABEL=agency.stand=pb-suite
BUILDER=buildx_buildkit_pb-suite-builder0

mkdir -p "$DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$DIR/guard.log"; }

# Everything of the stand that runs: its containers (by label) and the
# builds' BuildKit container (buildx gives it no label: by its name).
stop_stand() {
  local ids
  ids="$(timeout 10 docker ps -q --filter "label=$STAND_LABEL")"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && timeout 30 docker stop -t 3 $ids >/dev/null 2>&1
  if timeout 10 docker ps -q --filter "name=^${BUILDER}\$" | grep -q .; then
    timeout 30 docker stop -t 2 "$BUILDER" >/dev/null 2>&1
    log "stopped: the builder"
  fi
  [[ -n "$ids" ]] && log "stopped: $(echo "$ids" | wc -w) stand containers"
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
  available="$(awk '/^MemAvailable:/ { print $2 }' "$MEMINFO")"
  load="$(cut -d' ' -f1 "$LOADAVG")"

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
  [[ "${PB_GUARD_ONCE:-0}" == 1 ]] && exit 0
  sleep $(( INTERVAL_S - (SECONDS - started) > 0 ? INTERVAL_S - (SECONDS - started) : 0 ))
done
