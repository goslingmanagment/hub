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
  --mode <mode>          Build mode: full, dist-only, auto, or pull. Default: full
  --pull-image <digest> GHCR image@sha256 digest required by --mode pull.
  --recreate-scope <scope>
                        apps (default) preserves unchanged Postgres; stack
                        explicitly includes PostgreSQL/infrastructure changes.
  --node-base-image <tag>
                        Canonical Node base image used for full builds.
                        Default: node:22-bookworm-slim
  --node-base-cache-image <tag>
                        Deprecated compatibility option; accepted but ignored.
                        Use --node-base-image instead.
  --allow-unlabeled-dist-base
                        Allow dist-only deploy from the pinned clean full image
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
  --image-gc             Enable the post-health-gate cleanup of superseded
                        candidate/rollback/full-base image tags and the
                        builder cache prune. ON by default since Decision
                        #371 (2026-09-18: unpruned deploy images filled the
                        production disk and closed the OFAPI read gate).
  --no-image-gc          Disable image GC for this run (also
                        DEPLOY_IMAGE_GC=0 / DEPLOY_SKIP_IMAGE_GC=1).
  --skip-hub-cli-rebuild
                        Do not rebuild this machine's production-pinned `hub`
                        CLI after the deploy is verified (it is rebuilt by
                        default; see scripts/rebuild-hub-cli-prod.sh).
  -h, --help             Show this help text

Environment variable equivalents:
  DEPLOY_REMOTE
  DEPLOY_APP_DIR
  DEPLOY_IMAGE_TAG
  DEPLOY_BUILD_MODE
  DEPLOY_PULL_IMAGE
  DEPLOY_RECREATE_SCOPE
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
  DEPLOY_IMAGE_GC
  DEPLOY_SKIP_IMAGE_GC
  DEPLOY_SKIP_HUB_CLI_REBUILD
EOF
}

log() {
  printf '[deploy] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

start_phase() {
  PHASE_STARTED_SECONDS=$SECONDS
  log "Phase $1 started"
}

finish_phase() {
  log "Phase $1 completed; duration_seconds=$((SECONDS - PHASE_STARTED_SECONDS))"
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
PULL_IMAGE="${DEPLOY_PULL_IMAGE:-}"
RECREATE_SCOPE="${DEPLOY_RECREATE_SCOPE:-apps}"
NODE_BASE_IMAGE="${DEPLOY_NODE_BASE_IMAGE:-node:22-bookworm-slim}"
DEPRECATED_NODE_BASE_CACHE_WARNING_EMITTED=0
if [[ -n "${DEPLOY_NODE_BASE_CACHE_IMAGE+x}" ]]; then
  warn_deprecated_node_base_cache
fi
ALLOW_UNLABELED_DIST_BASE="${DEPLOY_ALLOW_UNLABELED_DIST_BASE:-0}"
# Default ON (Decision #371 supersedes the default-off of #176/#212): every
# deploy leaves a candidate, a rollback and, on a dependency change, a 1.4 GB
# clean base on the VPS; with GC off they accumulated 22 GB in three weeks,
# crossed the disk gauge and closed the OFAPI read gate for the desktop. The
# keep-set (running containers, release tag, this run's candidate/rollback,
# the current clean base) still guarantees one rollback path. Opt out per run
# with --no-image-gc / DEPLOY_IMAGE_GC=0 / DEPLOY_SKIP_IMAGE_GC=1.
IMAGE_GC_ENABLED=1
case "${DEPLOY_IMAGE_GC:-1}" in
  1|true|yes|"")
    ;;
  0|false|no)
    IMAGE_GC_ENABLED=0
    ;;
  *)
    fail "Invalid DEPLOY_IMAGE_GC value: ${DEPLOY_IMAGE_GC}"
    ;;
esac
case "${DEPLOY_SKIP_IMAGE_GC:-0}" in
  0|false|no|"")
    ;;
  1|true|yes)
    IMAGE_GC_ENABLED=0
    ;;
  *)
    fail "Invalid DEPLOY_SKIP_IMAGE_GC value: ${DEPLOY_SKIP_IMAGE_GC}"
    ;;
esac
# Default ON: the shared `hub` CLI on this machine is pinned to the deployed
# revision and its contract validation is strict, so a deploy that leaves it
# behind breaks every agent read at `capabilities` (2026-09-07).
HUB_CLI_REBUILD_ENABLED=1
case "${DEPLOY_SKIP_HUB_CLI_REBUILD:-0}" in
  0|false|no|"")
    ;;
  1|true|yes)
    HUB_CLI_REBUILD_ENABLED=0
    ;;
  *)
    fail "Invalid DEPLOY_SKIP_HUB_CLI_REBUILD value: ${DEPLOY_SKIP_HUB_CLI_REBUILD}"
    ;;
esac
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
    --pull-image)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      PULL_IMAGE="$2"
      shift 2
      ;;
    --recreate-scope)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      RECREATE_SCOPE="$2"
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
    --image-gc)
      IMAGE_GC_ENABLED=1
      shift
      ;;
    --no-image-gc)
      IMAGE_GC_ENABLED=0
      shift
      ;;
    --skip-hub-cli-rebuild)
      HUB_CLI_REBUILD_ENABLED=0
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
  auto|full|dist-only|pull)
    ;;
  *)
    fail "Invalid build mode: ${BUILD_MODE}. Expected auto, full, dist-only, or pull."
    ;;
esac

case "$RECREATE_SCOPE" in
  apps|stack) ;;
  *) fail "Invalid recreate scope: ${RECREATE_SCOPE}. Expected apps or stack." ;;
esac
if [[ "$BUILD_MODE" == "pull" ]]; then
  [[ "$PULL_IMAGE" =~ ^ghcr\.io/([a-z0-9._-]+/)+[a-z0-9._-]+@sha256:[a-f0-9]{64}$ ]] \
    || fail "Pull mode requires --pull-image ghcr.io/owner/image@sha256:<64 lowercase hex characters>"
elif [[ -n "$PULL_IMAGE" ]]; then
  fail "--pull-image requires --mode pull"
fi

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
# One checksum definition for local builds, dist overlays and CI publication.
# shellcheck source=./scripts/deploy-metadata.sh
source "${SCRIPT_DIR}/deploy-metadata.sh"

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
CLEAN_FULL_BASE_TAG=""
REMOTE_DIST_CONTEXT_DIR=""
REMOTE_INFRA_CONTEXT_DIR=""
REMOTE_CANDIDATE_COMPOSE=""
INFRASTRUCTURE_BASELINE=""
POSTGRES_BASELINE=""
PHASE_STARTED_SECONDS=0
DEPLOY_STARTED_SECONDS=$SECONDS
CANDIDATE_IS_FULL_BUILD=0
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
  "0186_ops_metrics_recent_series.sql"
  "0192_fansly_dm_shadow_material_probe.sql"
  "0194_fansly_dm_shadow_reader_probe.sql"
  # Decision 349 (unified chatter account). Both are PURELY ADDITIVE and the
  # previous image never reads them: 0199 creates `account_links` and adds the
  # nullable `device_tokens.last_client_version`; 0200 adds a unique index on
  # lower(username), which the old code neither queries nor violates (it already
  # enforced a case-sensitive UNIQUE on the same column).
  #
  # They are listed here because 0200 is the one migration of this pair that can
  # FAIL on production data — a pre-existing pair of logins differing only in
  # case. Startup owns migration, so that failure lands after the old container
  # is already gone: without these entries the delta (0199 committed and in the
  # ledger, 0200 rolled back with its own transaction) would count as
  # non-compatible, automatic rollback would switch itself off, and production
  # would be left with no running image at all. With them the deploy restores
  # the previous image by itself, and the only manual step left is renaming the
  # colliding login. Precondition query and the failure drill:
  # docs/runbooks/unified-account-deploy.md.
  "0199_account_links.sql"
  "0200_users_username_lower_uidx.sql"
  # Decision 353: additive earnings metadata; old writers remain compatible
  # and retain strict debt through their legacy dirty reason.
  "0201_fan_earnings_content_revision.sql"
  # Decision 378: drops the eight orphaned Workboard v2 tables. Compatible
  # because the image this deploy replaces (301a127a, Decision 376) neither
  # reads nor writes them, so the pre-drop image runs unchanged after a
  # rollback. Listing it keeps automatic rollback armed for this deploy.
  "0203_drop_workboard_tables.sql"
  # Decision 380: drops the five orphaned Workboard v2 enum types that 0203
  # left behind, because a DROP TABLE does not cascade to the types its
  # columns used. Compatible because the image this deploy replaces
  # (58dd9bea, Decisions 376/378) neither reads nor writes them, so the
  # pre-drop image runs unchanged after a rollback. Listing it keeps
  # automatic rollback armed for this deploy.
  "0204_drop_workboard_enum_types.sql"
  # Decision 381: two PURELY ADDITIVE tables the paging sweep owns
  # (`notification_incident_paging`, `notification_incident_cycles`) plus a
  # one-off seed read from existing rows. The image this deploy replaces
  # neither reads nor writes them and still pages through its own direct
  # send path, so it runs unchanged after a rollback. Listing it keeps
  # automatic rollback armed for this deploy.
  "0205_notification_incident_paging.sql"
  # Additive B1 receipt evidence; old writers leave the nullable fields empty.
  "0206_fansly_ws_hint_settlement.sql"
  # H2 (amends #265): webhook auto-redelivery. 0207 is additive for the image
  # it replaces: the old manual insert omits origin (default 'manual') and
  # supplies an actor, so it satisfies the new checks; the widened state check,
  # new indexes and the new state table are never read by the old image, and
  # the old history view keeps its attempt-level lookup. Known caveat: the old
  # image counts every intent of the UTC day toward its manual limit of 20, so
  # automatic intents written before a rollback can block manual redelivery
  # until UTC midnight. 0208 only builds two indexes concurrently.
  "0207_ofapi_webhook_auto_redelivery.sql"
  "0208_ofapi_webhook_delivery_business_key_idx.sql"
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
  scripts/deploy-metadata.sh \
  scripts/deploy-infrastructure.mjs \
  scripts/verify-desktop-lifecycle-v2-evidence.mjs
do
  if [[ -e "${ROOT_DIR}/${file}" ]]; then
    REMOTE_RELEASE_FILES+=("$file")
  fi
done

DIST_OVERLAY_PATHS=(
  apps/dashboard/dist
  apps/runtime/dist
  packages/db/dist
  packages/db/migrations
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
  CLEAN_FULL_BASE_TAG="${IMAGE_TAG}-full-${APP_DEPENDENCY_CHECKSUM}"
  ROLLBACK_IMAGE_TAG="${IMAGE_TAG}-rollback-${source_tag_component}-${DEPLOY_RUN_ID}"

  log "Build metadata: revision=${APP_SOURCE_REVISION}, dependency_checksum=${APP_DEPENDENCY_CHECKSUM}, run_id=${DEPLOY_RUN_ID}"
  log "Deploy image tags: candidate=${IMAGE_CANDIDATE_TAG}, rollback=${ROLLBACK_IMAGE_TAG}, clean_full_base=${CLEAN_FULL_BASE_TAG}"
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
      printf 'clean_full_base_tag=%s\n' "$CLEAN_FULL_BASE_TAG"
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
  run_remote "set -euo pipefail; if [[ -d ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED} ]]; then if [[ -f ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/owner ]] && [[ \"\$(cat ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}/owner)\" == $(printf '%q' "$DEPLOY_RUN_ID") ]]; then rm -rf ${REMOTE_DEPLOY_LOCK_DIR_ESCAPED}; else printf '[deploy] remote lock owner changed; leaving %s in place\n' $(printf '%q' "$REMOTE_DEPLOY_LOCK_DIR") >&2; exit 1; fi; fi" \
    || return 1
  REMOTE_DEPLOY_LOCK_ACQUIRED=0
}

cleanup_deploy() {
  local exit_status=$?

  if [[ "$exit_status" != "0" && "${STACK_RECREATED:-0}" != "1" && "${LEGACY_SYNC_QUIESCED:-0}" == "1" ]]; then
    restore_quiesced_sync_services \
      || log "Unable to restart quiesced sync services during deploy cleanup"
  fi

  if [[ -n "${REMOTE_DIST_CONTEXT_DIR:-}" ]]; then
    remove_remote_dist_context || log "Unable to remove remote dist context ${REMOTE_DIST_CONTEXT_DIR}"
  fi

  if [[ -n "${REMOTE_INFRA_CONTEXT_DIR:-}" ]]; then
    run_remote "rm -rf $(printf '%q' "$REMOTE_INFRA_CONTEXT_DIR")" \
      || log "Unable to remove deploy infrastructure context"
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
    printf 'clean_full_base_tag=%s\n' $(printf '%q' "$CLEAN_FULL_BASE_TAG")
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

remove_remote_dist_context() {
  [[ -n "${REMOTE_DIST_CONTEXT_DIR:-}" ]] || return 0
  case "$REMOTE_DIST_CONTEXT_DIR" in
    /tmp/agency-hub-dist-overlay-*[!/])
      ;;
    *)
      log "Refusing to remove unexpected remote dist context ${REMOTE_DIST_CONTEXT_DIR}"
      return 1
      ;;
  esac

  run_remote "set -euo pipefail; rm -rf $(printf '%q' "$REMOTE_DIST_CONTEXT_DIR")" || return 1
  REMOTE_DIST_CONTEXT_DIR=""
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
  # Resume the existing containers only. Converging dependencies with `up` here
  # could recreate PostgreSQL after the infrastructure guard just rejected drift.
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} start scheduler worker" \
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

# Decision #239: a deploy recreates the runtime containers, and a
# `capture:backfill --execute` running inside one of them dies with them.
# That is exactly how production run 1 ended on 2026-08-18 — the #87 deploy
# killed a walk that had stamped 362,804 rows, and its `capture_rewrite_runs`
# row still said `verdict = running, completed_at NULL` eight days later. The
# runtime now settles its own row on SIGTERM, but the better outcome is that the
# two acts never overlap: an hours-long owner-run rewrite and a deploy are both
# owner-initiated, so "not at the same time" is a schedule, not a race.
#
# IT IS ASKED TWICE. Once before the build, because the build is the expensive
# half and there is nothing to learn from paying for it first; and again
# immediately before `up -d --force-recreate`, because a ~6 minute build is
# plenty of window for an owner to start a walk in, and the recreate is the
# statement that would actually kill it. The second call is on the MAIN path
# only — a rollback is already an emergency and must not be blocked.
verify_remote_no_capture_rewrite_in_flight() {
  local in_flight
  in_flight="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} exec -T postgres sh -c 'set -eu
export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atq <<'\''SQL'\''
SELECT CASE
  WHEN to_regclass('\''public.capture_rewrite_runs'\'') IS NULL THEN 0
  ELSE (
    SELECT count(*) FROM capture_rewrite_runs
    WHERE verdict = '\''running'\'' AND dry_run = false AND completed_at IS NULL
  )
END;
SQL'")" || return 1

  if [[ "$in_flight" != "0" ]]; then
    printf '[deploy] %s capture_rewrite_runs row(s) are still `running`.\n' "$in_flight" >&2
    printf '[deploy] A deploy recreates the runtime containers and would kill an in-flight\n' >&2
    printf '[deploy] capture:backfill / capture:reclaim mid-walk. Let it finish, or settle a\n' >&2
    printf '[deploy] row that is stale:\n' >&2
    printf '[deploy]   select id, operation, scope_table, scope_month, phase, started_at\n' >&2
    printf '[deploy]     from capture_rewrite_runs where verdict = %s;\n' "'running'" >&2
    return 1
  fi
  log "No capture rewrite run is in flight"
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
  local attempt
  local max_attempts=30
  local attempt_output="${output_file}.attempt"

  for (( attempt = 1; attempt <= max_attempts; attempt += 1 )); do
    if run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} exec -T postgres sh -c 'set -eu
export PGPASSWORD=\"\$POSTGRES_PASSWORD\"
psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atq <<'\''SQL'\''
BEGIN;
DO \$deploy_schema_capture\$
BEGIN
  IF NOT pg_try_advisory_xact_lock(31415, 27182) THEN
    RAISE EXCEPTION \$message\$deploy schema capture lock is busy\$message\$
      USING ERRCODE = \$code\$55P03\$code\$;
  END IF;
  CREATE TEMP TABLE deploy_schema_migrations(id text) ON COMMIT DROP;
  IF to_regclass(\$q\$public.schema_migrations\$q\$) IS NOT NULL THEN
    EXECUTE \$q\$insert into deploy_schema_migrations select id from schema_migrations order by id\$q\$;
  END IF;
END
\$deploy_schema_capture\$;
SELECT id FROM deploy_schema_migrations ORDER BY id;
COMMIT;
SQL'" >"$attempt_output"; then
      mv "$attempt_output" "$output_file" || return 1
      return 0
    fi

    if (( attempt < max_attempts )); then
      sleep 1
    fi
  done

  rm -f "$attempt_output"
  return 1
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
  verify_service_image_labels scheduler
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

  log "Building ${IMAGE_CANDIDATE_TAG} locally from ${ROOT_DIR} for ${BUILD_PLATFORM}"
  DOCKER_BUILDKIT=1 docker build \
    --platform="${BUILD_PLATFORM}" \
    --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
    --build-arg "APP_DEPENDENCY_CHECKSUM=${APP_DEPENDENCY_CHECKSUM}" \
    --build-arg "APP_SOURCE_REVISION=${APP_SOURCE_REVISION}" \
    -t "$IMAGE_CANDIDATE_TAG" \
    "$ROOT_DIR"
}

load_candidate_image() {
  log "Loading ${IMAGE_CANDIDATE_TAG} on ${REMOTE}"
  docker save "$IMAGE_CANDIDATE_TAG" | ssh "${SSH_ARGS[@]}" "$REMOTE" docker load >/dev/null
}

validate_pull_checkout() {
  [[ "$BUILD_MODE" == "pull" ]] || return 0
  local revision untracked
  revision="$(calculate_source_revision)" || { log "Unable to identify pull checkout"; return 1; }
  [[ "$revision" =~ ^[a-f0-9]{12}$ && "$revision" == "$APP_SOURCE_REVISION" ]] \
    || { log "Pull deploy requires the unchanged, clean checkout of the image revision"; return 1; }
  [[ "$(calculate_dependency_checksum)" == "$APP_DEPENDENCY_CHECKSUM" ]] \
    || { log "Dependency manifests changed during pull deploy"; return 1; }
  # git status --untracked-files=no alone misses SQL that the release preflight
  # sees on disk but the CI image could not contain. Generated dist is ignored.
  untracked="$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- apps packages scripts \
    Dockerfile .dockerignore docker-compose.production.yml .env.production.example README.md)" \
    || { log "Unable to check untracked release inputs"; return 1; }
  [[ -z "$untracked" ]] || { log "Pull checkout contains untracked release inputs; commit or move them first"; return 1; }
}

pull_candidate_image() {
  local metadata
  log "Pulling immutable candidate ${PULL_IMAGE} on ${REMOTE}"
  run_remote "set -euo pipefail; docker pull --platform=$(printf '%q' "$BUILD_PLATFORM") $(printf '%q' "$PULL_IMAGE")" \
    || return 1
  metadata="$(run_remote "docker image inspect --format '{{.Os}}/{{.Architecture}}|{{index .Config.Labels \"agency-hub.source-revision\"}}|{{index .Config.Labels \"agency-hub.dependency-checksum\"}}' $(printf '%q' "$PULL_IMAGE")")" \
    || return 1
  [[ "$metadata" == "${BUILD_PLATFORM}|${APP_SOURCE_REVISION}|${APP_DEPENDENCY_CHECKSUM}" ]] \
    || { log "Pulled candidate platform/revision/checksum does not match this checkout"; return 1; }
  # Retag only the digest we inspected. No lookup by mutable release tag.
  run_remote "set -euo pipefail; docker tag $(printf '%q' "$PULL_IMAGE") $(printf '%q' "$IMAGE_CANDIDATE_TAG")" \
    || return 1
  log "Pulled candidate identity verified before service changes"
}

prepare_remote_infrastructure_check() {
  [[ "$RECREATE_SCOPE" == "apps" ]] || return 0
  REMOTE_INFRA_CONTEXT_DIR="/tmp/agency-hub-infra-${DEPLOY_RUN_ID}"
  local context project
  context="$(printf '%q' "$REMOTE_INFRA_CONTEXT_DIR")"
  project="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; id=\$(${REMOTE_COMPOSE} ps -q postgres); [[ -n \"\$id\" ]]; docker inspect --format '{{index .Config.Labels \"com.docker.compose.project\"}}' \"\$id\"")" \
    || fail "App release requires an existing PostgreSQL container"
  [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Cannot identify existing Compose project"
  # Match production's project directory so relative bind/env paths and default
  # network/volume names do not depend on this temporary YAML file's location.
  REMOTE_CANDIDATE_COMPOSE="${REMOTE_RUNTIME_IMAGE_ENV} docker compose --project-name $(printf '%q' "$project") --project-directory ${REMOTE_APP_DIR_ESCAPED} --env-file ${REMOTE_APP_DIR_ESCAPED}/.env.production -f ${context}/docker-compose.production.yml"
  ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "mkdir -p ${context} && cat > ${context}/docker-compose.production.yml" \
    <"${ROOT_DIR}/docker-compose.production.yml" || fail "Unable to stage Compose preflight"
  INFRASTRUCTURE_BASELINE="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} config --format json" \
    | node "${SCRIPT_DIR}/deploy-infrastructure.mjs")" || fail "Unable to read current infrastructure configuration"
}

verify_remote_infrastructure_unchanged() {
  [[ "$RECREATE_SCOPE" == "apps" ]] || return 0
  local compose="${1:-$REMOTE_CANDIDATE_COMPOSE}"
  local fingerprint current expected_hash expected_image current_id config_hash image_id state health project
  fingerprint="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${compose} config --format json" \
    | node "${SCRIPT_DIR}/deploy-infrastructure.mjs")" || return 1
  [[ -n "$INFRASTRUCTURE_BASELINE" && "$fingerprint" == "$INFRASTRUCTURE_BASELINE" ]] \
    || { log "PostgreSQL or shared Compose configuration differs"; return 1; }
  expected_hash="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${compose} config --hash postgres")" || return 1
  expected_hash="${expected_hash#postgres }"
  [[ "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || { log "Invalid PostgreSQL config hash"; return 1; }
  expected_image="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; image=\$(${compose} config --images postgres); [[ -n \"\$image\" ]]; docker image inspect --format '{{.Id}}' \"\$image\"")" || return 1
  current="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; id=\$(${REMOTE_COMPOSE} ps -q postgres); [[ -n \"\$id\" ]]; docker inspect --format '{{.Id}}|{{index .Config.Labels \"com.docker.compose.config-hash\"}}|{{.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{index .Config.Labels \"com.docker.compose.project\"}}' \"\$id\"")" || return 1
  IFS='|' read -r current_id config_hash image_id state health project <<<"$current"
  [[ "$current_id" =~ ^[a-f0-9]{64}$ && "$expected_image" =~ ^sha256:[a-f0-9]{64}$ \
    && "$config_hash" == "$expected_hash" && "$image_id" == "$expected_image" \
    && "$state" == "running" && "$health" == "healthy" && -n "$project" ]] \
    || { log "PostgreSQL is unavailable, unhealthy, or differs from the planned app release"; return 1; }
  if [[ -n "$POSTGRES_BASELINE" && "$current" != "$POSTGRES_BASELINE" ]]; then
    log "PostgreSQL container changed during deployment"
    return 1
  fi
  POSTGRES_BASELINE="$current"
  log "App release preserves existing healthy PostgreSQL and shared infrastructure"
}

read_remote_clean_full_base_dependency_checksum() {
  local template
  template='{{ index .Config.Labels "agency-hub.dependency-checksum" }}'
  run_remote "set -euo pipefail; docker image inspect -f $(printf '%q' "$template") $(printf '%q' "$CLEAN_FULL_BASE_TAG")" 2>/dev/null || true
}

validate_dist_only_base() {
  if [[ "${ROLLBACK_IMAGE_AVAILABLE:-0}" != "1" ]]; then
    fail "Dist-only deploy requires a captured remote rollback image for rollback and capability verification"
  fi

  run_remote "set -euo pipefail; docker image inspect $(printf '%q' "$CLEAN_FULL_BASE_TAG") >/dev/null" \
    >/dev/null 2>&1 \
    || fail "Dist-only deploy requires pinned clean full image ${CLEAN_FULL_BASE_TAG}. Run a full deploy to establish it."

  local remote_checksum
  remote_checksum="$(read_remote_clean_full_base_dependency_checksum)"
  if [[ "$remote_checksum" == "<no value>" ]]; then
    remote_checksum=""
  fi

  if [[ -z "$remote_checksum" ]]; then
    if [[ "$ALLOW_UNLABELED_DIST_BASE" == "1" ]]; then
      log "Pinned clean full image has no dependency checksum label; continuing because --allow-unlabeled-dist-base was set"
      return 0
    fi
    fail "Dist-only deploy cannot prove dependency compatibility because ${CLEAN_FULL_BASE_TAG} is unlabeled. Re-run with --allow-unlabeled-dist-base only if package manifests, lockfile, and Dockerfile are compatible with that clean full image."
  fi

  if [[ "$remote_checksum" != "$APP_DEPENDENCY_CHECKSUM" ]]; then
    fail "Dist-only deploy refused: dependency checksum changed (${remote_checksum} -> ${APP_DEPENDENCY_CHECKSUM}). Run a full deploy to establish a compatible clean base."
  fi

  log "Pinned clean full image ${CLEAN_FULL_BASE_TAG} matches dependency checksum ${APP_DEPENDENCY_CHECKSUM}"
}

copy_dist_overlay_path() {
  local relative_path="$1"
  local source_path="${ROOT_DIR}/${relative_path}"
  local target_path="${DIST_CONTEXT_DIR}/${relative_path}"

  [[ -e "$source_path" ]] || fail "Dist-only deploy output is missing: ${relative_path}"
  mkdir -p "$(dirname "$target_path")" || return 1
  cp -R "$source_path" "$target_path" || return 1
}

prune_macos_metadata_files() {
  local target_dir="$1"
  find "$target_dir" \( -name '._*' -o -name '.DS_Store' \) -type f -delete
}

create_dist_overlay_context() {
  DIST_CONTEXT_DIR="${TEMP_DIR}/dist-overlay-context"
  mkdir -p "$DIST_CONTEXT_DIR" || return 1

  cat >"${DIST_CONTEXT_DIR}/Dockerfile" <<EOF || return 1
FROM ${CLEAN_FULL_BASE_TAG}

ARG APP_DEPENDENCY_CHECKSUM=unknown
ARG APP_SOURCE_REVISION=unknown

LABEL agency-hub.dependency-checksum="\${APP_DEPENDENCY_CHECKSUM}"
LABEL agency-hub.source-revision="\${APP_SOURCE_REVISION}"

COPY apps/dashboard/dist /app/apps/dashboard/dist
COPY apps/runtime/dist /app/apps/runtime/dist
COPY packages/db/dist /app/packages/db/dist
COPY packages/db/migrations /app/packages/db/migrations
EOF

  local path
  for path in "${DIST_OVERLAY_PATHS[@]}"; do
    copy_dist_overlay_path "$path" || return 1
  done
  prune_macos_metadata_files "$DIST_CONTEXT_DIR"
}

build_dist_only_candidate_image() {
  require_command pnpm
  validate_dist_only_base

  # This function is invoked as `build_dist_only_candidate_image || fail …`,
  # which disables errexit inside it — every step needs explicit propagation
  # or a failed local build would upload a stale dist overlay.
  log "Building production JS/CSS artifacts locally"
  (cd "$ROOT_DIR" && pnpm build:production) || return 1
  create_dist_overlay_context || return 1

  # Owned by the EXIT trap from here on: cleanup_deploy is the single code path
  # that removes this remote directory, on success and on failure alike.
  REMOTE_DIST_CONTEXT_DIR="/tmp/agency-hub-dist-overlay-${DEPLOY_RUN_ID}"
  local remote_context_escaped
  remote_context_escaped="$(printf '%q' "$REMOTE_DIST_CONTEXT_DIR")"

  log "Uploading dist-only build context to ${REMOTE}:${REMOTE_DIST_CONTEXT_DIR}"
  tar -C "$DIST_CONTEXT_DIR" -cf - . | ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "bash -lc $(printf '%q' "set -euo pipefail; rm -rf ${remote_context_escaped}; mkdir -p ${remote_context_escaped}; tar -xf - -C ${remote_context_escaped}")" \
    >/dev/null || return 1
  # The pipeline's exit status is ssh's; a mid-stream local tar failure closes
  # ssh's stdin early and the remote `tar -xf -` (under pipefail) fails with it.

  log "Building ${IMAGE_CANDIDATE_TAG} on ${REMOTE} from pinned clean full image ${CLEAN_FULL_BASE_TAG}"
  run_remote "set -euo pipefail; docker build --platform=$(printf '%q' "$BUILD_PLATFORM") --build-arg APP_DEPENDENCY_CHECKSUM=$(printf '%q' "$APP_DEPENDENCY_CHECKSUM") --build-arg APP_SOURCE_REVISION=$(printf '%q' "$APP_SOURCE_REVISION") -t $(printf '%q' "$IMAGE_CANDIDATE_TAG") ${remote_context_escaped}" || return 1
}

publish_remote_clean_full_base_image() {
  if [[ "${CANDIDATE_IS_FULL_BUILD:-0}" != "1" ]]; then
    return 0
  fi

  log "Publishing clean full image base ${CLEAN_FULL_BASE_TAG}"
  run_remote "set -euo pipefail; docker tag $(printf '%q' "$IMAGE_CANDIDATE_TAG") $(printf '%q' "$CLEAN_FULL_BASE_TAG")"
}

# Local tooling, not production: rebuilds this machine's production-pinned
# `hub` CLI from the revision that was just deployed and verified. It runs only
# after every health gate has passed and must never fail a healthy deploy, so
# the caller wraps it in `|| log`, never `fail` (which would roll production
# back over a laptop-side problem).
rebuild_local_hub_cli() {
  if [[ "$HUB_CLI_REBUILD_ENABLED" != "1" ]]; then
    log "Skipping the local hub CLI rebuild (disabled for this run)"
    return 0
  fi
  case "$APP_SOURCE_REVISION" in
    unknown|*-dirty)
      log "Skipping the local hub CLI rebuild: source revision ${APP_SOURCE_REVISION} is not a clean commit"
      return 0
      ;;
  esac
  log "Rebuilding the production-pinned hub CLI from ${APP_SOURCE_REVISION}"
  "${SCRIPT_DIR}/rebuild-hub-cli-prod.sh" "$APP_SOURCE_REVISION"
}

gc_remote_deploy_images() {
  if [[ "${IMAGE_GC_ENABLED:-1}" != "1" ]]; then
    log "Skipping remote image GC (disabled for this run; the default is on, Decision #371)"
    return 0
  fi

  # %:* (last colon) keeps a registry port intact: registry:5000/team/runtime:tag
  # must reduce to registry:5000/team/runtime, not to "registry".
  local runtime_repo="${IMAGE_TAG%:*}"
  # Candidate/rollback/full-base tags are minted as "${IMAGE_TAG}-candidate-..."
  # — derive the prefix from the configured release tag instead of hard-coding
  # it, or a non-default --image tag would make the GC skip everything it just
  # created. Superseded clean bases ("-full-<checksum>") are swept too: the
  # current one is protected through the keep-set, and a rollback image keeps
  # its own base layers alive by reference even after the base TAG is gone.
  local release_tag_prefix="${IMAGE_TAG##*:}"
  local remote_command
  remote_command=$(cat <<EOF
set -euo pipefail
cd ${REMOTE_APP_DIR_ESCAPED}

# Keyed by FULL sha256 image id. Short ids from 'docker images --format
# {{.ID}}' never compare equal to the inspect form, so every tag would look
# unprotected; the set is keyed so repeated ids cannot inflate its size.
declare -A keep_ids=()

for protected_tag in $(printf '%q' "$IMAGE_TAG") $(printf '%q' "$IMAGE_CANDIDATE_TAG") $(printf '%q' "$ROLLBACK_IMAGE_TAG") $(printf '%q' "$CLEAN_FULL_BASE_TAG"); do
  [[ -n "\$protected_tag" ]] || continue
  protected_id="\$(docker image inspect -f '{{.Id}}' "\$protected_tag" 2>/dev/null || true)"
  [[ -n "\$protected_id" ]] || continue
  keep_ids["\$protected_id"]=1
done

while IFS= read -r container_id; do
  [[ -n "\$container_id" ]] || continue
  container_image_id="\$(docker inspect -f '{{.Image}}' "\$container_id" 2>/dev/null || true)"
  [[ -n "\$container_image_id" ]] || continue
  keep_ids["\$container_image_id"]=1
done < <(${REMOTE_COMPOSE} ps -q 2>/dev/null || true)

# A partially resolved keep set means inspects failed, not that the host is
# clean. Deleting on that evidence would be mass deletion, so stop instead.
if (( \${#keep_ids[@]} < 2 )); then
  printf '[deploy] image GC aborted: resolved only %s protected image id(s)\n' "\${#keep_ids[@]}" >&2
  exit 0
fi

removed=0
while IFS= read -r image_ref; do
  release_tag="\${image_ref##*:}"
  case "\$release_tag" in
    $(printf '%q' "$release_tag_prefix")-candidate-*|$(printf '%q' "$release_tag_prefix")-rollback-*|$(printf '%q' "$release_tag_prefix")-full-*)
      ;;
    *)
      continue
      ;;
  esac

  image_id="\$(docker image inspect -f '{{.Id}}' "\$image_ref" 2>/dev/null || true)"
  [[ -n "\$image_id" ]] || continue
  [[ -z "\${keep_ids[\$image_id]:-}" ]] || continue

  if docker rmi "\$image_ref" >/dev/null 2>&1; then
    removed=\$(( removed + 1 ))
    printf '[deploy] removed superseded deploy image tag %s\n' "\$image_ref" >&2
  else
    printf '[deploy] unable to remove image tag %s; leaving it in place\n' "\$image_ref" >&2
  fi
done < <(docker images --format '{{.Repository}}:{{.Tag}}' $(printf '%q' "$runtime_repo") 2>/dev/null || true)

printf '[deploy] image GC removed %s superseded deploy image tag(s)\n' "\$removed" >&2
docker builder prune --force --filter until=168h >/dev/null 2>&1 \
  || printf '[deploy] builder cache prune failed; continuing\n' >&2
EOF
)

  log "Garbage collecting superseded ${runtime_repo} deploy image tags on ${REMOTE}"
  run_remote "$remote_command"
}

build_candidate_image() {
  case "$BUILD_MODE" in
    full)
      build_full_candidate_image || fail "Full Docker build failed"
      load_candidate_image || fail "Unable to load candidate image on remote"
      CANDIDATE_IS_FULL_BUILD=1
      ;;
    dist-only)
      CANDIDATE_IS_FULL_BUILD=0
      build_dist_only_candidate_image || fail "Dist-only candidate image build failed"
      ;;
    pull)
      CANDIDATE_IS_FULL_BUILD=0
      pull_candidate_image || fail "Unable to pull and verify candidate image"
      ;;
    auto)
      if build_full_candidate_image; then
        load_candidate_image || fail "Unable to load candidate image on remote"
        CANDIDATE_IS_FULL_BUILD=1
      else
        log "Full Docker build failed before release sync; attempting dist-only fallback because --mode auto was set"
        CANDIDATE_IS_FULL_BUILD=0
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

if [[ "$BUILD_MODE" != "pull" ]]; then
  require_command docker
fi
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
validate_pull_checkout || fail "Pull checkout validation failed"
start_phase preflight
acquire_local_deploy_lock
preflight_migration_files
acquire_remote_deploy_lock

log "Validating remote Docker access"
run_remote "set -euo pipefail; docker version >/dev/null"
verify_remote_no_capture_rewrite_in_flight \
  || fail "A capture rewrite run is in flight on ${REMOTE}; deploying would kill it mid-walk"
capture_remote_rollback_image
capture_remote_release_files

finish_phase preflight
start_phase candidate
build_candidate_image
finish_phase candidate
start_phase candidate-verification
validate_pull_checkout || fail "Pull checkout changed during candidate preparation"
verify_candidate_lifecycle_capability
prepare_remote_infrastructure_check
verify_remote_infrastructure_unchanged || fail "App release would change PostgreSQL/infrastructure; review an explicit --recreate-scope stack deployment"
finish_phase candidate-verification
start_phase migrations
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

finish_phase migrations
start_phase release-sync
log "Syncing release files to ${REMOTE}:${APP_DIR}"
tar -C "$ROOT_DIR" -cf - "${REMOTE_RELEASE_FILES[@]}" | ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "mkdir -p ${REMOTE_APP_DIR_ESCAPED} && tar -xf - -C ${REMOTE_APP_DIR_ESCAPED}" \
  || fail_after_release_sync "Unable to sync release files to remote"

log "Validating remote prerequisites"
run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && test -f .env.production && docker compose version >/dev/null && ${REMOTE_COMPOSE} config >/dev/null" \
  || fail_after_release_sync "Remote prerequisite validation failed after syncing release files"
SYNC_MONITORING_TOKEN="$(read_remote_env_value "HEALTH_SYNC_MONITORING_TOKEN")" \
  || fail_after_release_sync "Unable to read monitoring token after syncing release files"

finish_phase release-sync
start_phase recreate
log "Recreating the remote production stack"
if [[ "$LIFECYCLE_FIRST_ENABLE" == "1" ]]; then
  # The owner binding can be revoked or transferred while a long candidate
  # build runs. Re-read it at the last safe point before promotion.
  verify_candidate_lifecycle_inventory
  ROLLBACK_FORBIDDEN=1
  ROLLBACK_FORBIDDEN_REASON="desktop-lifecycle-v2 was enabled; capability rollback is unsafe"
  log "Automatic rollback disabled before the one-way desktop-lifecycle-v2 transition"
fi
# The pre-build check is minutes old by now — a full build takes ~6 min and an
# owner can start a capture:backfill inside that window. THIS is the statement
# that would kill it, so this is where the question has to be asked again.
# Deliberately NOT in the rollback path: a rollback is already an emergency and
# must not be blocked by a rewrite it is arguably rescuing.
verify_remote_no_capture_rewrite_in_flight \
  || fail_after_release_sync "A capture rewrite run started during the build on ${REMOTE}; recreating the containers now would kill it mid-walk"
validate_pull_checkout || fail_after_release_sync "Pull checkout changed before promotion"
verify_remote_infrastructure_unchanged "$REMOTE_COMPOSE" || fail_after_release_sync "PostgreSQL/infrastructure changed during deploy; refusing app-only promotion"
run_remote "set -euo pipefail; docker tag $(printf '%q' "$IMAGE_CANDIDATE_TAG") $(printf '%q' "$IMAGE_TAG")" \
  || fail_after_release_sync "Unable to promote candidate image tag after validation"
RECREATE_SERVICES=""
if [[ "$RECREATE_SCOPE" == "apps" ]]; then
  RECREATE_SERVICES="api worker scheduler"
fi
STACK_RECREATED=1
if ! run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build ${RECREATE_SERVICES}"; then
  ROLLBACK_COMPOSE_RECREATE_FAILED=1
  fail "docker compose failed while recreating the production stack"
fi
LEGACY_SYNC_QUIESCED=0
finish_phase recreate
start_phase service-health

log "Waiting for ${VERIFY_URL%/}/api/v1/health"
wait_for_api_health "$HEALTH_FILE" || fail "API health never reached 200 at ${VERIFY_URL%/}/api/v1/health"
verify_post_deploy_lifecycle_capability \
  || fail "Production health capability does not match the verified candidate"

log "Waiting for the worker container healthcheck"
wait_for_worker_health || fail "Worker container never reached a healthy state"

log "Waiting for the scheduler container healthcheck"
wait_for_scheduler_health || fail "Scheduler container never reached a healthy state"

verify_post_deploy_image_labels
finish_phase service-health
start_phase sync-health

if [[ -n "$SYNC_MONITORING_TOKEN" ]]; then
  log "Verifying sync health endpoint"
  wait_for_sync_health "$SYNC_FILE" || fail "Unexpected /api/v1/health/sync status: ${SYNC_STATUS_CODE}"
else
  SYNC_STATUS_CODE="skipped"
  log "Skipping protected sync health verification because HEALTH_SYNC_MONITORING_TOKEN is not set"
fi

finish_phase sync-health
start_phase dashboard
log "Verifying same-origin dashboard delivery"
DASHBOARD_STATUS_CODE="$(curl_status "$DASHBOARD_FILE" "${VERIFY_URL%/}/login" || true)"
[[ "$DASHBOARD_STATUS_CODE" == "200" ]] || fail "Unexpected /login status: ${DASHBOARD_STATUS_CODE}"
grep -qi '<!doctype html>' "$DASHBOARD_FILE" || fail "Dashboard route did not return HTML"
grep -q 'id="root"' "$DASHBOARD_FILE" || fail "Dashboard HTML is missing the root mount"

finish_phase dashboard
log "Production verified; elapsed_seconds=$((SECONDS - DEPLOY_STARTED_SECONDS))"
start_phase release-finalization
publish_remote_clean_full_base_image \
  || fail "Deployment is healthy but the pinned clean full image tag could not be published"

# Disk hygiene only, and it runs after every health gate has passed. A healthy
# deploy is never failed by cleanup.
gc_remote_deploy_images || log "Image GC step failed; continuing"

finish_phase release-finalization
start_phase local-cli
rebuild_local_hub_cli || log "WARNING: the local hub CLI rebuild failed; run scripts/rebuild-hub-cli-prod.sh ${APP_SOURCE_REVISION} by hand before any agent read"

finish_phase local-cli
log "Deployment verified successfully; elapsed_seconds=$((SECONDS - DEPLOY_STARTED_SECONDS))"
log "API health: ${VERIFY_URL%/}/api/v1/health"
log "Sync health: ${VERIFY_URL%/}/api/v1/health/sync (status ${SYNC_STATUS_CODE})"
