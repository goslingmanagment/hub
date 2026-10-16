#!/usr/bin/env bash
# The stand check of the page browser image (plan §5, stage 3, PR 2 and
# PR 6): a test page container from docker-compose.page-browser.yml on this
# machine's Docker — never a server's — with a new profile, then, inside it,
# stand/image-check.mjs (the image: policies, sandbox, the operator's hold of
# Chrome) and stand/rules-check.mjs (the rules extension: installed by
# policy, and what it cancels without the operator), twice: on the first
# start and after the container is recreated with the same profile. Removes
# the container and its volumes at the end; the networks pb-control and
# pb-egress stay.
#
#   apps/page-browser/stand/image-check.sh [--image <tag>] [--apparmor <profile>]
#
# Without --image it builds hub-page-browser:stand from the vendor cache
# (PB_VENDOR_CACHE, default ~/code/.cache/page-browser: chrome/, kasmvnc/,
# s6-overlay/). --apparmor unconfined where the kernel has no AppArmor
# (Docker Desktop); on a server the profile `page-browser` must be loaded.
# The SOCKS5 address is a documentation address (192.0.2.10): nothing
# answers there, and nothing needs to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/apps/page-browser"
IMAGE=""
APPARMOR="page-browser"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --apparmor) APPARMOR="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

log() { printf '[image-check] %s\n' "$*" >&2; }

if [[ -z "$IMAGE" ]]; then
  CACHE="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"
  VENDOR="$(mktemp -d)"
  trap 'rm -rf "$VENDOR"' EXIT
  cp "$CACHE"/chrome/*.deb "$CACHE"/kasmvnc/*.deb "$CACHE"/s6-overlay/*.tar.xz "$VENDOR"/
  IMAGE="hub-page-browser:stand"
  log "building $IMAGE"
  docker build -q --build-context vendor="$VENDOR" -t "$IMAGE" "$APP" >/dev/null
fi

docker network inspect pb-control >/dev/null 2>&1 \
  || docker network create --internal --subnet 10.230.0.0/24 pb-control >/dev/null
docker network inspect pb-egress >/dev/null 2>&1 \
  || docker network create --subnet 10.230.1.0/24 -o com.docker.network.bridge.enable_icc=false pb-egress >/dev/null

WORK="$(mktemp -d)"
PROFILE="$(uuidgen | tr '[:upper:]' '[:lower:]')"
PAGE="image-check"
mkdir -m 700 "$WORK/secrets"
(umask 077; openssl rand -hex 16 > "$WORK/secrets/vnc_password")
(umask 077; openssl rand -hex 32 > "$WORK/secrets/rpc_token")
(umask 077; openssl rand -hex 32 > "$WORK/secrets/api_token")
cat > "$WORK/page.env" <<EOF
PB_PAGE=$PAGE
PB_IMAGE=$IMAGE
PB_PROFILE_ID=$PROFILE
PB_CONTROL_IP=10.230.0.250
PB_EGRESS_IP=10.230.1.250
PB_SOCKS_IP=192.0.2.10
PB_SOCKS_PORT=1080
PB_SYNC_IP=10.230.0.2
PB_API_IP=10.230.0.3
PB_TZ=Europe/Berlin
PB_LANG=en-US
PB_SECCOMP_PROFILE=$APP/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=$APPARMOR
PB_SECRETS_DIR=$WORK/secrets
EOF
compose() { docker compose -f "$ROOT/docker-compose.page-browser.yml" --env-file "$WORK/page.env" "$@"; }
cleanup() {
  compose down >/dev/null 2>&1 || true
  docker volume rm "pb-profile-$PROFILE" "pb-buffer-$PROFILE" >/dev/null 2>&1 || true
  rm -rf "$WORK" "${VENDOR:-}"
}
trap cleanup EXIT
docker volume create "pb-profile-$PROFILE" >/dev/null
docker volume create "pb-buffer-$PROFILE" >/dev/null

run_check() {
  local label="$1" health=""
  for _ in $(seq 1 60); do
    health="$(docker inspect -f '{{.State.Health.Status}}' "page-browser-$PAGE" 2>/dev/null || true)"
    [[ "$health" == "starting" || -z "$health" ]] || break
    sleep 1
  done
  if [[ "$health" != "healthy" ]]; then
    log "$label: the container is $health"
    docker logs "page-browser-$PAGE" 2>&1 | grep -E 'init-net|net-selftest|s6-rc|rc.init' | tail -30 >&2
    return 1
  fi
  # Only root reads this local check's synthetic screen password. It never
  # leaves the container; the check connects to Kasm's loopback WebSocket.
  docker cp "$APP/stand/screen-check.mjs" "page-browser-$PAGE:/tmp/screen-check.mjs" >/dev/null
  docker exec "page-browser-$PAGE" node --no-warnings /tmp/screen-check.mjs
  local script
  for script in image-check.mjs rules-check.mjs; do
    docker cp "$APP/stand/$script" "page-browser-$PAGE:/tmp/$script" >/dev/null
    docker exec "page-browser-$PAGE" chmod 644 "/tmp/$script"
    log "$label: $script"
    docker exec "page-browser-$PAGE" /command/s6-setuidgid pb-operator node --no-warnings "/tmp/$script"
  done
}

compose up -d >/dev/null 2>&1
run_check "first start, new profile"
compose up -d --force-recreate >/dev/null 2>&1
run_check "recreated, same profile"
log "passed"
