#!/usr/bin/env bash
# The stand on the production server agency-de (plan §5, stage 2; owner's
# decision №14). Runs on the server, from /opt/pb-stand; push.sh puts it
# there with everything it needs.
#
#   stand.sh guard-start | guard-stop | clear-trip
#   stand.sh apparmor-load              the profile `page-browser` until reboot
#   stand.sh build proto <rev>          pb-stand/server:<rev>, pb-stand/browser:<rev>
#   stand.sh build pr2 <rev>            pb-stand/page-browser:<rev> (PR 2's image)
#   stand.sh up <rev> | down
#   stand.sh series <part> <name>       a part of the prototype's series (batch5.sh)
#   stand.sh image-check <rev> [<apparmor profile>]
#                                       PR 2's image check, in the stand's networks
#   stand.sh status
#   stand.sh remove                     everything of the stand but its results
#
# Nothing starts while the guard is not watching Hub or after it tripped.
# Builds run in a BuildKit container with 2 CPU and 3 GB, and only while
# no other stand container runs; so does the image check (1 CPU, 2 GB).
set -euo pipefail

BASE=/opt/pb-stand
GUARD_UNIT=pb-stand-guard
BUILDER=pb-stand-builder
LABEL=agency.stand=pb-stand
CONTROL_NET=pb-stand-control
EGRESS_NET=pb-stand-egress

fail() {
  echo "stand: $*" >&2
  exit 1
}

guard_ok() {
  systemctl is-active --quiet "$GUARD_UNIT" || fail "the guard is not running (stand.sh guard-start)"
  [[ ! -f "$BASE/guard/TRIPPED" ]] || fail "the guard tripped: $(tail -1 "$BASE/guard/TRIPPED")"
  [[ -n "$(find "$BASE/guard/last" -newermt '15 seconds ago' 2>/dev/null)" ]] || fail "the guard has not measured for 15 s"
}
running() {
  docker ps -q --filter "label=$LABEL"
}
nothing_running() {
  [[ -z "$(running)" ]] || fail "stand containers are running: $(docker ps --filter "label=$LABEL" --format '{{.Names}}' | xargs)"
}
compose() {
  local rev="$1"; shift
  PB_REV="$rev" PB_SRC="$BASE/src/$rev" docker compose -f "$BASE/docker-compose.yml" "$@"
}

guard_start() {
  if systemctl is-active --quiet "$GUARD_UNIT"; then
    echo "guard already running"
  else
    systemctl reset-failed "$GUARD_UNIT" >/dev/null 2>&1 || true
    # CPUQuota at one core: at 10 % the guard's own forks were throttled
    # for ~90 ms at a time, and that showed up as Hub's latency.
    systemd-run --unit="$GUARD_UNIT" --description="pb-stand guard (Project Browser stand)" \
      -p Restart=always -p RestartSec=2 -p MemoryMax=64M -p CPUQuota=100% \
      /bin/bash "$BASE/guard.sh" >/dev/null
  fi
  sleep 6
  cat "$BASE/guard/last"
}

guard_stop() {
  local ids
  ids="$(running)"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker stop -t 5 $ids >/dev/null
  systemctl stop "$GUARD_UNIT" 2>/dev/null || true
  echo "guard stopped"
}

apparmor_load() {
  # Not installed in /etc/apparmor.d: gone after a reboot.
  apparmor_parser -r "$BASE/security/apparmor-page-browser"
  grep '^page-browser ' /sys/kernel/security/apparmor/profiles
}

builder() {
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
    || docker buildx create --name "$BUILDER" --driver docker-container \
         --driver-opt cpu-period=100000 --driver-opt cpu-quota=200000 \
         --driver-opt memory=3g --driver-opt memory-swap=3g \
         --driver-opt restart-policy=no >/dev/null
  docker buildx inspect --bootstrap "$BUILDER" >/dev/null
}

build() {
  local kind="$1" rev="$2"
  guard_ok
  nothing_running
  builder
  case "$kind" in
    proto)
      local src="$BASE/src/$rev"
      [[ -d "$src" ]] || fail "no $src"
      docker buildx build --builder "$BUILDER" --load -t "pb-stand/server:$rev" \
        -f "$src/stand/server/Dockerfile" "$src/stand"
      docker buildx build --builder "$BUILDER" --load -t "pb-stand/browser:$rev" \
        --build-context chrome="$BASE/vendor" --build-context kasmvnc="$BASE/vendor" "$src"
      ;;
    pr2)
      local ctx="$BASE/ctx/$rev"
      [[ -d "$ctx" ]] || fail "no $ctx"
      docker buildx build --builder "$BUILDER" --load -t "pb-stand/page-browser:$rev" \
        --build-context vendor="$BASE/vendor" --label "agency-hub.page-browser.revision=$rev" \
        "$ctx/apps/page-browser"
      ;;
    *) fail "build proto|pr2 <rev>" ;;
  esac
  # The builder holds 2 CPU and 3 GB only while it builds.
  docker stop "buildx_buildkit_${BUILDER}0" >/dev/null
}

up() {
  local rev="$1"
  guard_ok
  grep -q '^page-browser ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile is not loaded (stand.sh apparmor-load)"
  [[ -z "$(docker ps -q --filter "label=$LABEL" --filter 'label=com.docker.compose.project=pb-stand-image')" ]] \
    || fail "the image check is running"
  mkdir -p "$BASE/results"
  compose "$rev" up -d
}

down() {
  docker compose -p pb-stand down
}

series() {
  local part="$1" name="$2"
  guard_ok
  docker exec -d -e SERIES="$name" pb-stand-runner-1 sh /pb/stand/runner/batch5.sh "$part"
  echo "series $name part $part started"
}

image_check() {
  local rev="$1" apparmor="${2:-page-browser}" health="" label failed=0
  # Not local: the EXIT trap's cleanup runs after this function returns.
  CTX="$BASE/ctx/$1"
  guard_ok
  nothing_running
  [[ -d "$CTX" ]] || fail "no $CTX"
  docker image inspect "pb-stand/page-browser:$rev" >/dev/null || fail "no image pb-stand/page-browser:$rev"
  docker network inspect "$CONTROL_NET" >/dev/null 2>&1 \
    || docker network create --internal --subnet 10.231.10.0/24 --label "$LABEL" "$CONTROL_NET" >/dev/null
  docker network inspect "$EGRESS_NET" >/dev/null 2>&1 \
    || docker network create --internal --subnet 10.231.11.0/24 -o com.docker.network.bridge.enable_icc=false --label "$LABEL" "$EGRESS_NET" >/dev/null

  WORK="$(mktemp -d)"
  PROFILE="$(cat /proc/sys/kernel/random/uuid)"
  mkdir -m 700 "$WORK/secrets"
  (umask 077; openssl rand -hex 16 > "$WORK/secrets/vnc_password")
  cat > "$WORK/page.env" <<EOF
PB_PAGE=stand-check
PB_IMAGE=pb-stand/page-browser:$rev
PB_PROFILE_ID=$PROFILE
PB_CONTROL_IP=10.231.10.250
PB_EGRESS_IP=10.231.11.250
PB_SOCKS_IP=192.0.2.10
PB_SOCKS_PORT=1080
PB_SYNC_IP=10.231.10.2
PB_API_IP=10.231.10.3
PB_TZ=Europe/Berlin
PB_LANG=en-US
PB_SECCOMP_PROFILE=$CTX/apps/page-browser/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=$apparmor
PB_SECRETS_DIR=$WORK/secrets
EOF
  # The production page file, in the stand's networks, labelled for the
  # guard and never restarted by Docker.
  # stand-route.sh: an on-link default route over the internal egress
  # network before /init (see there).
  [[ -x "$BASE/tools/busybox" ]] \
    || docker run --rm --network none -v "$BASE/tools:/out" busybox:1.37-musl cp /bin/busybox /out/busybox
  cat > "$WORK/stand.yml" <<EOF
services:
  browser:
    restart: "no"
    labels:
      agency.stand: pb-stand
    entrypoint: ["/stand/busybox", "sh", "/stand/stand-route.sh"]
    environment:
      STAND_EGRESS_IP: 10.231.11.250
    volumes:
      - $BASE/tools/busybox:/stand/busybox:ro
      - $BASE/stand-route.sh:/stand/stand-route.sh:ro
networks:
  pb-control:
    name: $CONTROL_NET
  pb-egress:
    name: $EGRESS_NET
EOF
  check_compose() {
    docker compose -p pb-stand-image -f "$CTX/docker-compose.page-browser.yml" -f "$WORK/stand.yml" --env-file "$WORK/page.env" "$@"
  }
  # shellcheck disable=SC2329
  cleanup() {
    check_compose down >/dev/null 2>&1 || true
    docker volume rm "pb-profile-$PROFILE" "pb-buffer-$PROFILE" >/dev/null 2>&1 || true
    rm -f "$WORK/secrets/vnc_password" "$WORK/page.env" "$WORK/stand.yml"
    rmdir "$WORK/secrets" "$WORK" 2>/dev/null || true
  }
  trap cleanup EXIT
  docker volume create --label "$LABEL" "pb-profile-$PROFILE" >/dev/null
  docker volume create --label "$LABEL" "pb-buffer-$PROFILE" >/dev/null

  run_check() {
    label="$1"
    for _ in $(seq 1 60); do
      health="$(docker inspect -f '{{.State.Health.Status}}' page-browser-stand-check 2>/dev/null || true)"
      [[ "$health" == "starting" || -z "$health" ]] || break
      sleep 1
    done
    echo "[image-check] $label: AppArmor $(docker inspect -f '{{.AppArmorProfile}}' page-browser-stand-check), PID 1 $(docker exec page-browser-stand-check cat /proc/1/attr/current 2>/dev/null | tr -d '\0'), health $health" >&2
    if [[ "$health" != "healthy" ]]; then
      docker logs page-browser-stand-check 2>&1 | tail -30 >&2
      return 1
    fi
    docker cp "$CTX/apps/page-browser/stand/image-check.mjs" page-browser-stand-check:/tmp/image-check.mjs >/dev/null
    docker exec page-browser-stand-check chmod 644 /tmp/image-check.mjs
    docker exec page-browser-stand-check /command/s6-setuidgid pb-operator node --no-warnings /tmp/image-check.mjs
  }
  check_compose up -d >/dev/null 2>&1
  run_check "first start, new profile" || failed=1
  check_compose up -d --force-recreate >/dev/null 2>&1
  run_check "recreated, same profile" || failed=1
  (( failed == 0 )) && echo "[image-check] passed" >&2 || { echo "[image-check] FAILED" >&2; return 1; }
}

status() {
  systemctl is-active "$GUARD_UNIT" || true
  cat "$BASE/guard/last" 2>/dev/null || true
  [[ -f "$BASE/guard/TRIPPED" ]] && echo "TRIPPED: $(tail -1 "$BASE/guard/TRIPPED")"
  docker ps -a --filter "label=$LABEL" --format '{{.Names}}\t{{.Status}}'
  # shellcheck disable=SC2046
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $(running) 2>/dev/null || true
}

remove() {
  local ids
  ids="$(docker ps -aq --filter "label=$LABEL")"
  docker compose -p pb-stand down -v 2>/dev/null || true
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker rm -f $ids >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=$LABEL" | xargs -r docker volume rm >/dev/null
  docker network rm "$CONTROL_NET" "$EGRESS_NET" >/dev/null 2>&1 || true
  docker buildx rm "$BUILDER" >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' | grep '^pb-stand/' | xargs -r docker rmi >/dev/null
  apparmor_parser -R "$BASE/security/apparmor-page-browser" 2>/dev/null || true
  systemctl stop "$GUARD_UNIT" 2>/dev/null || true
  echo "stand removed; results stay in $BASE/results"
}

command="${1:-}"
shift || true
case "$command" in
  guard-start) guard_start ;;
  guard-stop) guard_stop ;;
  clear-trip) rm -f "$BASE/guard/TRIPPED"; echo "trip cleared" ;;
  apparmor-load) apparmor_load ;;
  build) build "${1:?proto|pr2}" "${2:?the revision}" ;;
  up) up "${1:?the revision}" ;;
  down) down ;;
  series) series "${1:?the part}" "${2:?the series name}" ;;
  image-check) image_check "${1:?the revision}" "${2:-page-browser}" ;;
  status) status ;;
  remove) remove ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
