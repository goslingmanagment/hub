#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-production.sh [options] <user@host>

Options:
  --app-dir <path>       Remote release directory. Default: /opt/agency-hub
  --image <tag>          Docker image tag. Default: agency_hub_core/runtime:production
  --port <port>          Remote loopback HTTP port used for verification. Default: 3000
  --verify-url <url>     Public HTTPS base URL to verify after deploy. Default: remote http://127.0.0.1:<port>
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
  if [[ "${STACK_RECREATED:-0}" == "1" ]]; then
    rollback_remote_stack
    dump_remote_diagnostics
  fi
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
BUILD_PLATFORM="linux/amd64"

VERIFY_VIA_SSH=0
if [[ -z "$VERIFY_URL" ]]; then
  VERIFY_URL="http://127.0.0.1:${HTTP_PORT}"
  VERIFY_VIA_SSH=1
fi

SSH_ARGS=()
if [[ -n "$SSH_PORT" ]]; then
  SSH_ARGS+=(-p "$SSH_PORT")
fi
if [[ -n "$IDENTITY_FILE" ]]; then
  SSH_ARGS+=(-i "$IDENTITY_FILE")
fi

STACK_RECREATED=0
ROLLBACK_IMAGE_TAG="${IMAGE_TAG}-rollback"
ROLLBACK_IMAGE_AVAILABLE=0
SCHEMA_BASELINE_CAPTURED=0

REMOTE_APP_DIR_ESCAPED="$(printf '%q' "$APP_DIR")"
REMOTE_COMPOSE="docker compose --env-file .env.production -f docker-compose.production.yml"
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

dump_remote_diagnostics() {
  log "Remote verification failed; collecting docker compose status and recent logs"
  run_remote "set +e; cd ${REMOTE_APP_DIR_ESCAPED} || exit 0; ${REMOTE_COMPOSE} ps; printf '\\n'; ${REMOTE_COMPOSE} logs --tail=200 postgres api worker; exit 0" \
    || log "Unable to collect remote diagnostics"
}

capture_remote_rollback_image() {
  local result
  result="$(run_remote "set -euo pipefail; if docker image inspect $(printf '%q' "$IMAGE_TAG") >/dev/null 2>&1; then docker tag $(printf '%q' "$IMAGE_TAG") $(printf '%q' "$ROLLBACK_IMAGE_TAG"); printf available; else printf missing; fi" || true)"
  if [[ "$result" == "available" ]]; then
    ROLLBACK_IMAGE_AVAILABLE=1
    log "Captured rollback image as ${ROLLBACK_IMAGE_TAG}"
  else
    ROLLBACK_IMAGE_AVAILABLE=0
    log "No previous remote image found for rollback"
  fi
}

read_remote_env_value() {
  local key="$1"
  local escaped_key
  escaped_key="$(printf '%q' "$key")"

  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; awk -v key=${escaped_key} 'function trim(value) { sub(/^[[:space:]]+/, \"\", value); sub(/[[:space:]]+$/, \"\", value); return value } /^[[:space:]]*(#|$)/ { next } { line = \$0; eq = index(line, \"=\"); if (eq == 0) next; name = trim(substr(line, 1, eq - 1)); if (name == key) { value = trim(substr(line, eq + 1)); quote = substr(value, 1, 1); if ((quote == \"\\\"\" || quote == sprintf(\"%c\", 39)) && substr(value, length(value), 1) == quote) value = substr(value, 2, length(value) - 2); print value; exit } }' .env.production"
}

rollback_remote_stack() {
  if [[ "${ROLLBACK_IMAGE_AVAILABLE:-0}" != "1" ]]; then
    log "Rollback skipped; no previous image was captured"
    return 0
  fi

  if [[ "${SCHEMA_BASELINE_CAPTURED:-0}" != "1" ]]; then
    log "Rollback skipped; schema migration baseline was not captured"
    log "Automatic rollback cannot prove the previous image is compatible with the current database"
    return 0
  fi

  if ! capture_remote_schema_migrations "$SCHEMA_AFTER_FILE"; then
    log "Rollback skipped; unable to capture current schema migration state"
    log "Automatic rollback cannot prove the previous image is compatible with the current database"
    return 0
  fi

  if ! cmp -s "$SCHEMA_BEFORE_FILE" "$SCHEMA_AFTER_FILE"; then
    log "Rollback skipped; schema_migrations changed during this deploy"
    log "The previous image may not be compatible with the migrated database; inspect diagnostics before choosing a manual rollback"
    return 0
  fi

  log "Rolling back remote stack to ${ROLLBACK_IMAGE_TAG}"
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; docker tag $(printf '%q' "$ROLLBACK_IMAGE_TAG") $(printf '%q' "$IMAGE_TAG"); ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build" \
    || {
      log "Rollback command failed"
      return 0
    }

  if wait_for_api_health "$HEALTH_FILE"; then
    log "Rollback health check passed"
  else
    log "Rollback health check did not reach 200"
  fi
}

capture_remote_schema_migrations() {
  local output_file="$1"

  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} exec -T postgres sh -c 'set -eu; export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; if [ \"\$(psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atqc \"select to_regclass('\''public.schema_migrations'\'') is not null\")\" = \"t\" ]; then psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atqc \"select id from schema_migrations order by id\"; fi'" >"$output_file"
}

remote_curl_status() {
  local output_file="$1"
  local url="$2"
  local header="${3:-}"
  local remote_output="${TEMP_DIR}/remote-curl.out"
  local command="curl --silent --show-error --connect-timeout 5 --max-time 10"
  if [[ -n "$header" ]]; then
    command+=" --header $(printf '%q' "$header")"
  fi
  command+=" --write-out '\n%{http_code}' $(printf '%q' "$url")"

  run_remote "$command" >"$remote_output" || return 1
  tail -n 1 "$remote_output"
  sed '$d' "$remote_output" >"$output_file"
}

curl_status() {
  local output_file="$1"
  local url="$2"
  if [[ "$VERIFY_VIA_SSH" == "1" ]]; then
    remote_curl_status "$output_file" "$url"
    return
  fi

  curl --silent --show-error \
    --connect-timeout 5 \
    --max-time 10 \
    --output "$output_file" \
    --write-out '%{http_code}' \
    "$url"
}

curl_status_with_monitoring_token() {
  local output_file="$1"
  local url="$2"
  local token="$3"
  if [[ "$VERIFY_VIA_SSH" == "1" ]]; then
    remote_curl_status "$output_file" "$url" "x-monitoring-token: ${token}"
    return
  fi

  curl --silent --show-error \
    --connect-timeout 5 \
    --max-time 10 \
    --header "x-monitoring-token: ${token}" \
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
SCHEMA_BEFORE_FILE="${TEMP_DIR}/schema-before.txt"
SCHEMA_AFTER_FILE="${TEMP_DIR}/schema-after.txt"

log "Validating remote Docker access"
run_remote "set -euo pipefail; docker version >/dev/null"
capture_remote_rollback_image

log "Building ${IMAGE_TAG} locally from ${ROOT_DIR} for ${BUILD_PLATFORM}"
docker build --platform="${BUILD_PLATFORM}" -t "$IMAGE_TAG" "$ROOT_DIR"

log "Loading ${IMAGE_TAG} on ${REMOTE}"
docker save "$IMAGE_TAG" | ssh "${SSH_ARGS[@]}" "$REMOTE" docker load >/dev/null

log "Syncing release files to ${REMOTE}:${APP_DIR}"
tar -C "$ROOT_DIR" -cf - "${REMOTE_RELEASE_FILES[@]}" | ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}"

log "Validating remote prerequisites"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && test -f .env.production && docker compose version >/dev/null && ${REMOTE_COMPOSE} config >/dev/null"
SYNC_MONITORING_TOKEN="$(read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN")"

if capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE"; then
  SCHEMA_BASELINE_CAPTURED=1
  log "Captured remote schema migration state for rollback safety"
else
  log "Unable to capture remote schema migration state; automatic rollback will be skipped"
fi

log "Recreating the remote production stack"
STACK_RECREATED=1
if ! run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build"; then
  fail "docker compose failed while recreating the production stack"
fi

log "Waiting for ${VERIFY_URL%/}/api/v1/health"
wait_for_api_health "$HEALTH_FILE" || fail "API health never reached 200 at ${VERIFY_URL%/}/api/v1/health"

if [[ -n "$SYNC_MONITORING_TOKEN" ]]; then
  log "Verifying sync health endpoint"
  SYNC_STATUS_CODE="$(curl_status_with_monitoring_token "$SYNC_FILE" "${VERIFY_URL%/}/api/v1/health/sync" "$SYNC_MONITORING_TOKEN" || true)"
  case "$SYNC_STATUS_CODE" in
    200|503)
      ;;
    *)
      fail "Unexpected /api/v1/health/sync status: ${SYNC_STATUS_CODE}"
      ;;
  esac
  grep -q '"pages"' "$SYNC_FILE" || fail "Sync health response is missing pages[]"
else
  SYNC_STATUS_CODE="skipped"
  log "Skipping protected sync health verification because HEALTH_SYNC_MONITORING_TOKEN is not set"
fi

log "Verifying same-origin dashboard delivery"
DASHBOARD_STATUS_CODE="$(curl_status "$DASHBOARD_FILE" "${VERIFY_URL%/}/login" || true)"
[[ "$DASHBOARD_STATUS_CODE" == "200" ]] || fail "Unexpected /login status: ${DASHBOARD_STATUS_CODE}"
grep -qi '<!doctype html>' "$DASHBOARD_FILE" || fail "Dashboard route did not return HTML"
grep -q 'id="root"' "$DASHBOARD_FILE" || fail "Dashboard HTML is missing the root mount"

log "Deployment verified successfully"
log "API health: ${VERIFY_URL%/}/api/v1/health"
log "Sync health: ${VERIFY_URL%/}/api/v1/health/sync (status ${SYNC_STATUS_CODE})"
