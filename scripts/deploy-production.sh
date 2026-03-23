#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-production.sh [options] <user@host>

Options:
  --app-dir <path>       Remote release directory. Default: /opt/agency-hub
  --image <tag>          Docker image tag. Default: agency_hub_core/runtime:production
  --port <port>          Public HTTP port used for verification. Default: 3000
  --verify-url <url>     Base URL to verify after deploy. Default: http://<host>:<port>
  --identity <path>      SSH identity file
  --ssh-port <port>      SSH port
  -h, --help             Show this help text

Environment variable equivalents:
  DEPLOY_REMOTE
  DEPLOY_APP_DIR
  DEPLOY_IMAGE_TAG
  DEPLOY_HTTP_PORT
  DEPLOY_VERIFY_URL
  DEPLOY_IDENTITY_FILE
  DEPLOY_SSH_PORT
EOF
}

log() {
  printf '[deploy] %s\n' "$*" >&2
}

fail() {
  printf '[deploy] error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

REMOTE="${DEPLOY_REMOTE:-}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/agency-hub}"
IMAGE_TAG="${DEPLOY_IMAGE_TAG:-agency_hub_core/runtime:production}"
HTTP_PORT="${DEPLOY_HTTP_PORT:-3000}"
VERIFY_URL="${DEPLOY_VERIFY_URL:-}"
IDENTITY_FILE="${DEPLOY_IDENTITY_FILE:-}"
SSH_PORT="${DEPLOY_SSH_PORT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      APP_DIR="$2"
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      IMAGE_TAG="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      HTTP_PORT="$2"
      shift 2
      ;;
    --verify-url)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      VERIFY_URL="$2"
      shift 2
      ;;
    --identity)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      IDENTITY_FILE="$2"
      shift 2
      ;;
    --ssh-port)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      SSH_PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      if [[ -z "$REMOTE" ]]; then
        REMOTE="$1"
      else
        fail "Unexpected positional argument: $1"
      fi
      shift
      ;;
  esac
done

if [[ -n "${1:-}" ]]; then
  fail "Unexpected positional argument: $1"
fi

[[ -n "$REMOTE" ]] || fail "Missing remote target. Pass <user@host> or set DEPLOY_REMOTE."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -z "$VERIFY_URL" ]]; then
  REMOTE_HOST="${REMOTE##*@}"
  VERIFY_URL="http://${REMOTE_HOST}:${HTTP_PORT}"
fi

SSH_ARGS=()
if [[ -n "$SSH_PORT" ]]; then
  SSH_ARGS+=(-p "$SSH_PORT")
fi
if [[ -n "$IDENTITY_FILE" ]]; then
  SSH_ARGS+=(-i "$IDENTITY_FILE")
fi

REMOTE_APP_DIR_ESCAPED="$(printf '%q' "$APP_DIR")"
REMOTE_RELEASE_FILES=()
for file in \
  Dockerfile \
  .dockerignore \
  .env.production.example \
  README.md \
  docker-compose.production.yml \
  scripts/deploy-production.sh
do
  if [[ -e "${ROOT_DIR}/${file}" ]]; then
    REMOTE_RELEASE_FILES+=("$file")
  fi
done

run_remote() {
  local command="$1"
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "$command")"
}

curl_status() {
  local output_file="$1"
  local url="$2"
  curl --silent --show-error \
    --connect-timeout 5 \
    --max-time 10 \
    --output "$output_file" \
    --write-out '%{http_code}' \
    "$url"
}

wait_for_api_health() {
  local health_file="$1"
  local url="${VERIFY_URL%/}/api/v1/health"
  local attempt=0

  while (( attempt < 60 )); do
    attempt=$((attempt + 1))
    local status_code
    status_code="$(curl_status "$health_file" "$url" || true)"
    if [[ "$status_code" == "200" ]] && grep -q '"checks"' "$health_file"; then
      return 0
    fi
    sleep 2
  done

  return 1
}

require_command docker
require_command ssh
require_command tar
require_command curl
require_command mktemp

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

HEALTH_FILE="${TEMP_DIR}/health.json"
SYNC_FILE="${TEMP_DIR}/sync.json"
DASHBOARD_FILE="${TEMP_DIR}/dashboard.html"

log "Building ${IMAGE_TAG} locally from ${ROOT_DIR}"
docker build -t "$IMAGE_TAG" "$ROOT_DIR"

log "Loading ${IMAGE_TAG} on ${REMOTE}"
docker save "$IMAGE_TAG" | ssh "${SSH_ARGS[@]}" "$REMOTE" docker load >/dev/null

log "Syncing release files to ${REMOTE}:${APP_DIR}"
tar -C "$ROOT_DIR" -cf - "${REMOTE_RELEASE_FILES[@]}" | ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}"

log "Validating remote prerequisites"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && test -f .env.production && docker compose version >/dev/null"

log "Recreating the remote production stack"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && docker compose -f docker-compose.production.yml up -d --remove-orphans --force-recreate --no-build"

log "Waiting for ${VERIFY_URL%/}/api/v1/health"
wait_for_api_health "$HEALTH_FILE" || fail "API health never reached 200 at ${VERIFY_URL%/}/api/v1/health"

log "Verifying sync health endpoint"
SYNC_STATUS_CODE="$(curl_status "$SYNC_FILE" "${VERIFY_URL%/}/api/v1/health/sync" || true)"
case "$SYNC_STATUS_CODE" in
  200|503)
    ;;
  *)
    fail "Unexpected /api/v1/health/sync status: ${SYNC_STATUS_CODE}"
    ;;
esac
grep -q '"pages"' "$SYNC_FILE" || fail "Sync health response is missing pages[]"

log "Verifying same-origin dashboard delivery"
DASHBOARD_STATUS_CODE="$(curl_status "$DASHBOARD_FILE" "${VERIFY_URL%/}/login" || true)"
[[ "$DASHBOARD_STATUS_CODE" == "200" ]] || fail "Unexpected /login status: ${DASHBOARD_STATUS_CODE}"
grep -qi '<!doctype html>' "$DASHBOARD_FILE" || fail "Dashboard route did not return HTML"
grep -q 'id="root"' "$DASHBOARD_FILE" || fail "Dashboard HTML is missing the root mount"

log "Deployment verified successfully"
log "API health: ${VERIFY_URL%/}/api/v1/health"
log "Sync health: ${VERIFY_URL%/}/api/v1/health/sync (status ${SYNC_STATUS_CODE})"
