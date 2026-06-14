#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-production.sh [options] <user@host>

Options:
  --app-dir <path>       Remote release directory. Default: /opt/agency-hub
  --image <tag>          Docker image tag. Default: agency_hub_core/runtime:production
  --mode <mode>          Build mode: auto, full, or dist-only. Default: auto
  --node-base-image <tag>
                        Node base image used to seed the local Docker cache.
                        Default: node:22-bookworm-slim
  --node-base-cache-image <tag>
                        Local Docker tag used for stable full builds.
                        Default: agency_hub_core/node:22-bookworm-slim
  --allow-unlabeled-dist-base
                        Allow dist-only deploy from an existing production image
                        without agency-hub dependency checksum labels.
  --port <port>          Remote loopback HTTP port used for verification. Default: 3000
  --verify-url <url>     Public HTTPS base URL to verify after deploy. Default: remote http://127.0.0.1:<port>
  --identity <path>      SSH identity file
  --ssh-port <port>      SSH port
  -h, --help             Show this help text

Environment variable equivalents:
  DEPLOY_REMOTE
  DEPLOY_APP_DIR
  DEPLOY_IMAGE_TAG
  DEPLOY_BUILD_MODE
  DEPLOY_NODE_BASE_IMAGE
  DEPLOY_NODE_BASE_CACHE_IMAGE
  DEPLOY_ALLOW_UNLABELED_DIST_BASE
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

fail_after_release_sync() {
  if [[ "${STACK_RECREATED:-0}" != "1" ]]; then
    restore_remote_release_files || log "Unable to restore remote release files after pre-recreate failure"
  fi

  fail "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

REMOTE="${DEPLOY_REMOTE:-}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/agency-hub}"
IMAGE_TAG="${DEPLOY_IMAGE_TAG:-agency_hub_core/runtime:production}"
BUILD_MODE="${DEPLOY_BUILD_MODE:-auto}"
NODE_BASE_IMAGE="${DEPLOY_NODE_BASE_IMAGE:-node:22-bookworm-slim}"
NODE_BASE_CACHE_IMAGE="${DEPLOY_NODE_BASE_CACHE_IMAGE:-agency_hub_core/node:22-bookworm-slim}"
ALLOW_UNLABELED_DIST_BASE="${DEPLOY_ALLOW_UNLABELED_DIST_BASE:-0}"
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
    --mode)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      BUILD_MODE="$2"
      shift 2
      ;;
    --node-base-image)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      NODE_BASE_IMAGE="$2"
      shift 2
      ;;
    --node-base-cache-image)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      NODE_BASE_CACHE_IMAGE="$2"
      shift 2
      ;;
    --allow-unlabeled-dist-base)
      ALLOW_UNLABELED_DIST_BASE=1
      shift
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

case "$BUILD_MODE" in
  auto|full|dist-only)
    ;;
  *)
    fail "Invalid build mode: ${BUILD_MODE}. Expected auto, full, or dist-only."
    ;;
esac

case "$ALLOW_UNLABELED_DIST_BASE" in
  0|1|true|false|yes|no)
    ;;
  *)
    fail "Invalid DEPLOY_ALLOW_UNLABELED_DIST_BASE value: ${ALLOW_UNLABELED_DIST_BASE}"
    ;;
esac
case "$ALLOW_UNLABELED_DIST_BASE" in
  true|yes)
    ALLOW_UNLABELED_DIST_BASE=1
    ;;
  false|no)
    ALLOW_UNLABELED_DIST_BASE=0
    ;;
esac

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
IMAGE_CANDIDATE_TAG="${IMAGE_TAG}-candidate"
DIST_BASE_TAG="${IMAGE_TAG}-dist-base"
ROLLBACK_IMAGE_AVAILABLE=0
ROLLBACK_RELEASE_FILES_CAPTURED=0
ROLLBACK_RELEASE_FILES_RESTORED=0
SCHEMA_BASELINE_CAPTURED=0
ROLLBACK_COMPOSE_RECREATE_FAILED=0
ROLLBACK_COMPATIBLE_MIGRATIONS=(
  "0013_backfill_egress_rate_limit_scope_key.sql"
  "0014_repair_light_trusted_sync_states.sql"
  "0015_repair_egress_rate_limit_scope_key.sql"
  "0016_canonical_proxy_egress_key_function.sql"
  "0017_reapply_egress_rate_limit_scope_key_repair.sql"
  "0018_notification_incident_recovery_watermarks.sql"
)

REMOTE_APP_DIR_ESCAPED="$(printf '%q' "$APP_DIR")"
REMOTE_RUNTIME_IMAGE_ENV="RUNTIME_IMAGE=$(printf '%q' "$IMAGE_TAG")"
REMOTE_COMPOSE="${REMOTE_RUNTIME_IMAGE_ENV} docker compose --env-file .env.production -f docker-compose.production.yml"
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

DEPENDENCY_MANIFEST_FILES=(
  Dockerfile
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  apps/dashboard/package.json
  apps/runtime/package.json
  packages/contracts/package.json
  packages/db/package.json
  packages/fansly/package.json
  packages/onlyfans/package.json
  packages/shared/package.json
)

DIST_OVERLAY_PATHS=(
  apps/dashboard/dist
  apps/runtime/dist
  packages/contracts/dist
  packages/db/dist
  packages/db/migrations
  packages/fansly/dist
  packages/onlyfans/dist
  packages/shared/dist
)

run_remote() {
  local command="$1"
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "$command")"
}

remote_release_file_args() {
  local quoted=()
  local file
  for file in "${REMOTE_RELEASE_FILES[@]}"; do
    quoted+=("$(printf '%q' "$file")")
  done

  printf '%s ' "${quoted[@]}"
}

dump_remote_diagnostics() {
  log "Remote verification failed; collecting docker compose status and recent logs"
  run_remote "set +e; cd ${REMOTE_APP_DIR_ESCAPED} || exit 0; ${REMOTE_COMPOSE} ps; printf '\\n'; ${REMOTE_COMPOSE} logs --tail=200 postgres api worker; exit 0" \
    || log "Unable to collect remote diagnostics"
}

capture_remote_rollback_image() {
  local result
  result="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; container_id=\$(${REMOTE_COMPOSE} ps -q api 2>/dev/null || true); if [[ -z \"\$container_id\" ]]; then container_id=\$(${REMOTE_COMPOSE} ps -q worker 2>/dev/null || true); fi; if [[ -n \"\$container_id\" ]]; then image_id=\$(docker inspect -f '{{.Image}}' \"\$container_id\"); docker tag \"\$image_id\" $(printf '%q' "$ROLLBACK_IMAGE_TAG"); printf available; else printf missing; fi" || true)"
  if [[ "$result" == "available" ]]; then
    ROLLBACK_IMAGE_AVAILABLE=1
    log "Captured rollback image as ${ROLLBACK_IMAGE_TAG}"
  else
    ROLLBACK_IMAGE_AVAILABLE=0
    log "No previous remote image found for rollback"
  fi
}

capture_remote_release_files() {
  local file_args
  file_args="$(remote_release_file_args)"

  if run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; [[ -e docker-compose.production.yml ]]; files=(); for file in ${file_args}; do if [[ -e \"\$file\" ]]; then files+=(\"\$file\"); fi; done; (( \${#files[@]} > 0 )); tar -cf - \"\${files[@]}\"" >"$ROLLBACK_RELEASE_ARCHIVE"; then
    ROLLBACK_RELEASE_FILES_CAPTURED=1
    log "Captured rollback release files"
  else
    ROLLBACK_RELEASE_FILES_CAPTURED=0
    log "Unable to capture rollback release files"
  fi
}

restore_remote_release_files() {
  if [[ "${ROLLBACK_RELEASE_FILES_CAPTURED:-0}" != "1" ]]; then
    log "Rollback skipped; release file baseline was not captured"
    return 1
  fi

  ssh "${SSH_ARGS[@]}" "$REMOTE" "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}" \
    <"$ROLLBACK_RELEASE_ARCHIVE" || return 1
  ROLLBACK_RELEASE_FILES_RESTORED=1
}

is_rollback_compatible_migration() {
  local migration="$1"
  local compatible
  for compatible in "${ROLLBACK_COMPATIBLE_MIGRATIONS[@]}"; do
    if [[ "$migration" == "$compatible" ]]; then
      return 0
    fi
  done

  return 1
}

schema_migration_delta_allows_rollback() {
  local migration
  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    if ! grep -Fxq "$migration" "$SCHEMA_AFTER_FILE"; then
      return 1
    fi
  done <"$SCHEMA_BEFORE_FILE"

  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    if grep -Fxq "$migration" "$SCHEMA_BEFORE_FILE"; then
      continue
    fi
    if ! is_rollback_compatible_migration "$migration"; then
      return 1
    fi
  done <"$SCHEMA_AFTER_FILE"

  return 0
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

  if [[ "${ROLLBACK_COMPOSE_RECREATE_FAILED:-0}" == "1" ]]; then
    if ! restore_remote_release_files; then
      log "Automatic rollback cannot prove the previous image is compatible with the current release files"
      return 0
    fi
  fi

  if ! capture_remote_schema_migrations "$SCHEMA_AFTER_FILE"; then
    if [[ "${ROLLBACK_COMPOSE_RECREATE_FAILED:-0}" == "1" ]]; then
      run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} up -d postgres" \
        || log "Unable to start postgres for rollback schema verification"
    fi

    if ! capture_remote_schema_migrations "$SCHEMA_AFTER_FILE"; then
      log "Rollback skipped; unable to capture current schema migration state"
      log "Automatic rollback cannot prove the previous image is compatible with the current database"
      return 0
    fi
  fi

  if ! cmp -s "$SCHEMA_BEFORE_FILE" "$SCHEMA_AFTER_FILE"; then
    if schema_migration_delta_allows_rollback; then
      log "Schema migrations changed only by rollback-compatible data migrations; continuing automatic rollback"
    else
      log "Rollback skipped; schema_migrations changed during this deploy"
      log "The previous image may not be compatible with the migrated database; inspect diagnostics before choosing a manual rollback"
      return 0
    fi
  fi

  log "Rolling back remote stack to ${ROLLBACK_IMAGE_TAG}"
  if [[ "${ROLLBACK_RELEASE_FILES_RESTORED:-0}" != "1" ]] && ! restore_remote_release_files; then
    log "Automatic rollback cannot prove the previous image is compatible with the current release files"
    return 0
  fi

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

  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} exec -T postgres sh -c 'set -eu
export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atq <<'\''SQL'\''
BEGIN;
DO \$deploy_schema_capture\$
BEGIN
  PERFORM pg_advisory_xact_lock(31415, 27182);
  CREATE TEMP TABLE deploy_schema_migrations(id text) ON COMMIT DROP;
  IF to_regclass(\$q\$public.schema_migrations\$q\$) IS NOT NULL THEN
    EXECUTE \$q\$insert into deploy_schema_migrations select id from schema_migrations order by id\$q\$;
  END IF;
END
\$deploy_schema_capture\$;
SELECT id FROM deploy_schema_migrations ORDER BY id;
COMMIT;
SQL'" >"$output_file"
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

# The worker is the whole sync engine; a dead or crash-looping worker must not
# report a green deploy (audit B8). Asserts the compose healthcheck (worker
# health file freshness + DB reachability) reaches 'healthy'.
wait_for_worker_health() {
  local attempt=0
  local status

  while (( attempt < 60 )); do
    attempt=$((attempt + 1))
    status="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; container_id=\$(${REMOTE_COMPOSE} ps -q worker 2>/dev/null || true); if [[ -z \"\$container_id\" ]]; then printf missing; else docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \"\$container_id\"; fi" || true)"
    case "$status" in
      healthy)
        return 0
        ;;
      missing|exited|dead|restarting)
        log "Worker container status: ${status:-unknown}"
        ;;
    esac
    sleep 3
  done

  log "Worker container last observed status: ${status:-unknown}"
  return 1
}

calculate_dependency_checksum() {
  (
    cd "$ROOT_DIR"
    local file
    for file in "${DEPENDENCY_MANIFEST_FILES[@]}"; do
      [[ -f "$file" ]] || fail "Dependency checksum file is missing: $file"
      printf 'file:%s\n' "$file"
      shasum -a 256 "$file"
    done
  ) | shasum -a 256 | awk '{print $1}'
}

calculate_source_revision() {
  local revision
  if revision="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null)"; then
    if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      revision="${revision}-dirty"
    fi
    printf '%s' "$revision"
  else
    printf 'unknown'
  fi
}

ensure_node_base_cache() {
  if docker image inspect "$NODE_BASE_CACHE_IMAGE" >/dev/null 2>&1; then
    log "Using cached Node base image ${NODE_BASE_CACHE_IMAGE}"
    return 0
  fi

  local attempt
  for attempt in 1 2 3; do
    log "Pulling Node base image ${NODE_BASE_IMAGE} for ${BUILD_PLATFORM} (attempt ${attempt}/3)"
    if docker pull --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE"; then
      if [[ "$NODE_BASE_IMAGE" != "$NODE_BASE_CACHE_IMAGE" ]]; then
        docker tag "$NODE_BASE_IMAGE" "$NODE_BASE_CACHE_IMAGE"
      fi
      log "Cached Node base image as ${NODE_BASE_CACHE_IMAGE}"
      return 0
    fi
    sleep $((attempt * 5))
  done

  log "Unable to pull ${NODE_BASE_IMAGE}, and ${NODE_BASE_CACHE_IMAGE} is not cached locally"
  return 1
}

build_full_candidate_image() {
  ensure_node_base_cache || return 1

  log "Building ${IMAGE_CANDIDATE_TAG} locally from ${ROOT_DIR} for ${BUILD_PLATFORM}"
  docker build \
    --platform="${BUILD_PLATFORM}" \
    --build-arg "NODE_BASE_IMAGE=${NODE_BASE_CACHE_IMAGE}" \
    --build-arg "APP_DEPENDENCY_CHECKSUM=${APP_DEPENDENCY_CHECKSUM}" \
    --build-arg "APP_SOURCE_REVISION=${APP_SOURCE_REVISION}" \
    -t "$IMAGE_CANDIDATE_TAG" \
    "$ROOT_DIR"
}

load_candidate_image() {
  log "Loading ${IMAGE_CANDIDATE_TAG} on ${REMOTE}"
  docker save "$IMAGE_CANDIDATE_TAG" | ssh "${SSH_ARGS[@]}" "$REMOTE" docker load >/dev/null
}

read_remote_rollback_dependency_checksum() {
  local template
  template='{{ index .Config.Labels "agency-hub.dependency-checksum" }}'
  run_remote "set -euo pipefail; docker image inspect -f $(printf '%q' "$template") $(printf '%q' "$ROLLBACK_IMAGE_TAG")" 2>/dev/null || true
}

validate_dist_only_base() {
  if [[ "${ROLLBACK_IMAGE_AVAILABLE:-0}" != "1" ]]; then
    fail "Dist-only deploy requires a captured remote rollback image to use as the base"
  fi

  local remote_checksum
  remote_checksum="$(read_remote_rollback_dependency_checksum)"
  if [[ "$remote_checksum" == "<no value>" ]]; then
    remote_checksum=""
  fi

  if [[ -z "$remote_checksum" ]]; then
    if [[ "$ALLOW_UNLABELED_DIST_BASE" == "1" ]]; then
      log "Dist-only base image has no dependency checksum label; continuing because --allow-unlabeled-dist-base was set"
      return 0
    fi
    fail "Dist-only deploy cannot prove dependency compatibility because the current production image is unlabeled. Re-run with --allow-unlabeled-dist-base only if package manifests, lockfile, and Dockerfile are compatible with the running image."
  fi

  if [[ "$remote_checksum" != "$APP_DEPENDENCY_CHECKSUM" ]]; then
    fail "Dist-only deploy refused: dependency checksum changed (${remote_checksum} -> ${APP_DEPENDENCY_CHECKSUM}). Use a full deploy after refreshing the Node base cache."
  fi

  log "Dist-only base dependency checksum matches ${APP_DEPENDENCY_CHECKSUM}"
}

copy_dist_overlay_path() {
  local relative_path="$1"
  local source_path="${ROOT_DIR}/${relative_path}"
  local target_path="${DIST_CONTEXT_DIR}/${relative_path}"

  [[ -e "$source_path" ]] || fail "Dist-only deploy output is missing: ${relative_path}"
  mkdir -p "$(dirname "$target_path")"
  cp -R "$source_path" "$target_path"
}

create_dist_overlay_context() {
  DIST_CONTEXT_DIR="${TEMP_DIR}/dist-overlay-context"
  mkdir -p "$DIST_CONTEXT_DIR"

  cat >"${DIST_CONTEXT_DIR}/Dockerfile" <<EOF
FROM ${DIST_BASE_TAG}

WORKDIR /app

ARG APP_DEPENDENCY_CHECKSUM=unknown
ARG APP_SOURCE_REVISION=unknown

LABEL agency-hub.dependency-checksum="\${APP_DEPENDENCY_CHECKSUM}"
LABEL agency-hub.source-revision="\${APP_SOURCE_REVISION}"

COPY apps/dashboard/dist ./apps/dashboard/dist
COPY apps/runtime/dist ./apps/runtime/dist
COPY packages/contracts/dist ./packages/contracts/dist
COPY packages/db/dist ./packages/db/dist
COPY packages/db/migrations ./packages/db/migrations
COPY packages/fansly/dist ./packages/fansly/dist
COPY packages/onlyfans/dist ./packages/onlyfans/dist
COPY packages/shared/dist ./packages/shared/dist
EOF

  local path
  for path in "${DIST_OVERLAY_PATHS[@]}"; do
    copy_dist_overlay_path "$path"
  done
}

build_dist_only_candidate_image() {
  require_command pnpm
  validate_dist_only_base

  log "Building production JS/CSS artifacts locally"
  (cd "$ROOT_DIR" && pnpm build:production)
  create_dist_overlay_context

  local remote_context="/tmp/agency-hub-dist-overlay-${APP_SOURCE_REVISION//[^A-Za-z0-9_.-]/-}"
  local remote_context_escaped
  remote_context_escaped="$(printf '%q' "$remote_context")"

  log "Uploading dist-only build context to ${REMOTE}:${remote_context}"
  tar -C "$DIST_CONTEXT_DIR" -cf - . | ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "bash -lc $(printf '%q' "set -euo pipefail; rm -rf ${remote_context_escaped}; mkdir -p ${remote_context_escaped}; tar -xf - -C ${remote_context_escaped}")" \
    >/dev/null

  log "Building ${IMAGE_CANDIDATE_TAG} on ${REMOTE} from current production image"
  run_remote "set -euo pipefail; docker tag $(printf '%q' "$ROLLBACK_IMAGE_TAG") $(printf '%q' "$DIST_BASE_TAG"); docker build --platform=$(printf '%q' "$BUILD_PLATFORM") --build-arg APP_DEPENDENCY_CHECKSUM=$(printf '%q' "$APP_DEPENDENCY_CHECKSUM") --build-arg APP_SOURCE_REVISION=$(printf '%q' "$APP_SOURCE_REVISION") -t $(printf '%q' "$IMAGE_CANDIDATE_TAG") ${remote_context_escaped}; rm -rf ${remote_context_escaped}"
}

build_candidate_image() {
  APP_DEPENDENCY_CHECKSUM="$(calculate_dependency_checksum)"
  APP_SOURCE_REVISION="$(calculate_source_revision)"
  log "Build metadata: revision=${APP_SOURCE_REVISION}, dependency_checksum=${APP_DEPENDENCY_CHECKSUM}"

  case "$BUILD_MODE" in
    full)
      build_full_candidate_image
      load_candidate_image
      ;;
    dist-only)
      build_dist_only_candidate_image
      ;;
    auto)
      if build_full_candidate_image; then
        load_candidate_image
      else
        log "Full Docker build failed before release sync; attempting dist-only fallback"
        build_dist_only_candidate_image
      fi
      ;;
  esac
}

require_command docker
require_command ssh
require_command tar
require_command curl
require_command mktemp
require_command shasum
require_command git
require_command cp

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

HEALTH_FILE="${TEMP_DIR}/health.json"
SYNC_FILE="${TEMP_DIR}/sync.json"
DASHBOARD_FILE="${TEMP_DIR}/dashboard.html"
SCHEMA_BEFORE_FILE="${TEMP_DIR}/schema-before.txt"
SCHEMA_AFTER_FILE="${TEMP_DIR}/schema-after.txt"
ROLLBACK_RELEASE_ARCHIVE="${TEMP_DIR}/rollback-release-files.tar"

log "Validating remote Docker access"
run_remote "set -euo pipefail; docker version >/dev/null"
capture_remote_rollback_image
capture_remote_release_files

build_candidate_image

log "Syncing release files to ${REMOTE}:${APP_DIR}"
tar -C "$ROOT_DIR" -cf - "${REMOTE_RELEASE_FILES[@]}" | ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}" \
  || fail_after_release_sync "Unable to sync release files to remote"

log "Validating remote prerequisites"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && test -f .env.production && docker compose version >/dev/null && ${REMOTE_COMPOSE} config >/dev/null" \
  || fail_after_release_sync "Remote prerequisite validation failed after syncing release files"
SYNC_MONITORING_TOKEN="$(read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN")" \
  || fail_after_release_sync "Unable to read monitoring token after syncing release files"

if capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE"; then
  SCHEMA_BASELINE_CAPTURED=1
  log "Captured remote schema migration state for rollback safety"
else
  log "Unable to capture remote schema migration state; automatic rollback will be skipped"
fi

log "Recreating the remote production stack"
run_remote "set -euo pipefail; docker tag $(printf '%q' "$IMAGE_CANDIDATE_TAG") $(printf '%q' "$IMAGE_TAG")" \
  || fail_after_release_sync "Unable to promote candidate image tag after validation"
STACK_RECREATED=1
if ! run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build"; then
  ROLLBACK_COMPOSE_RECREATE_FAILED=1
  fail "docker compose failed while recreating the production stack"
fi

log "Waiting for ${VERIFY_URL%/}/api/v1/health"
wait_for_api_health "$HEALTH_FILE" || fail "API health never reached 200 at ${VERIFY_URL%/}/api/v1/health"

log "Waiting for the worker container healthcheck"
wait_for_worker_health || fail "Worker container never reached a healthy state"

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
