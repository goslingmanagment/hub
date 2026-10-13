#!/usr/bin/env bash
# The stand of plan §5, stage 2 (stage 3, PR 19): failure series and the
# load test against the production page image and operator. One script for
# the workstation's Docker Desktop and for the server (owner's decision
# №14); see README.md.
#
#   stand.sh build                          the tools image and the page image of this tree
#   stand.sh up <stand> [--profiles N] [--net A.B]
#                                           the stand: Postgres, Fansly, proxy, runner,
#                                           pages p1…pN and the disk page (created, stopped)
#   stand.sh series <stand> <name> [--wait] [-- <series.ts options>]
#   stand.sh load <stand> <name> [--wait] [-- <load.ts options>]
#   stand.sh verify <stand> <name>          the verdict of a finished series
#   stand.sh status [<stand>]
#   stand.sh down <stand>                   everything of that stand but its results
#   stand.sh guard-start | guard-stop | clear-trip | apparmor-load   (server)
#
# Nothing of the stand starts on the server while the guard (guard.sh) is
# not watching Hub, or after it tripped. Every container, network and volume
# of a stand carries the labels agency.stand=pb-suite and
# agency.stand.name=pb-suite-<stand>; this script touches nothing else.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$SRC/../.." && pwd)"
STAND_DIR="$SRC/stand"
LABEL=agency.stand=pb-suite
GUARD_UNIT=pb-suite-guard
BUILDER=pb-suite-builder

fail() {
  echo "stand: $*" >&2
  exit 1
}
log() { printf '[stand] %s\n' "$*" >&2; }

# ── where: the workstation or the server ──────────────────────────────────

if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -q 'Docker Desktop'; then
  MODE=local
  PB_SUITE_HOME="${PB_SUITE_HOME:-$HOME/code/.cache/pb-suite}"
else
  MODE=server
  PB_SUITE_HOME="${PB_SUITE_HOME:-/opt/pb-suite}"
fi
GUARD_DIR="$PB_SUITE_HOME/guard"

if [[ -f "$ROOT/.pb-suite-rev" ]]; then
  REV="$(cat "$ROOT/.pb-suite-rev")"
elif git -C "$ROOT" rev-parse --short=12 HEAD >/dev/null 2>&1; then
  REV="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
  [[ -z "$(git -C "$ROOT" status --porcelain -- apps/page-browser docker-compose.page-browser.yml)" ]] || REV="$REV-dirty"
else
  REV=dev
fi
TOOLS_IMAGE="pb-suite/tools:$REV"
PAGE_IMAGE="pb-suite/page-browser:$REV"

guard_ok() {
  [[ "$MODE" == server ]] || return 0
  systemctl is-active --quiet "$GUARD_UNIT" || fail "the guard is not running (stand.sh guard-start)"
  [[ ! -f "$GUARD_DIR/TRIPPED" ]] || fail "the guard tripped: $(tail -1 "$GUARD_DIR/TRIPPED")"
  [[ -n "$(find "$GUARD_DIR/last" -newermt '15 seconds ago' 2>/dev/null)" ]] || fail "the guard has not measured for 15 s"
}

stand_vars() {
  local stand="$1"
  [[ "$stand" =~ ^[a-z0-9][a-z0-9-]{0,20}$ ]] || fail "a stand's name: lowercase letters, digits, dashes"
  PROJECT="pb-suite-$stand"
  WORK="$PB_SUITE_HOME/stands/$stand"
}

infra() {
  # shellcheck disable=SC1091
  docker compose -p "$PROJECT" -f "$STAND_DIR/docker-compose.yml" --env-file "$WORK/stand.env" "$@"
}

page_compose() {
  local page="$1"
  shift
  docker compose -p "$PROJECT-$page" -f "$ROOT/docker-compose.page-browser.yml" -f "$STAND_DIR/page.stand.yml" --env-file "$WORK/pages/$page/page.env" "$@"
}

runner() {
  echo "$PROJECT-runner-1"
}

# ── build ─────────────────────────────────────────────────────────────────

build() {
  guard_ok
  local vendor tmp=""
  if [[ "$MODE" == local ]]; then
    local cache="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    cp "$cache"/chrome/*.deb "$cache"/kasmvnc/*.deb "$cache"/s6-overlay/*.tar.xz "$tmp"/
    vendor="$tmp"
    log "building $TOOLS_IMAGE"
    docker build -q -t "$TOOLS_IMAGE" -f "$STAND_DIR/Dockerfile.tools" "$STAND_DIR" >/dev/null
    log "building $PAGE_IMAGE"
    docker build -q --build-context vendor="$vendor" --build-arg OPERATOR_VERSION="$REV" -t "$PAGE_IMAGE" "$SRC" >/dev/null
  else
    vendor="$PB_SUITE_HOME/vendor"
    [[ -z "$(docker ps -q --filter "label=$LABEL")" ]] || fail "stand containers are running: builds wait for them"
    docker buildx inspect "$BUILDER" >/dev/null 2>&1 \
      || docker buildx create --name "$BUILDER" --driver docker-container \
           --driver-opt cpu-period=100000 --driver-opt cpu-quota=200000 \
           --driver-opt memory=3g --driver-opt memory-swap=3g \
           --driver-opt restart-policy=no >/dev/null
    docker buildx inspect --bootstrap "$BUILDER" >/dev/null
    log "building $TOOLS_IMAGE"
    docker buildx build --builder "$BUILDER" --load -t "$TOOLS_IMAGE" -f "$STAND_DIR/Dockerfile.tools" "$STAND_DIR"
    log "building $PAGE_IMAGE"
    docker buildx build --builder "$BUILDER" --load --build-context vendor="$vendor" --build-arg OPERATOR_VERSION="$REV" -t "$PAGE_IMAGE" "$SRC"
    # The builder holds its CPUs and memory only while it builds.
    docker stop "buildx_buildkit_${BUILDER}0" >/dev/null
  fi
  log "built $TOOLS_IMAGE and $PAGE_IMAGE"
}

# ── up ────────────────────────────────────────────────────────────────────

up() {
  local stand="$1"
  shift
  local profiles=1 net="10.233"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --profiles) profiles="$2"; shift 2 ;;
      --net) net="$2"; shift 2 ;;
      *) fail "up: unknown option $1" ;;
    esac
  done
  [[ "$profiles" =~ ^[1-9]$ ]] || fail "--profiles: 1 to 9"
  [[ "$net" =~ ^10\.[0-9]{1,3}$ ]] || fail "--net: 10.<n> (the stand takes 10.<n>.0.0/24 and 10.<n>.1.0/24)"
  stand_vars "$stand"
  guard_ok
  if [[ "$MODE" == server ]]; then
    grep -q '^page-browser ' /sys/kernel/security/apparmor/profiles || fail "the AppArmor profile is not loaded (stand.sh apparmor-load)"
  fi
  docker image inspect "$TOOLS_IMAGE" "$PAGE_IMAGE" >/dev/null 2>&1 || fail "no $TOOLS_IMAGE or $PAGE_IMAGE: stand.sh build"
  [[ -z "$(docker ps -aq --filter "label=agency.stand.name=$PROJECT")" ]] || fail "$PROJECT exists already: stand.sh down $stand"
  for subnet in "$net.0.0/24" "$net.1.0/24"; do
    if docker network ls -q | xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' | grep -q " $subnet "; then
      fail "the subnet $subnet is taken by another network: --net another"
    fi
  done

  mkdir -p "$WORK/secrets" "$WORK/pages" "$WORK/results"
  chmod 700 "$WORK/secrets"
  (umask 077; openssl rand -hex 24 > "$WORK/secrets/stand_socks_password")
  chmod 644 "$WORK/secrets/stand_socks_password"

  local control="$net.0" egress="$net.1"
  local pages=() containers="$PROJECT-postgres-1" json_pages="" n=0
  for i in $(seq 1 "$profiles"); do pages+=("p$i"); done
  pages+=(disk)
  for page in "${pages[@]}"; do
    n=$((n + 1))
    local profile buffer_kind=volume octet=$((100 + n))
    profile="$(openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
    mkdir -p "$WORK/pages/$page/secrets"
    chmod 700 "$WORK/pages/$page/secrets"
    (umask 077; openssl rand -hex 16 > "$WORK/pages/$page/secrets/vnc_password"; openssl rand -hex 32 > "$WORK/pages/$page/secrets/rpc_token")
    # The runner reads the page's RPC token (it plays the engine).
    chmod 644 "$WORK/pages/$page/secrets/rpc_token"
    docker volume create --label "$LABEL" --label "agency.stand.name=$PROJECT" "pb-profile-$profile" >/dev/null
    if [[ "$page" == disk ]]; then
      buffer_kind=tmpfs
      # The disk page's buffer: a fixed-size tmpfs — a full disk is made
      # only here, never on a disk of the host (owner's decision №14).
      docker volume create --label "$LABEL" --label "agency.stand.name=$PROJECT" --driver local \
        --opt type=tmpfs --opt device=tmpfs --opt o=size=640m,mode=0700 "pb-buffer-$profile" >/dev/null
    else
      docker volume create --label "$LABEL" --label "agency.stand.name=$PROJECT" "pb-buffer-$profile" >/dev/null
    fi
    cat > "$WORK/pages/$page/page.env" <<EOF
PB_PAGE=$PROJECT-$page
PB_IMAGE=$PAGE_IMAGE
PB_PROFILE_ID=$profile
PB_CONTROL_IP=$control.$octet
PB_EGRESS_IP=$egress.$octet
PB_SOCKS_IP=$egress.10
PB_SOCKS_PORT=1080
PB_SYNC_IP=$control.20
PB_API_IP=$control.3
PB_TZ=Europe/Berlin
PB_LANG=en-US
PB_SECCOMP_PROFILE=$SRC/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=$([[ "$MODE" == local ]] && echo unconfined || echo page-browser)
PB_SECRETS_DIR=$WORK/pages/$page/secrets
PB_SUITE_PROJECT=$PROJECT
PB_SUITE_PAGE=$page
PB_SUITE_SRC=$SRC
PB_SUITE_WORK=$WORK
PB_SUITE_TOOLS_IMAGE=$TOOLS_IMAGE
EOF
    containers="$containers,$PROJECT-page-$page,$PROJECT-capture-$page"
    json_pages="$json_pages${json_pages:+,}{\"name\":\"$page\",\"pageId\":$n,\"container\":\"$PROJECT-page-$page\",\"capture\":\"$PROJECT-capture-$page\",\"controlIp\":\"$control.$octet\",\"egressIp\":\"$egress.$octet\",\"buffer\":\"$buffer_kind\"}"
  done
  cat > "$WORK/stand.json" <<EOF
{"socksIp":"$egress.10","socksPort":1080,"engineIp":"$control.20","rpcPort":7700,"pages":[$json_pages]}
EOF
  cat > "$WORK/stand.env" <<EOF
PB_SUITE_PROJECT=$PROJECT
PB_SUITE_NET_CONTROL=$control
PB_SUITE_NET_EGRESS=$egress
PB_SUITE_SRC=$SRC
PB_SUITE_WORK=$WORK
PB_SUITE_TOOLS_IMAGE=$TOOLS_IMAGE
PB_SUITE_PAGE_IMAGE=$PAGE_IMAGE
PB_SUITE_REV=$REV
PB_SUITE_PROXY_CONTAINERS=$containers
EOF

  log "starting $PROJECT (revision $REV, $MODE)"
  infra up -d --wait >/dev/null
  for page in "${pages[@]}"; do
    if [[ "$page" == disk ]]; then
      # Started by the runner only for its scenarios.
      page_compose "$page" create >/dev/null 2>&1
    else
      page_compose "$page" up -d >/dev/null 2>&1
    fi
  done
  for page in "${pages[@]}"; do
    [[ "$page" == disk ]] && continue
    local health=""
    for _ in $(seq 1 90); do
      health="$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-page-$page" 2>/dev/null || true)"
      [[ "$health" == starting || -z "$health" ]] || break
      sleep 1
    done
    [[ "$health" == healthy ]] || { docker logs "$PROJECT-page-$page" 2>&1 | tail -40 >&2; fail "$PROJECT-page-$page is $health"; }
  done
  log "the stand's isolation and trust"
  docker exec "$(runner)" node --no-warnings /pb/stand/runner/isolation.ts
  log "up: $PROJECT, pages ${pages[*]}; results in $WORK/results"
}

# ── runs ──────────────────────────────────────────────────────────────────

in_runner() {
  local stand="$1" script="$2" name="$3" wait="$4"
  shift 4
  stand_vars "$stand"
  guard_ok
  [[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "a series' name: letters, digits, . _ -"
  local cmd="node --no-warnings /pb/stand/runner/$script --name $name"
  for arg in "$@"; do cmd="$cmd $(printf '%q' "$arg")"; done
  if [[ "$wait" == yes ]]; then
    docker exec "$(runner)" sh -c "$cmd 2>&1 | tee /stand/results/$script-$name.log"
  else
    docker exec -d "$(runner)" sh -c "$cmd > /stand/results/$script-$name.log 2>&1"
    log "started: $WORK/results/$script-$name.log; verdict: stand.sh verify $stand $name"
  fi
}

run_cmd() {
  local script="$1" stand="${2:?the stand}" name="${3:?a name}" wait=no
  shift 3
  local rest=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --wait) wait=yes; shift ;;
      --) shift; rest+=("$@"); break ;;
      *) rest+=("$1"); shift ;;
    esac
  done
  in_runner "$stand" "$script" "$name" "$wait" "${rest[@]+"${rest[@]}"}"
}

verify() {
  stand_vars "${1:?the stand}"
  docker exec "$(runner)" node --no-warnings /pb/stand/runner/verify.ts "/stand/results/series/${2:?the series}"
}

status() {
  if [[ "$MODE" == server ]]; then
    systemctl is-active "$GUARD_UNIT" || true
    cat "$GUARD_DIR/last" 2>/dev/null || true
    [[ -f "$GUARD_DIR/TRIPPED" ]] && echo "TRIPPED: $(tail -1 "$GUARD_DIR/TRIPPED")"
  fi
  local filter="label=$LABEL"
  [[ -n "${1:-}" ]] && { stand_vars "$1"; filter="label=agency.stand.name=$PROJECT"; }
  docker ps -a --filter "$filter" --format '{{.Names}}\t{{.Status}}'
  # shellcheck disable=SC2046
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $(docker ps -q --filter "$filter") 2>/dev/null || true
}

down() {
  stand_vars "${1:?the stand}"
  [[ -d "$WORK" ]] || fail "no stand $1"
  for env in "$WORK"/pages/*/page.env; do
    [[ -f "$env" ]] || continue
    local page
    page="$(basename "$(dirname "$env")")"
    page_compose "$page" down >/dev/null 2>&1 || true
  done
  [[ -f "$WORK/stand.env" ]] && infra down -v >/dev/null 2>&1 || true
  local ids
  ids="$(docker ps -aq --filter "label=agency.stand.name=$PROJECT")"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker rm -f $ids >/dev/null
  docker volume ls -q --filter "label=agency.stand.name=$PROJECT" | xargs -r docker volume rm >/dev/null
  rm -rf "$WORK/secrets" "$WORK/pages" "$WORK/stand.env" "$WORK/stand.json"
  log "$PROJECT removed; its results stay in $WORK/results"
}

# ── the server ────────────────────────────────────────────────────────────

server_only() {
  [[ "$MODE" == server ]] || fail "$1: only on the server"
}

guard_start() {
  server_only guard-start
  mkdir -p "$GUARD_DIR"
  if systemctl is-active --quiet "$GUARD_UNIT"; then
    echo "guard already running"
  else
    systemctl reset-failed "$GUARD_UNIT" >/dev/null 2>&1 || true
    # A whole core: a probe under a tight quota measures its own throttling
    # (stage 2 finding 4).
    systemd-run --unit="$GUARD_UNIT" --description="pb-suite guard (Project Browser stand suites)" \
      -p Restart=always -p RestartSec=2 -p MemoryMax=64M -p CPUQuota=100% \
      --setenv=PB_GUARD_DIR="$GUARD_DIR" /bin/bash "$STAND_DIR/guard.sh" >/dev/null
  fi
  sleep 6
  cat "$GUARD_DIR/last"
}

guard_stop() {
  server_only guard-stop
  local ids
  ids="$(docker ps -q --filter "label=$LABEL")"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker stop -t 5 $ids >/dev/null
  systemctl stop "$GUARD_UNIT" 2>/dev/null || true
  echo "guard stopped"
}

apparmor_load() {
  server_only apparmor-load
  # Not installed in /etc/apparmor.d: gone after a reboot.
  apparmor_parser -r "$SRC/security/apparmor-page-browser"
  grep '^page-browser ' /sys/kernel/security/apparmor/profiles
}

command="${1:-}"
shift || true
case "$command" in
  build) build ;;
  up) up "${1:?the stand}" "${@:2}" ;;
  series) run_cmd series.ts "$@" ;;
  load) run_cmd load.ts "$@" ;;
  verify) verify "$@" ;;
  status) status "${1:-}" ;;
  down) down "${1:-}" ;;
  guard-start) guard_start ;;
  guard-stop) guard_stop ;;
  clear-trip) server_only clear-trip; rm -f "$GUARD_DIR/TRIPPED"; echo "trip cleared" ;;
  apparmor-load) apparmor_load ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
