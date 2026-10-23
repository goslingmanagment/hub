#!/usr/bin/env bash
# The stand's publish capture on the server (docs/plans/2026-10-23-wall-posts,
# plan PR 0.1; the session's runbook: stand-session-0.2.md next to the plan).
# One page of the production image of this tree, its rules extension built
# with the capture (Dockerfile here), the test account's own profile, the
# test proxy as its SOCKS5, and the stand's engine (engine.ts), which starts
# the page and sends no request of Hub's. A person works the site on the
# page's screen; the operator journals the site's publishing requests
# (publish-<day>.jsonl in the page's buffer volume).
#
#   capture.sh build              pb-suite/page-browser-capture:<rev>, over this
#                                 tree's page image (stand.sh build first)
#   capture.sh exit-ip            the test proxy's exit IP as api.ipify.org sees
#                                 it through the SOCKS5 of settings.json
#   capture.sh up [--net 10.N]    the page and the engine (10.N.0/24, 10.N.1/24)
#   capture.sh screen             how to reach the page's screen from the Mac
#   capture.sh status
#   capture.sh collect            the journals into results/<UTC time>/
#   capture.sh down               the page stopped and removed, the networks
#                                 gone; its volumes, settings and results stay
#   capture.sh forget             the test account's profile and buffer volumes
#                                 deleted — only on the owner's word
#
# Everything lives in $PB_CAPTURE_HOME (/opt/pb-suite/capture): settings.json
# (the test proxy and the page's environment: root's, 600, written before
# `up`), media/ (the files the person posts), secrets/, results/, the
# profile's id. Nothing starts while the stand's guard is not watching Hub
# (stand.sh guard-start), or after it tripped.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
ROOT="$(cd "$SRC/../.." && pwd)"
WORK="${PB_CAPTURE_HOME:-/opt/pb-suite/capture}"
GUARD_DIR="${PB_SUITE_HOME:-/opt/pb-suite}/guard"
GUARD_UNIT=pb-suite-guard
PROJECT=pb-publish-capture
PAGE_CONTAINER=pb-publish-capture-page
PROFILE_VOLUME=pb-publish-capture-profile
BUFFER_VOLUME=pb-publish-capture-buffer
LABEL=agency.stand=pb-suite

if [[ -f "$ROOT/.pb-suite-rev" ]]; then
  REV="$(cat "$ROOT/.pb-suite-rev")"
else
  REV="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo dev)"
fi
BASE_IMAGE="pb-suite/page-browser:$REV"
TOOLS_IMAGE="pb-suite/tools:$REV"
IMAGE="pb-suite/page-browser-capture:$REV"

fail() {
  echo "capture: $*" >&2
  exit 1
}
log() { printf '[capture] %s\n' "$*" >&2; }

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

guard_ok() {
  systemctl is-active --quiet "$GUARD_UNIT" || fail "the stand's guard is not running ($SRC/stand/stand.sh guard-start)"
  [[ ! -f "$GUARD_DIR/TRIPPED" ]] || fail "the guard tripped: $(tail -1 "$GUARD_DIR/TRIPPED")"
  (( $(date +%s) - $(mtime "$GUARD_DIR/last") <= 15 )) || fail "the guard has not measured for 15 s"
}

setting() {
  jq -er "$1" "$WORK/settings.json" 2>/dev/null || fail "settings.json: no $1"
}

infra() {
  docker compose -p "$PROJECT" -f "$HERE/docker-compose.yml" --env-file "$WORK/stand.env" "$@"
}

page_compose() {
  docker compose -p "$PROJECT-page" -f "$ROOT/docker-compose.page-browser.yml" -f "$HERE/page.capture.yml" --env-file "$WORK/page.env" "$@"
}

build() {
  guard_ok
  docker image inspect "$BASE_IMAGE" "$TOOLS_IMAGE" >/dev/null 2>&1 || fail "no $BASE_IMAGE or $TOOLS_IMAGE: $SRC/stand/stand.sh build first"
  # One RUN over a local image: the default builder, which sees the
  # daemon's images (the stand's BuildKit container does not).
  log "building $IMAGE over $BASE_IMAGE"
  docker build -q --builder default --build-arg BASE="$BASE_IMAGE" --build-arg OPERATOR_VERSION="$REV" -t "$IMAGE" "$HERE" >/dev/null
  # The capture is in it: its marker, and more rules than the base's.
  docker run --rm --network none --entrypoint /bin/sh "$IMAGE" -c 'test -s /opt/page-browser/extension/dist/publish-capture.json' \
    || fail "$IMAGE has no capture marker"
  docker run --rm --network none --entrypoint /bin/sh "$BASE_IMAGE" -c 'test ! -e /opt/page-browser/extension/dist/publish-capture.json' \
    || fail "$BASE_IMAGE has a capture marker: it is no production image"
  log "built $IMAGE"
}

exit_ip() {
  [[ -f "$WORK/settings.json" ]] || fail "no $WORK/settings.json"
  local ip port user pass
  ip="$(setting .socks5.ip)"
  port="$(setting .socks5.port)"
  user="$(setting .socks5.username)"
  pass="$(setting .socks5.password)"
  # The login goes in curl's config on its standard input: never in a
  # command line.
  printf 'proxy = "socks5h://%s:%s"\nproxy-user = "%s:%s"\n' "$ip" "$port" "$user" "$pass" \
    | curl -sS --max-time 20 -K - https://api.ipify.org
  echo
}

up() {
  local net="10.234"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --net) net="$2"; shift 2 ;;
      *) fail "up: unknown option $1" ;;
    esac
  done
  [[ "$net" =~ ^10\.[0-9]{1,3}$ ]] || fail "--net: 10.<n>"
  guard_ok
  grep -q '^page-browser ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile page-browser is not loaded"
  docker image inspect "$IMAGE" "$TOOLS_IMAGE" >/dev/null 2>&1 || fail "no $IMAGE or $TOOLS_IMAGE: capture.sh build"
  [[ -z "$(docker ps -aq --filter "label=agency.stand.name=$PROJECT")" ]] || fail "$PROJECT exists already: capture.sh down"
  [[ -f "$WORK/settings.json" ]] || fail "no $WORK/settings.json (the runbook says what goes in it)"
  [[ "$(stat -c %a "$WORK/settings.json")" == 600 ]] || fail "$WORK/settings.json must be 600"
  local socks_ip socks_port zone lang
  socks_ip="$(setting .socks5.ip)"
  socks_port="$(setting .socks5.port)"
  setting .pinnedExitIp >/dev/null
  zone="$(setting .env.timeZone)"
  lang="$(setting '.env.languages[0]')"
  [[ -n "$(find "$WORK/media" -maxdepth 1 -type f 2>/dev/null | head -1)" ]] || fail "no files in $WORK/media to post"
  for subnet in "$net.0.0/24" "$net.1.0/24"; do
    if docker network ls -q | xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' | grep -q " $subnet "; then
      fail "the subnet $subnet is taken: --net another"
    fi
  done

  mkdir -p "$WORK/secrets" "$WORK/results"
  chmod 700 "$WORK" "$WORK/secrets"
  # The page's files are read by Chrome's user in the container.
  chmod 755 "$WORK/media"
  find "$WORK/media" -maxdepth 1 -type f -exec chmod 644 {} +
  for secret in vnc_password rpc_token api_token; do
    [[ -s "$WORK/secrets/$secret" ]] || (umask 077; openssl rand -hex 24 > "$WORK/secrets/$secret")
  done
  [[ -s "$WORK/profile-id" ]] || openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/' > "$WORK/profile-id"
  for volume in "$PROFILE_VOLUME" "$BUFFER_VOLUME"; do
    docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create --label "$LABEL" --label "agency.stand.name=$PROJECT" "$volume" >/dev/null
  done
  cat > "$WORK/stand.env" <<EOF
PB_CAPTURE_NET=$net
PB_CAPTURE_WORK=$WORK
PB_SUITE_SRC=$SRC
PB_SUITE_TOOLS_IMAGE=$TOOLS_IMAGE
EOF
  cat > "$WORK/page.env" <<EOF
PB_PAGE=$PROJECT
PB_IMAGE=$IMAGE
PB_PROFILE_ID=$(cat "$WORK/profile-id")
PB_CONTROL_IP=$net.0.10
PB_EGRESS_IP=$net.1.10
PB_SOCKS_IP=$socks_ip
PB_SOCKS_PORT=$socks_port
PB_SYNC_IP=$net.0.20
PB_API_IP=$net.0.1
PB_TZ=$zone
PB_LANG=$lang
PB_SCREEN=1920x1080
PB_FONTS=base
PB_SECCOMP_PROFILE=$SRC/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=page-browser
PB_SECRETS_DIR=$WORK/secrets
PB_CAPTURE_MEDIA=$WORK/media
EOF

  log "starting $PROJECT ($IMAGE)"
  infra up --no-start >/dev/null
  # The host reaches the page's screen on the control network's gateway.
  [[ "$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "${PROJECT}_control")" == "$net.0.1" ]] \
    || fail "${PROJECT}_control has no gateway $net.0.1: the screen would not be reachable"
  page_compose up -d >/dev/null
  local health=""
  for _ in $(seq 1 90); do
    health="$(docker inspect -f '{{.State.Health.Status}}' "$PAGE_CONTAINER" 2>/dev/null || true)"
    [[ "$health" == starting || -z "$health" ]] || break
    sleep 1
  done
  [[ "$health" == healthy ]] || { docker logs "$PAGE_CONTAINER" 2>&1 | tail -40 >&2; fail "$PAGE_CONTAINER is $health"; }
  infra start engine >/dev/null
  log "up: the engine starts the page; its journal: $WORK/results/engine.jsonl"
  screen
}

screen() {
  local ip
  ip="$(sed -n 's/^PB_CONTROL_IP=//p' "$WORK/page.env" 2>/dev/null)"
  if [[ -z "$ip" ]] || ! docker ps -q --filter "name=^${PAGE_CONTAINER}\$" | grep -q .; then
    fail "$PAGE_CONTAINER is not up"
  fi
  cat <<EOF
The page's screen, from the Mac:
  ssh -N -L 16901:$ip:6901 root@<server>
  then http://localhost:16901 — user: owner, password: the one line of
  $WORK/secrets/vnc_password (ssh root@<server> cat $WORK/secrets/vnc_password)
The test media are in the file dialog under Home → Media.
EOF
}

status() {
  systemctl is-active "$GUARD_UNIT" || true
  cat "$GUARD_DIR/last" 2>/dev/null || true
  [[ -f "$GUARD_DIR/TRIPPED" ]] && echo "TRIPPED: $(tail -1 "$GUARD_DIR/TRIPPED")"
  docker ps -a --filter "label=agency.stand.name=$PROJECT" --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  # shellcheck disable=SC2046
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $(docker ps -q --filter "label=agency.stand.name=$PROJECT") 2>/dev/null || true
  [[ -f "$WORK/results/engine.jsonl" ]] && { echo "--- the engine's last states"; grep -E '"kind":"(state|alarm|halt_held|command_result)"' "$WORK/results/engine.jsonl" | tail -5; }
  return 0
}

collect() {
  docker volume inspect "$BUFFER_VOLUME" >/dev/null 2>&1 || fail "no $BUFFER_VOLUME"
  local dir
  dir="$WORK/results/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$dir/logs"
  # The journals as the operator wrote them (a day that ended is .gz):
  # publish (the capture), requests, connections, states, sockets.
  docker run --rm --network none -v "$BUFFER_VOLUME:/b:ro" -v "$dir/logs:/out" --entrypoint /bin/sh "$TOOLS_IMAGE" \
    -c 'cp -a /b/logs/. /out/ && chown -R 0:0 /out'
  [[ -f "$WORK/results/engine.jsonl" ]] && cp "$WORK/results/engine.jsonl" "$dir/"
  chmod -R go-rwx "$dir"
  log "collected: $dir ($(du -sh "$dir" | cut -f1)); read it with stand/publish-capture/read.ts"
  echo "$dir"
}

down() {
  [[ -f "$WORK/stand.env" ]] || fail "no stand here ($WORK/stand.env)"
  # The engine stops the page (stopPage) on its way out.
  infra stop engine >/dev/null 2>&1 || true
  [[ -f "$WORK/page.env" ]] && page_compose down >/dev/null 2>&1 || true
  infra down >/dev/null 2>&1 || true
  local ids
  ids="$(docker ps -aq --filter "label=agency.stand.name=$PROJECT")"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker rm -f $ids >/dev/null
  log "$PROJECT is down; kept: the volumes $PROFILE_VOLUME and $BUFFER_VOLUME, $WORK (settings, media, results)"
}

forget() {
  [[ -z "$(docker ps -aq --filter "label=agency.stand.name=$PROJECT")" ]] || fail "$PROJECT still exists: capture.sh down first"
  [[ "${1:-}" == --owner-said-yes ]] || fail "the test account's profile and buffer are deleted only on the owner's word: forget --owner-said-yes"
  docker volume rm "$PROFILE_VOLUME" "$BUFFER_VOLUME"
  rm -f "$WORK/profile-id"
  log "the volumes are deleted; $WORK stays"
}

command="${1:-}"
shift || true
case "$command" in
  build) build ;;
  exit-ip) exit_ip ;;
  up) up "$@" ;;
  screen) screen ;;
  status) status ;;
  collect) collect ;;
  down) down ;;
  forget) forget "$@" ;;
  *) sed -n '2,28p' "$0"; exit 2 ;;
esac
