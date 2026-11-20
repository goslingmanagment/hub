#!/usr/bin/env bash
# The stand's images and its guard (owner's decision №14): the tools image
# and the page image of this tree, which the publish capture builds on
# (publish-capture/capture.sh), and on the server the guard that watches Hub
# while anything of the stand runs. One script for the workstation's Docker
# Desktop and for the server; see README.md.
#
#   stand.sh build                          the tools image and the page image of this tree
#   stand.sh guard-start | guard-stop | clear-trip | apparmor-load | builder-remove   (server)
#
# Nothing of the stand starts on the server while the guard (guard.sh) is
# not watching Hub, or after it tripped. Every container of the stand
# carries the label agency.stand=pb-suite; this script touches nothing else
# but the builds' BuildKit container (by its name).
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

# A file's modification time, seconds (GNU stat, then BSD's).
mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

guard_ok() {
  [[ "$MODE" == server ]] || return 0
  systemctl is-active --quiet "$GUARD_UNIT" || fail "the guard is not running (stand.sh guard-start)"
  [[ ! -f "$GUARD_DIR/TRIPPED" ]] || fail "the guard tripped: $(tail -1 "$GUARD_DIR/TRIPPED")"
  (( $(date +%s) - $(mtime "$GUARD_DIR/last") <= 15 )) || fail "the guard has not measured for 15 s"
}

# ── build ─────────────────────────────────────────────────────────────────

# The server's builds run in one BuildKit container, named so that this
# script and the guard find it: buildx_buildkit_<BUILDER>0. It has no
# stand label (buildx sets none), so it is stopped by name — after a build,
# on any exit of one, by guard-stop, and by the guard when it trips.
BUILDER_CONTAINER="buildx_buildkit_${BUILDER}0"

stop_builder() {
  if docker ps -q --filter "name=^${BUILDER_CONTAINER}\$" | grep -q .; then
    docker stop -t 2 "$BUILDER_CONTAINER" >/dev/null 2>&1 || true
    log "the builder is stopped"
  fi
}

build() {
  guard_ok
  local vendor
  if [[ "$MODE" == local ]]; then
    local cache="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"
    BUILD_TMP="$(mktemp -d)"
    trap 'rm -rf "$BUILD_TMP"' EXIT
    cp "$cache"/chrome/*.deb "$cache"/kasmvnc/*.deb "$cache"/s6-overlay/*.tar.xz "$BUILD_TMP"/
    vendor="$BUILD_TMP"
    log "building $TOOLS_IMAGE"
    docker build -q -t "$TOOLS_IMAGE" -f "$STAND_DIR/Dockerfile.tools" "$STAND_DIR" >/dev/null
    log "building $PAGE_IMAGE"
    docker build -q --build-context vendor="$vendor" --build-arg OPERATOR_VERSION="$REV" -t "$PAGE_IMAGE" "$SRC" >/dev/null
  else
    vendor="$PB_SUITE_HOME/vendor"
    [[ -z "$(docker ps -q --filter "label=$LABEL")" ]] || fail "stand containers are running: builds wait for them"
    # However the build ends — done, failed, interrupted — the builder does
    # not stay running: it holds 2 CPU and 3 GB only while it builds.
    trap stop_builder EXIT
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
  fi
  log "built $TOOLS_IMAGE and $PAGE_IMAGE"
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
  # Nothing of the stand runs unwatched: the builder too, before the guard goes.
  stop_builder
  [[ -z "$(docker ps -q --filter "label=$LABEL")$(docker ps -q --filter "name=^${BUILDER_CONTAINER}\$")" ]] || fail "stand containers or the builder still run: the guard stays"
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
  guard-start) guard_start ;;
  guard-stop) guard_stop ;;
  clear-trip) server_only clear-trip; rm -f "$GUARD_DIR/TRIPPED"; echo "trip cleared" ;;
  apparmor-load) apparmor_load ;;
  builder-remove) server_only builder-remove; stop_builder; docker buildx rm "$BUILDER" >/dev/null 2>&1 || true; echo "builder removed" ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
