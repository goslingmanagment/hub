#!/usr/bin/env bash
set -euo pipefail

# macOS bsdtar emits AppleDouble sidecar files for extended attributes unless
# this is disabled. Those sidecars can look like real SQL migrations after the
# archive is extracted on Linux.
export COPYFILE_DISABLE=1

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-production.sh [options] <user@host>

Options:
  --app-dir <path>       Remote release directory. Default: /opt/agency-hub
  --image <tag>          Docker image tag. Default: agency_hub_core/runtime:production
  --mode <mode>          Build mode: full, dist-only, or auto. Default: full
  --node-base-image <tag>
                        Canonical Node base image used for full builds.
                        Default: node:22-bookworm-slim
  --node-base-cache-image <tag>
                        Deprecated compatibility option; accepted but ignored.
                        Use --node-base-image instead.
  --allow-unlabeled-dist-base
                        Allow dist-only deploy from an existing production image
                        without agency-hub dependency checksum labels.
  --port <port>          Remote loopback HTTP port used for verification. Default: 3000
  --verify-url <url>     Public HTTPS base URL to verify after deploy. Default: remote http://127.0.0.1:<port>
  --identity <path>      SSH identity file
  --ssh-port <port>      SSH port
  --extension-persona-receipt <path>
                        Private Extension legacy-persona export used only by
                        the first desktop-lifecycle-v2 enablement verifier
  --desktop-persona-receipt <path>
                        Private Desktop legacy-persona export for first enable
  --desktop-diagnostics-receipt <path>
                        Private Desktop diagnostics receipt for first enable
  -h, --help             Show this help text

Environment variable equivalents:
  DEPLOY_REMOTE
  DEPLOY_APP_DIR
  DEPLOY_IMAGE_TAG
  DEPLOY_BUILD_MODE
  DEPLOY_NODE_BASE_IMAGE
  DEPLOY_NODE_BASE_CACHE_IMAGE (deprecated; accepted but ignored)
  DEPLOY_ALLOW_UNLABELED_DIST_BASE
  DEPLOY_HTTP_PORT
  DEPLOY_VERIFY_URL
  DEPLOY_IDENTITY_FILE
  DEPLOY_SSH_PORT
  DEPLOY_EXTENSION_PERSONA_RECEIPT
  DEPLOY_DESKTOP_PERSONA_RECEIPT
  DEPLOY_DESKTOP_DIAGNOSTICS_RECEIPT
EOF
}

log() {
  printf '[deploy] %s\n' "$*" >&2
}

fail() {
  if [[ "${STACK_RECREATED:-0}" == "1" ]]; then
    rollback_remote_stack
    dump_remote_diagnostics
  elif [[ "${LEGACY_SYNC_QUIESCED:-0}" == "1" ]]; then
    restore_quiesced_sync_services \
      || log "Unable to restart quiesced sync services; the API remains online and the DB fence remains active"
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

warn_deprecated_node_base_cache() {
  if [[ "${DEPRECATED_NODE_BASE_CACHE_WARNING_EMITTED:-0}" == "1" ]]; then
    return
  fi
  log "warning: --node-base-cache-image / DEPLOY_NODE_BASE_CACHE_IMAGE is deprecated and ignored; use --node-base-image / DEPLOY_NODE_BASE_IMAGE"
  DEPRECATED_NODE_BASE_CACHE_WARNING_EMITTED=1
}

REMOTE="${DEPLOY_REMOTE:-}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/agency-hub}"
IMAGE_TAG="${DEPLOY_IMAGE_TAG:-agency_hub_core/runtime:production}"
BUILD_MODE="${DEPLOY_BUILD_MODE:-full}"
NODE_BASE_IMAGE="${DEPLOY_NODE_BASE_IMAGE:-node:22-bookworm-slim}"
DEPRECATED_NODE_BASE_CACHE_WARNING_EMITTED=0
if [[ -n "${DEPLOY_NODE_BASE_CACHE_IMAGE+x}" ]]; then
  warn_deprecated_node_base_cache
fi
ALLOW_UNLABELED_DIST_BASE="${DEPLOY_ALLOW_UNLABELED_DIST_BASE:-0}"
HTTP_PORT="${DEPLOY_HTTP_PORT:-3000}"
VERIFY_URL="${DEPLOY_VERIFY_URL:-}"
IDENTITY_FILE="${DEPLOY_IDENTITY_FILE:-}"
SSH_PORT="${DEPLOY_SSH_PORT:-}"
EXTENSION_PERSONA_RECEIPT="${DEPLOY_EXTENSION_PERSONA_RECEIPT:-}"
DESKTOP_PERSONA_RECEIPT="${DEPLOY_DESKTOP_PERSONA_RECEIPT:-}"
DESKTOP_DIAGNOSTICS_RECEIPT="${DEPLOY_DESKTOP_DIAGNOSTICS_RECEIPT:-}"

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
      # Compatibility only: consume the legacy value but never retain or use it.
      warn_deprecated_node_base_cache
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
    --extension-persona-receipt)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      EXTENSION_PERSONA_RECEIPT="$2"
      shift 2
      ;;
    --desktop-persona-receipt)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      DESKTOP_PERSONA_RECEIPT="$2"
      shift 2
      ;;
    --desktop-diagnostics-receipt)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      DESKTOP_DIAGNOSTICS_RECEIPT="$2"
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
LEGACY_SYNC_QUIESCED=0
APP_DEPENDENCY_CHECKSUM=""
APP_SOURCE_REVISION=""
DEPLOY_RUN_ID=""
ROLLBACK_IMAGE_TAG=""
IMAGE_CANDIDATE_TAG=""
DIST_BASE_TAG=""
LOCAL_BUILD_CACHE_TAG=""
ROLLBACK_IMAGE_AVAILABLE=0
ROLLBACK_RELEASE_FILES_CAPTURED=0
ROLLBACK_RELEASE_FILES_RESTORED=0
SCHEMA_BASELINE_CAPTURED=0
ROLLBACK_COMPOSE_RECREATE_FAILED=0
ROLLBACK_FORBIDDEN=0
ROLLBACK_FORBIDDEN_REASON=""
LIFECYCLE_FIRST_ENABLE=0
LIFECYCLE_CANDIDATE_HAS_CAPABILITY=0
# Filled only after the exact chatter token inventory is bound and reviewed.
# This is deliberately deploy-owned rather than supplied by the candidate image.
APPROVED_DESKTOP_LIFECYCLE_V2_EVIDENCE_SHA256="2285d565034e636fe5aa03290f3d722bce77ae6190390a78a7c0bd0a7fdd38de"
# Startup owns schema migration. The concurrent observations index can run for
# ten minutes on production data while every API process correctly stays
# pre-listen, so health verification must cover that migration window.
API_HEALTH_MAX_WAIT_SECONDS=1200
LOCAL_DEPLOY_LOCK_DIR=""
LOCAL_DEPLOY_LOCK_ACQUIRED=0
REMOTE_DEPLOY_LOCK_DIR="${APP_DIR%/}/.deploy.lock"
REMOTE_DEPLOY_LOCK_DIR_ESCAPED="$(printf '%q' "$REMOTE_DEPLOY_LOCK_DIR")"
REMOTE_DEPLOY_LOCK_ACQUIRED=0
ROLLBACK_COMPATIBLE_MIGRATIONS=(
  "0013_backfill_egress_rate_limit_scope_key.sql"
  "0014_repair_light_trusted_sync_states.sql"
  "0015_repair_egress_rate_limit_scope_key.sql"
  "0016_canonical_proxy_egress_key_function.sql"
  "0017_reapply_egress_rate_limit_scope_key_repair.sql"
  "0018_notification_incident_recovery_watermarks.sql"
  "0097_retire_onlyfans_legacy_dm_messages.sql"
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
  scripts/deploy-production.sh \
  scripts/verify-desktop-lifecycle-v2-evidence.mjs
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
  packages/platform-core/package.json
  packages/shared/package.json
)

DIST_OVERLAY_PATHS=(
  apps/dashboard/dist
  apps/runtime/dist
  packages/contracts/dist
  packages/db/dist
  packages/db/migrations
  packages/fansly/dist
  packages/platform-core/dist
  packages/shared/dist
)

run_remote() {
  local command="$1"
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "$command")"
}

sanitize_tag_component() {
  local value="$1"
  local sanitized="${value//[^[:alnum:]_.-]/-}"
  if [[ -z "$sanitized" ]]; then
    sanitized="unknown"
  fi
  printf '%s' "$sanitized"
}

initialize_deploy_metadata_and_tags() {
  APP_DEPENDENCY_CHECKSUM="$(calculate_dependency_checksum)"
  APP_SOURCE_REVISION="$(calculate_source_revision)"
  DEPLOY_RUN_ID="$(sanitize_tag_component "$(date -u +%Y%m%dT%H%M%SZ)-$$")"

  local source_tag_component
  source_tag_component="$(sanitize_tag_component "$APP_SOURCE_REVISION")"

  IMAGE_CANDIDATE_TAG="${IMAGE_TAG}-candidate-${source_tag_component}-${DEPLOY_RUN_ID}"
  DIST_BASE_TAG="${IMAGE_TAG}-dist-base-${source_tag_component}-${DEPLOY_RUN_ID}"
  ROLLBACK_IMAGE_TAG="${IMAGE_TAG}-rollback-${source_tag_component}-${DEPLOY_RUN_ID}"
  LOCAL_BUILD_CACHE_TAG="${IMAGE_TAG}-build-cache-$(sanitize_tag_component "$BUILD_PLATFORM")"

  log "Build metadata: revision=${APP_SOURCE_REVISION}, dependency_checksum=${APP_DEPENDENCY_CHECKSUM}, run_id=${DEPLOY_RUN_ID}"
  log "Deploy image tags: candidate=${IMAGE_CANDIDATE_TAG}, rollback=${ROLLBACK_IMAGE_TAG}, dist_base=${DIST_BASE_TAG}"
  log "Local rolling build cache: ${LOCAL_BUILD_CACHE_TAG}"
}

acquire_local_deploy_lock() {
  local root_hash
  root_hash="$(printf '%s' "$ROOT_DIR" | shasum -a 256 | awk '{print substr($1, 1, 16)}')"
  LOCAL_DEPLOY_LOCK_DIR="${TMPDIR:-/tmp}/agency-hub-deploy-production-${root_hash}.lock"

  if mkdir "$LOCAL_DEPLOY_LOCK_DIR" 2>/dev/null; then
    LOCAL_DEPLOY_LOCK_ACQUIRED=1
    {
      printf 'started_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'local_pid=%s\n' "$$"
      printf 'root_dir=%s\n' "$ROOT_DIR"
      printf 'remote=%s\n' "$REMOTE"
      printf 'app_dir=%s\n' "$APP_DIR"
      printf 'source_revision=%s\n' "$APP_SOURCE_REVISION"
      printf 'dependency_checksum=%s\n' "$APP_DEPENDENCY_CHECKSUM"
      printf 'run_id=%s\n' "$DEPLOY_RUN_ID"
      printf 'candidate_tag=%s\n' "$IMAGE_CANDIDATE_TAG"
    } >"${LOCAL_DEPLOY_LOCK_DIR}/metadata"
    printf '%s\n' "$DEPLOY_RUN_ID" >"${LOCAL_DEPLOY_LOCK_DIR}/owner"
    log "Acquired local deploy lock ${LOCAL_DEPLOY_LOCK_DIR}"
    return 0
  fi

  log "Another local production deploy appears to be running; lock exists at ${LOCAL_DEPLOY_LOCK_DIR}"
  if [[ -f "${LOCAL_DEPLOY_LOCK_DIR}/metadata" ]]; then
    log "Existing local lock metadata:"
    while IFS= read -r line; do
      log "  ${line}"
    done <"${LOCAL_DEPLOY_LOCK_DIR}/metadata"
  fi
  fail "Local deploy lock exists. Remove ${LOCAL_DEPLOY_LOCK_DIR} only after confirming no deploy is active."
}

release_remote_deploy_lock() {
  [[ "${REMOTE_DEPLOY_LOCK_ACQUIRED:-0}" == "1" ]] || return 0
  run_remote "set -euo pipefail; if [[ -d ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED} ]]; then if [[ -f ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/owner ]] && [[ \"\$(cat ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/owner)\" == $(printf '%q' "$DEPLOY_RUN_ID") ]]; then rm -rf ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}; else printf '[deploy] remote lock owner changed; leaving %s in place\n' $(printf '%q' "$REMOTE_DEPLOY_LOCK_DIR") >&2; exit 1; fi; fi"
  REMOTE_DEPLOY_LOCK_ACQUIRED=0
}

cleanup_deploy() {
  local exit_status=$?

  if [[ "$exit_status" != "0" && "${STACK_RECREATED:-0}" != "1" && "${LEGACY_SYNC_QUIESCED:-0}" == "1" ]]; then
    restore_quiesced_sync_services \
      || log "Unable to restart quiesced sync services during deploy cleanup"
  fi

  if [[ "${REMOTE_DEPLOY_LOCK_ACQUIRED:-0}" == "1" ]]; then
    release_remote_deploy_lock || log "Unable to release remote deploy lock ${REMOTE_DEPLOY_LOCK_DIR}"
  fi

  if [[ "${LOCAL_DEPLOY_LOCK_ACQUIRED:-0}" == "1" && -n "${LOCAL_DEPLOY_LOCK_DIR:-}" ]]; then
    local local_lock_owner=""
    if [[ -f "${LOCAL_DEPLOY_LOCK_DIR}/owner" ]]; then
      IFS= read -r local_lock_owner <"${LOCAL_DEPLOY_LOCK_DIR}/owner" || true
    fi
    if [[ "$local_lock_owner" == "$DEPLOY_RUN_ID" ]]; then
      rm -rf "$LOCAL_DEPLOY_LOCK_DIR" || log "Unable to release local deploy lock ${LOCAL_DEPLOY_LOCK_DIR}"
    else
      log "Local lock owner changed; leaving ${LOCAL_DEPLOY_LOCK_DIR} in place"
    fi
    LOCAL_DEPLOY_LOCK_ACQUIRED=0
  fi

  if [[ -n "${TEMP_DIR:-}" ]]; then
    rm -rf "$TEMP_DIR"
  fi

  return "$exit_status"
}

acquire_remote_deploy_lock() {
  local remote_command
  remote_command=$(cat <<EOF
set -euo pipefail
mkdir -p ${REMOTE_APP_DIR_ESCAPED}
if mkdir ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED} 2>/dev/null; then
  {
    printf 'started_at_utc=%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"
    printf 'remote_user=%s\n' "\$(id -un 2>/dev/null || printf unknown)"
    printf 'remote_host=%s\n' "\$(hostname 2>/dev/null || printf unknown)"
    printf 'remote_pid=%s\n' "\$\$"
    printf 'local_pid=%s\n' $(printf '%q' "$$")
    printf 'local_root=%s\n' $(printf '%q' "$ROOT_DIR")
    printf 'remote_target=%s\n' $(printf '%q' "$REMOTE")
    printf 'app_dir=%s\n' $(printf '%q' "$APP_DIR")
    printf 'source_revision=%s\n' $(printf '%q' "$APP_SOURCE_REVISION")
    printf 'dependency_checksum=%s\n' $(printf '%q' "$APP_DEPENDENCY_CHECKSUM")
    printf 'run_id=%s\n' $(printf '%q' "$DEPLOY_RUN_ID")
    printf 'candidate_tag=%s\n' $(printf '%q' "$IMAGE_CANDIDATE_TAG")
    printf 'rollback_tag=%s\n' $(printf '%q' "$ROLLBACK_IMAGE_TAG")
  } > ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/metadata
  printf '%s\n' $(printf '%q' "$DEPLOY_RUN_ID") > ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/owner
  exit 0
fi
printf '[deploy] error: another deploy is running; remote lock exists: %s\n' $(printf '%q' "$REMOTE_DEPLOY_LOCK_DIR") >&2
if [[ -f ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/metadata ]]; then
  printf '[deploy] existing remote lock metadata:\n' >&2
  while IFS= read -r line; do printf '[deploy]   %s\n' "\$line" >&2; done < ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/metadata
fi
printf '[deploy] inspect with: ssh %s %s\n' $(printf '%q' "$REMOTE") $(printf '%q' "ls -la ${REMOTE_DEPLOY_LOCK_DIR}; cat ${REMOTE_DEPLOY_LOCK_DIR}/metadata") >&2
printf '[deploy] remove only after confirming no deploy is active: rm -rf %s\n' $(printf '%q' "$REMOTE_DEPLOY_LOCK_DIR") >&2
exit 73
EOF
)

  if run_remote "$remote_command"; then
    REMOTE_DEPLOY_LOCK_ACQUIRED=1
    log "Acquired remote deploy lock ${REMOTE}:${REMOTE_DEPLOY_LOCK_DIR}"
    return 0
  fi

  fail "Remote deploy lock exists at ${REMOTE}:${REMOTE_DEPLOY_LOCK_DIR}. Inspect it and remove only after confirming no deploy is active."
}

preflight_migration_files() {
  local migrations_dir="${ROOT_DIR}/packages/db/migrations"
  [[ -d "$migrations_dir" ]] || fail "Migration directory is missing: ${migrations_dir}"

  local hidden_files=()
  local invalid_files=()
  local file
  local name

  while IFS= read -r -d '' file; do
    hidden_files+=("${file##*/}")
  done < <(find "$migrations_dir" -maxdepth 1 -type f -name '.*.sql' -print0)

  while IFS= read -r -d '' file; do
    name="${file##*/}"
    if [[ ! "$name" =~ ^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$ ]]; then
      invalid_files+=("$name")
    fi
  done < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' ! -name '.*.sql' -print0)

  if (( ${#hidden_files[@]} > 0 )); then
    printf '[deploy] hidden SQL migration files are not allowed in %s:\n' "$migrations_dir" >&2
    printf '[deploy]   %s\n' "${hidden_files[@]}" >&2
    fail "Remove hidden SQL migration metadata files before deploying"
  fi

  if (( ${#invalid_files[@]} > 0 )); then
    printf '[deploy] invalid SQL migration filenames in %s:\n' "$migrations_dir" >&2
    printf '[deploy]   %s\n' "${invalid_files[@]}" >&2
    fail "Migration filenames must match ^[0-9]{4}_[a-z0-9][a-z0-9_-]*\\.sql$"
  fi

  log "Migration filename preflight passed"
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

forbid_rollback_for_pending_pre_recreate_migrations() {
  local migration_path
  local migration
  local through="0097_retire_onlyfans_legacy_dm_messages.sql"

  for migration_path in "${ROOT_DIR}"/packages/db/migrations/*.sql; do
    migration="${migration_path##*/}"
    [[ "$migration" > "$through" ]] && continue
    grep -Fxq "$migration" "$SCHEMA_BEFORE_FILE" && continue
    if ! is_rollback_compatible_migration "$migration"; then
      ROLLBACK_FORBIDDEN=1
      ROLLBACK_FORBIDDEN_REASON="pending non-rollback-compatible pre-recreate migration: ${migration}"
      log "Automatic rollback disabled before migration starts: ${ROLLBACK_FORBIDDEN_REASON}"
      return 0
    fi
  done
}

read_remote_env_value() {
  local key="$1"
  local escaped_key
  escaped_key="$(printf '%q' "$key")"

  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; awk -v key=${escaped_key} 'function trim(value) { sub(/^[[:space:]]+/, \"\", value); sub(/[[:space:]]+$/, \"\", value); return value } /^[[:space:]]*(#|$)/ { next } { line = \$0; eq = index(line, \"=\"); if (eq == 0) next; name = trim(substr(line, 1, eq - 1)); if (name == key) { value = trim(substr(line, eq + 1)); quote = substr(value, 1, 1); if ((quote == \"\\\"\" || quote == sprintf(\"%c\", 39)) && substr(value, length(value), 1) == quote) value = substr(value, 2, length(value) - 2); print value; exit } }' .env.production"
}

quiesce_remote_legacy_sync_services() {
  log "Quiescing the old scheduler and worker before installing the permanent DB fence"
  # Set before the multi-service stop: compose can stop one service and then
  # fail on the other, and the deploy cleanup must still restore both.
  LEGACY_SYNC_QUIESCED=1
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} stop -t 75 scheduler worker"
}

restore_quiesced_sync_services() {
  [[ "${LEGACY_SYNC_QUIESCED:-0}" == "1" ]] || return 0
  log "Restarting the quiesced scheduler and worker behind the permanent DB fence"
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} up -d scheduler worker" \
    || return 1
  LEGACY_SYNC_QUIESCED=0
}

verify_remote_legacy_onlyfans_dm_messages_retired() {
  local unsafe_count
  unsafe_count="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} exec -T postgres sh -c 'set -eu
export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atq <<'\''SQL'\''
SELECT count(*)
FROM pages p
LEFT JOIN page_sync_states st
  ON st.page_id = p.id
 AND st.stream = '\''dm_messages'\''
WHERE p.platform = '\''onlyfans'\''
  AND p.status = '\''active'\''
  AND (
    st.page_id IS NULL
    OR st.status <> '\''paused'\''
    OR st.blocker_kind IS DISTINCT FROM '\''retired'\''
    OR st.blocker_code IS DISTINCT FROM '\''legacy_ofapi_dm_messages_retired'\''
    OR st.leased_seq IS NOT NULL
    OR st.lease_owner IS NOT NULL
    OR st.lease_token IS NOT NULL
    OR st.lease_heartbeat_at IS NOT NULL
    OR st.lease_expires_at IS NOT NULL
  );
SQL'")" || return 1

  [[ "$unsafe_count" == "0" ]]
}

rollback_remote_stack() {
  if [[ "${ROLLBACK_FORBIDDEN:-0}" == "1" ]]; then
    log "Rollback skipped; ${ROLLBACK_FORBIDDEN_REASON:-a pre-recreate migration made rollback unsafe}"
    return 0
  fi

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

  if ! verify_remote_legacy_onlyfans_dm_messages_retired; then
    log "Rollback skipped; durable retirement of legacy OnlyFans dm_messages is not proven"
    log "An old image could resurrect the paid crawler; keep the current stack stopped and inspect page_sync_states"
    return 0
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
  local max_time="${4:-10}"
  local remote_output="${TEMP_DIR}/remote-curl.out"
  local command="curl --silent --show-error --connect-timeout 5 --max-time ${max_time}"
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
  local max_time="${3:-10}"
  if [[ "$VERIFY_VIA_SSH" == "1" ]]; then
    remote_curl_status "$output_file" "$url" "" "$max_time"
    return
  fi

  curl --silent --show-error \
    --connect-timeout 5 \
    --max-time "$max_time" \
    --output "$output_file" \
    --write-out '%{http_code}' \
    "$url"
}

curl_status_with_monitoring_token() {
  local output_file="$1"
  local url="$2"
  local token="$3"
  local max_time="${4:-10}"
  if [[ "$VERIFY_VIA_SSH" == "1" ]]; then
    remote_curl_status "$output_file" "$url" "x-monitoring-token: ${token}" "$max_time"
    return
  fi

  curl --silent --show-error \
    --connect-timeout 5 \
    --max-time "$max_time" \
    --header "x-monitoring-token: ${token}" \
    --output "$output_file" \
    --write-out '%{http_code}' \
    "$url"
}

wait_for_api_health() {
  local health_file="$1"
  local url="${VERIFY_URL%/}/api/v1/health"
  local deadline=$((SECONDS + API_HEALTH_MAX_WAIT_SECONDS))

  while (( SECONDS < deadline )); do
    local status_code
    status_code="$(curl_status "$health_file" "$url" 5 || true)"
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

# The scheduler is the only cron timekeeper: a wedged one silently stalls the
# sync planner, sweeps and reports. Asserts the compose healthcheck (scheduler
# health file freshness, written only after a successful heartbeat upsert)
# reaches 'healthy'.
wait_for_scheduler_health() {
  local attempt=0
  local status

  while (( attempt < 60 )); do
    attempt=$((attempt + 1))
    status="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; container_id=\$(${REMOTE_COMPOSE} ps -q scheduler 2>/dev/null || true); if [[ -z \"\$container_id\" ]]; then printf missing; else docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \"\$container_id\"; fi" || true)"
    case "$status" in
      healthy)
        return 0
        ;;
      missing|exited|dead|restarting)
        log "Scheduler container status: ${status:-unknown}"
        ;;
    esac
    sleep 3
  done

  log "Scheduler container last observed status: ${status:-unknown}"
  return 1
}

wait_for_sync_health() {
  local sync_file="$1"
  local url="${VERIFY_URL%/}/api/v1/health/sync"
  local attempt=0

  # Cold-start reality (2026-07-07/08, two deploys in a row): right after a
  # stack recreate the visible_pages aggregation takes 50s+ (worker catch-up
  # + autovacuum), and every attempt abandoned at a short cap leaves its
  # query running server-side — attempts stack into a self-amplifying pile
  # (17 backends at peak) and the gate can roll back a HEALTHY stack. A
  # 150s per-attempt cap lets the first attempt actually finish; fewer,
  # slower retries keep the worst case bounded without stacking.
  while (( attempt < 6 )); do
    attempt=$((attempt + 1))
    SYNC_STATUS_CODE="$(curl_status_with_monitoring_token "$sync_file" "$url" "$SYNC_MONITORING_TOKEN" 150 || true)"
    case "$SYNC_STATUS_CODE" in
      200|503)
        grep -q '"pages"' "$sync_file" && return 0
        ;;
    esac
    sleep 10
  done

  return 1
}

verify_service_image_labels() {
  local service="$1"
  local service_escaped
  local output
  local revision
  local checksum
  service_escaped="$(printf '%q' "$service")"

  output="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; container_id=\$(${REMOTE_COMPOSE} ps -q ${service_escaped} 2>/dev/null || true); [[ -n \"\$container_id\" ]]; image_id=\$(docker inspect -f '{{.Image}}' \"\$container_id\"); docker image inspect -f '{{ index .Config.Labels \"agency-hub.source-revision\" }}|{{ index .Config.Labels \"agency-hub.dependency-checksum\" }}' \"\$image_id\"")" \
    || fail "Unable to inspect running ${service} image labels"

  revision="${output%%|*}"
  checksum="${output#*|}"
  if [[ "$revision" == "<no value>" ]]; then
    revision=""
  fi
  if [[ "$checksum" == "<no value>" ]]; then
    checksum=""
  fi

  [[ "$revision" == "$APP_SOURCE_REVISION" ]] \
    || fail "Running ${service} image source revision label mismatch: expected ${APP_SOURCE_REVISION}, got ${revision:-missing}"
  [[ "$checksum" == "$APP_DEPENDENCY_CHECKSUM" ]] \
    || fail "Running ${service} image dependency checksum label mismatch: expected ${APP_DEPENDENCY_CHECKSUM}, got ${checksum:-missing}"
}

verify_post_deploy_image_labels() {
  log "Verifying running image labels"
  verify_service_image_labels api
  verify_service_image_labels worker
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

ensure_node_base_image() {
  if docker image inspect "$NODE_BASE_IMAGE" >/dev/null 2>&1; then
    local cached_runtime
    if cached_runtime="$(docker run --rm --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE" node -p "process.platform + '/' + process.arch" 2>/dev/null)" \
      && [[ "$cached_runtime" == "linux/x64" ]]; then
      log "Using Node base image ${NODE_BASE_IMAGE} for ${BUILD_PLATFORM}"
      return 0
    fi

    if [[ -n "${cached_runtime:-}" ]]; then
      log "Node base image ${NODE_BASE_IMAGE} is invalid for ${BUILD_PLATFORM}: expected linux/x64, got ${cached_runtime}"
    else
      log "Node base image ${NODE_BASE_IMAGE} failed ${BUILD_PLATFORM} runtime validation"
    fi
  else
    log "Node base image ${NODE_BASE_IMAGE} is not present locally"
  fi

  local attempt
  for attempt in 1 2 3; do
    log "Pulling Node base image ${NODE_BASE_IMAGE} for ${BUILD_PLATFORM} (attempt ${attempt}/3)"
    if docker pull --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE"; then
      local refreshed_runtime
      if refreshed_runtime="$(docker run --rm --platform="${BUILD_PLATFORM}" "$NODE_BASE_IMAGE" node -p "process.platform + '/' + process.arch" 2>/dev/null)" \
        && [[ "$refreshed_runtime" == "linux/x64" ]]; then
        log "Pulled and validated Node base image ${NODE_BASE_IMAGE} for ${BUILD_PLATFORM}"
        return 0
      fi

      log "Pulled Node base image did not validate for ${BUILD_PLATFORM}; got ${refreshed_runtime:-unknown}"
    fi
    sleep $((attempt * 5))
  done

  log "Unable to pull and validate ${NODE_BASE_IMAGE} for ${BUILD_PLATFORM}"
  return 1
}

build_full_candidate_image() {
  ensure_node_base_image || return 1

  local cache_args=()
  if docker image inspect "$LOCAL_BUILD_CACHE_TAG" >/dev/null 2>&1; then
    cache_args+=(--cache-from "$LOCAL_BUILD_CACHE_TAG")
    log "Using verified-deploy build cache ${LOCAL_BUILD_CACHE_TAG}"
  else
    log "No verified-deploy build cache found; this build will seed ${LOCAL_BUILD_CACHE_TAG} after successful deployment"
  fi

  log "Building ${IMAGE_CANDIDATE_TAG} locally from ${ROOT_DIR} for ${BUILD_PLATFORM}"
  DOCKER_BUILDKIT=1 docker build \
    "${cache_args[@]}" \
    --platform="${BUILD_PLATFORM}" \
    --build-arg "BUILDKIT_INLINE_CACHE=1" \
    --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
    --build-arg "APP_DEPENDENCY_CHECKSUM=${APP_DEPENDENCY_CHECKSUM}" \
    --build-arg "APP_SOURCE_REVISION=${APP_SOURCE_REVISION}" \
    -t "$IMAGE_CANDIDATE_TAG" \
    "$ROOT_DIR"
}

promote_local_build_cache() {
  if ! docker image inspect "$IMAGE_CANDIDATE_TAG" >/dev/null 2>&1; then
    log "Local candidate ${IMAGE_CANDIDATE_TAG} is absent (dist-only build); leaving ${LOCAL_BUILD_CACHE_TAG} unchanged"
    return 0
  fi

  if ! docker tag "$IMAGE_CANDIDATE_TAG" "$LOCAL_BUILD_CACHE_TAG"; then
    log "warning: unable to advance local build cache ${LOCAL_BUILD_CACHE_TAG}; production is already verified"
    return 0
  fi

  log "Advanced local build cache ${LOCAL_BUILD_CACHE_TAG} to verified candidate ${IMAGE_CANDIDATE_TAG}"
}

prune_local_candidate_tags() {
  local retention_count=2
  local candidate_rows
  local candidates=()
  local candidate

  if ! candidate_rows="$(docker image ls \
    --filter "reference=${IMAGE_TAG}-candidate-*" \
    --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' \
    | LC_ALL=C sort -r)"; then
    log "warning: unable to list local candidate images for retention; production is already verified"
    return 0
  fi

  while IFS='|' read -r _created candidate; do
    [[ -n "$candidate" ]] && candidates+=("$candidate")
  done <<<"$candidate_rows"

  if (( ${#candidates[@]} <= retention_count )); then
    log "Local candidate retention: ${#candidates[@]} tag(s), nothing to prune"
    return 0
  fi

  local container_ids=()
  local used_image_ids=()
  local container_id_rows
  local used_image_id_rows
  local container_id
  local used_image_id

  if ! container_id_rows="$(docker container ls --all --quiet --no-trunc)"; then
    log "warning: unable to inventory local containers; skipping candidate cleanup rather than risk removing an in-use image"
    return 0
  fi
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] && container_ids+=("$container_id")
  done <<<"$container_id_rows"

  if (( ${#container_ids[@]} > 0 )); then
    if ! used_image_id_rows="$(docker container inspect --format '{{.Image}}' "${container_ids[@]}")"; then
      log "warning: unable to resolve local container images; skipping candidate cleanup rather than risk removing an in-use image"
      return 0
    fi
    while IFS= read -r used_image_id; do
      [[ -n "$used_image_id" ]] && used_image_ids+=("$used_image_id")
    done <<<"$used_image_id_rows"
  fi

  local index=0
  local image_id
  local image_in_use
  for candidate in "${candidates[@]}"; do
    index=$((index + 1))
    (( index <= retention_count )) && continue

    if ! image_id="$(docker image inspect --format '{{.Id}}' "$candidate" 2>/dev/null)"; then
      log "warning: unable to inspect stale candidate ${candidate}; leaving it in place"
      continue
    fi

    image_in_use=0
    for used_image_id in "${used_image_ids[@]}"; do
      if [[ "$used_image_id" == "$image_id" ]]; then
        image_in_use=1
        break
      fi
    done
    if [[ "$image_in_use" == "1" ]]; then
      log "Keeping stale candidate ${candidate}: image ${image_id} is referenced by a local container"
      continue
    fi

    if docker image rm "$candidate" >/dev/null; then
      log "Removed stale local candidate tag ${candidate}"
    else
      log "warning: unable to remove stale candidate tag ${candidate}; leaving it in place"
    fi
  done

  return 0
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

prune_macos_metadata_files() {
  local target_dir="$1"
  find "$target_dir" \( -name '._*' -o -name '.DS_Store' \) -type f -delete
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
COPY packages/platform-core/dist ./packages/platform-core/dist
COPY packages/shared/dist ./packages/shared/dist
EOF

  local path
  for path in "${DIST_OVERLAY_PATHS[@]}"; do
    copy_dist_overlay_path "$path"
  done
  prune_macos_metadata_files "$DIST_CONTEXT_DIR"
}

build_dist_only_candidate_image() {
  require_command pnpm
  validate_dist_only_base

  log "Building production JS/CSS artifacts locally"
  (cd "$ROOT_DIR" && pnpm build:production)
  create_dist_overlay_context

  local remote_context="/tmp/agency-hub-dist-overlay-${DEPLOY_RUN_ID}"
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
  case "$BUILD_MODE" in
    full)
      build_full_candidate_image || fail "Full Docker build failed"
      load_candidate_image || fail "Unable to load candidate image on remote"
      ;;
    dist-only)
      build_dist_only_candidate_image || fail "Dist-only candidate image build failed"
      ;;
    auto)
      if build_full_candidate_image; then
        load_candidate_image || fail "Unable to load candidate image on remote"
      else
        log "Full Docker build failed before release sync; attempting dist-only fallback because --mode auto was set"
        build_dist_only_candidate_image || fail "Dist-only candidate image build failed"
      fi
      ;;
  esac
}

verify_candidate_lifecycle_capability() {
  local running_capabilities
  local candidate_capabilities

  candidate_capabilities="$(run_remote "set -euo pipefail; docker run --rm $(printf '%q' "$IMAGE_CANDIDATE_TAG") node apps/runtime/dist/startup.js print-public-capabilities")" \
    || fail "Unable to interrogate candidate runtime capabilities"
  case "$candidate_capabilities" in
    '[]')
      LIFECYCLE_CANDIDATE_HAS_CAPABILITY=0
      ;;
    '["desktop-lifecycle-v2"]')
      LIFECYCLE_CANDIDATE_HAS_CAPABILITY=1
      ;;
    *)
      fail "Candidate returned an unexpected public capability manifest: ${candidate_capabilities}"
      ;;
  esac

  if [[ "${ROLLBACK_IMAGE_AVAILABLE:-0}" != "1" ]]; then
    [[ "$LIFECYCLE_CANDIDATE_HAS_CAPABILITY" == "0" ]] \
      || fail "Cannot enable desktop-lifecycle-v2 without a captured running image capability baseline"
    log "No running image capability baseline; candidate keeps desktop-lifecycle-v2 absent"
    return 0
  fi

  running_capabilities="$(run_remote "set -euo pipefail; docker run --rm $(printf '%q' "$ROLLBACK_IMAGE_TAG") node apps/runtime/dist/startup.js print-public-capabilities")" \
    || fail "Unable to interrogate running runtime capabilities"
  case "${running_capabilities}->${candidate_capabilities}" in
    '[]->[]')
      log "Candidate keeps desktop-lifecycle-v2 absent"
      ;;
    '[]->["desktop-lifecycle-v2"]')
      LIFECYCLE_FIRST_ENABLE=1
      [[ -n "$EXTENSION_PERSONA_RECEIPT" && -r "$EXTENSION_PERSONA_RECEIPT" ]] \
        || fail "First desktop-lifecycle-v2 enablement requires a readable Extension persona receipt"
      [[ -n "$DESKTOP_PERSONA_RECEIPT" && -r "$DESKTOP_PERSONA_RECEIPT" ]] \
        || fail "First desktop-lifecycle-v2 enablement requires a readable Desktop persona receipt"
      [[ -n "$DESKTOP_DIAGNOSTICS_RECEIPT" && -r "$DESKTOP_DIAGNOSTICS_RECEIPT" ]] \
        || fail "First desktop-lifecycle-v2 enablement requires a readable Desktop diagnostics receipt"
      run_remote "set -euo pipefail; docker run --rm $(printf '%q' "$IMAGE_CANDIDATE_TAG") node apps/runtime/dist/startup.js print-desktop-lifecycle-v2-evidence" \
        >"$LIFECYCLE_EVIDENCE_FILE" \
        || fail "Unable to read desktop-lifecycle-v2 evidence from candidate image"
      verify_approved_lifecycle_manifest_digest
      log "Verifying exact Desktop/Extension release evidence"
      node "$ROOT_DIR/scripts/verify-desktop-lifecycle-v2-evidence.mjs" \
        "$LIFECYCLE_EVIDENCE_FILE" \
        "$LIFECYCLE_ARTIFACT_DIR" \
        "$EXTENSION_PERSONA_RECEIPT" \
        "$DESKTOP_PERSONA_RECEIPT" \
        "$DESKTOP_DIAGNOSTICS_RECEIPT" \
        || fail "Desktop lifecycle v2 external evidence verification failed"
      verify_candidate_lifecycle_inventory
      log "First desktop-lifecycle-v2 enablement evidence verified"
      ;;
    '["desktop-lifecycle-v2"]->["desktop-lifecycle-v2"]')
      log "Candidate preserves the already-enabled desktop-lifecycle-v2 capability"
      ;;
    '["desktop-lifecycle-v2"]->[]')
      fail "Candidate would regress the already-enabled desktop-lifecycle-v2 capability"
      ;;
    *)
      fail "Running image returned an unexpected public capability manifest: ${running_capabilities}"
      ;;
  esac
}

verify_approved_lifecycle_manifest_digest() {
  local actual
  [[ "$APPROVED_DESKTOP_LIFECYCLE_V2_EVIDENCE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Approved desktop-lifecycle-v2 evidence SHA-256 is not finalized"
  actual="$(shasum -a 256 "$LIFECYCLE_EVIDENCE_FILE" | awk '{print $1}')" \
    || fail "Unable to hash desktop-lifecycle-v2 evidence from candidate image"
  [[ "$actual" == "$APPROVED_DESKTOP_LIFECYCLE_V2_EVIDENCE_SHA256" ]] \
    || fail "Candidate desktop-lifecycle-v2 evidence does not match the deploy-approved manifest SHA-256"
  log "Candidate desktop-lifecycle-v2 evidence matches the deploy-approved manifest SHA-256"
}

verify_candidate_lifecycle_inventory() {
  local candidate_compose
  local result
  candidate_compose="RUNTIME_IMAGE=$(printf '%q' "$IMAGE_CANDIDATE_TAG") docker compose --env-file .env.production -f docker-compose.production.yml"
  result="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${candidate_compose} run --rm --no-deps api node apps/runtime/dist/startup.js verify-desktop-lifecycle-v2-inventory")" \
    || fail "Desktop lifecycle v2 production inventory verification failed"
  node - "$result" <<'NODE' \
    || fail "Desktop lifecycle v2 inventory verifier returned an unexpected result"
const result = JSON.parse(process.argv[2]);
const keys = Object.keys(result).sort();
if (JSON.stringify(keys) !== JSON.stringify(["ok", "verified"])) {
  throw new Error(`unexpected result keys: ${keys.join(",")}`);
}
if (result.ok !== true || !Array.isArray(result.verified) || result.verified.length === 0) {
  throw new Error("inventory verification did not return a non-empty success set");
}
for (const item of result.verified) {
  const itemKeys = Object.keys(item).sort();
  if (JSON.stringify(itemKeys) !== JSON.stringify(["machineId", "tokenId", "username"])) {
    throw new Error(`unexpected verified item keys: ${itemKeys.join(",")}`);
  }
  if (typeof item.machineId !== "string" || !Number.isSafeInteger(item.tokenId) || typeof item.username !== "string") {
    throw new Error("invalid verified inventory item");
  }
}
NODE
  log "Desktop lifecycle v2 production inventory verified"
}

verify_post_deploy_lifecycle_capability() {
  local expected="false"
  [[ "$LIFECYCLE_CANDIDATE_HAS_CAPABILITY" == "1" ]] && expected="true"
  node - "$HEALTH_FILE" "$expected" <<'NODE'
const fs = require("node:fs");
const [path, expectedRaw] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(path, "utf8"));
const capabilities = body.capabilities;
if (!Array.isArray(capabilities)) throw new Error("health capabilities is not an array");
const present = capabilities.includes("desktop-lifecycle-v2");
if (present !== (expectedRaw === "true")) {
  throw new Error(`health desktop-lifecycle-v2=${present}, expected ${expectedRaw}`);
}
NODE
}

run_pre_recreate_safe_migrations() {
  local candidate_compose
  candidate_compose="RUNTIME_IMAGE=$(printf '%q' "$IMAGE_CANDIDATE_TAG") docker compose --env-file .env.production -f docker-compose.production.yml"
  log "Applying rollback-compatible migrations through 0097 while the current API remains online"
  # This foreground one-shot owns the migration advisory lock. Deployment
  # cannot enter recreate/rollback handling until it exits and releases it.
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${candidate_compose} run --rm --no-deps api node packages/db/dist/migrate.js --through 0097_retire_onlyfans_legacy_dm_messages.sql" \
    || fail "Pre-recreate migration through 0097 failed; current API was left running"
}

require_command docker
require_command ssh
require_command tar
require_command curl
require_command mktemp
require_command shasum
require_command git
require_command gh
require_command node
require_command unzip
require_command cp
require_command find
require_command awk
require_command date

TEMP_DIR="$(mktemp -d)"
trap cleanup_deploy EXIT

HEALTH_FILE="${TEMP_DIR}/health.json"
SYNC_FILE="${TEMP_DIR}/sync.json"
DASHBOARD_FILE="${TEMP_DIR}/dashboard.html"
SCHEMA_BEFORE_FILE="${TEMP_DIR}/schema-before.txt"
SCHEMA_AFTER_FILE="${TEMP_DIR}/schema-after.txt"
ROLLBACK_RELEASE_ARCHIVE="${TEMP_DIR}/rollback-release-files.tar"
LIFECYCLE_EVIDENCE_FILE="${TEMP_DIR}/desktop-lifecycle-v2-evidence.json"
LIFECYCLE_ARTIFACT_DIR="${TEMP_DIR}/desktop-lifecycle-v2-artifacts"

initialize_deploy_metadata_and_tags
acquire_local_deploy_lock
preflight_migration_files
acquire_remote_deploy_lock

log "Validating remote Docker access"
run_remote "set -euo pipefail; docker version >/dev/null"
capture_remote_rollback_image
capture_remote_release_files

build_candidate_image
verify_candidate_lifecycle_capability
capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE" \
  || fail "Unable to capture remote schema migration state before pre-recreate migration"
SCHEMA_BASELINE_CAPTURED=1
log "Captured remote schema migration state for rollback safety"
quiesce_remote_legacy_sync_services \
  || fail "Unable to quiesce the legacy scheduler and worker"
forbid_rollback_for_pending_pre_recreate_migrations
run_pre_recreate_safe_migrations
verify_remote_legacy_onlyfans_dm_messages_retired \
  || fail "Legacy OnlyFans dm_messages retirement proof failed"

log "Syncing release files to ${REMOTE}:${APP_DIR}"
tar -C "$ROOT_DIR" -cf - "${REMOTE_RELEASE_FILES[@]}" | ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}" \
  || fail_after_release_sync "Unable to sync release files to remote"

log "Validating remote prerequisites"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && test -f .env.production && docker compose version >/dev/null && ${REMOTE_COMPOSE} config >/dev/null" \
  || fail_after_release_sync "Remote prerequisite validation failed after syncing release files"
SYNC_MONITORING_TOKEN="$(read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN")" \
  || fail_after_release_sync "Unable to read monitoring token after syncing release files"

log "Recreating the remote production stack"
if [[ "$LIFECYCLE_FIRST_ENABLE" == "1" ]]; then
  # The owner binding can be revoked or transferred while a long candidate
  # build runs. Re-read it at the last safe point before promotion.
  verify_candidate_lifecycle_inventory
  ROLLBACK_FORBIDDEN=1
  ROLLBACK_FORBIDDEN_REASON="desktop-lifecycle-v2 was enabled; capability rollback is unsafe"
  log "Automatic rollback disabled before the one-way desktop-lifecycle-v2 transition"
fi
run_remote "set -euo pipefail; docker tag $(printf '%q' "$IMAGE_CANDIDATE_TAG") $(printf '%q' "$IMAGE_TAG")" \
  || fail_after_release_sync "Unable to promote candidate image tag after validation"
STACK_RECREATED=1
if ! run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build"; then
  ROLLBACK_COMPOSE_RECREATE_FAILED=1
  fail "docker compose failed while recreating the production stack"
fi
LEGACY_SYNC_QUIESCED=0

log "Waiting for ${VERIFY_URL%/}/api/v1/health"
wait_for_api_health "$HEALTH_FILE" || fail "API health never reached 200 at ${VERIFY_URL%/}/api/v1/health"
verify_post_deploy_lifecycle_capability \
  || fail "Production health capability does not match the verified candidate"

log "Waiting for the worker container healthcheck"
wait_for_worker_health || fail "Worker container never reached a healthy state"

log "Waiting for the scheduler container healthcheck"
wait_for_scheduler_health || fail "Scheduler container never reached a healthy state"

verify_post_deploy_image_labels

if [[ -n "$SYNC_MONITORING_TOKEN" ]]; then
  log "Verifying sync health endpoint"
  wait_for_sync_health "$SYNC_FILE" || fail "Unexpected /api/v1/health/sync status: ${SYNC_STATUS_CODE}"
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
promote_local_build_cache
prune_local_candidate_tags
log "API health: ${VERIFY_URL%/}/api/v1/health"
log "Sync health: ${VERIFY_URL%/}/api/v1/health/sync (status ${SYNC_STATUS_CODE})"
