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
                        CI no longer publishes images; pull mode needs an
                        image published manually for this exact commit.
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
  --drop-client-sdk <sha256>
                        Owner-approved: let this candidate drop one client SDK
                        contract hash or registry build that the running hub
                        registers. Repeat once per value the gate names. No
                        environment equivalent: a drop is a per-run decision.
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
DROP_CLIENT_SDKS=()

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
    --drop-client-sdk)
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      [[ "$2" =~ ^[a-f0-9]{64}$ ]] || fail "--drop-client-sdk takes a lowercase sha256 (64 hex characters)"
      DROP_CLIENT_SDKS+=("$2")
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
  # INC-001 H2: one new table (`observation_parse_quarantine`) plus its index,
  # both IF NOT EXISTS, no FK and no change to any existing table. The previous
  # image never names the table (it stamps a quarantined PPV exactly as before,
  # just without writing the outcome row) and its schema guard only checks its
  # own latest migration, so it runs unchanged after a rollback; a later
  # re-deploy finds the migration already applied.
  "0209_observation_parse_quarantine.sql"
  # Desktop media images: five new tables (ofapi_media_locators,
  # ofapi_media_links, ofapi_media_fetch_log, ofapi_media_daily_budget,
  # ofapi_media_flights), all
  # IF NOT EXISTS, no change to any existing table. The previous image never
  # names them and has no media routes (a new desktop then shows images as
  # unavailable), so it runs unchanged after a rollback; a later re-deploy
  # finds the migration already applied.
  "0210_ofapi_media_images.sql"
  # AI media describer: one enum value (ledger-only feature `media-describe`)
  # and three new tables (ai_media_descriptions, ai_media_description_links,
  # ai_media_describe_days), all IF NOT EXISTS, no change to any existing table.
  # The previous image never names the tables. Its only contact with the enum
  # value is the owner Usage report, which throws on an unknown feature — so a
  # rollback is clean while the describer has written no ledger row (it ships
  # with AI_MEDIA_DESCRIBE_ENABLED off, and a failed deploy rolls back before
  # anyone enables it). A later re-deploy finds both migrations applied.
  "0211_ai_usage_feature_media_describe.sql"
  "0212_ai_media_descriptions.sql"
  # AI media describer, Fansly accelerator: one new table
  # (ai_media_accelerator_reads), IF NOT EXISTS, no change to any existing
  # table; the previous image never names it.
  "0213_ai_media_accelerator_reads.sql"
  # AI media describer claim ownership: one nullable column (lease_token) on
  # ai_media_descriptions; the previous image never names it and settles by id.
  "0214_ai_media_describe_lease_token.sql"
  # AI media describer, Fansly fast lane: five additive columns with defaults
  # on ai_media_accelerator_reads (the old image inserts without them) and one
  # new table (ai_media_fast_lane_health) it never names.
  "0215_ai_media_fansly_fast_lane.sql"
  # AI media describer, OnlyFans source: widens two CHECKs of 0210's tables
  # (variant + 'preview', source + 'resolve'). The previous image never writes
  # either value and filters locators by the variant it asks for, so it runs
  # unchanged on rows the new image wrote.
  "0216_ofapi_media_preview_variant.sql"
  # Two indexes built concurrently (purchase-history captures, DM 5xx streak);
  # no table, column or query changes, so the previous image runs unchanged
  # on them.
  "0223_raw_payload_and_attempt_lookup_indexes.sql"
  # Once-a-day Fansly fan lookup: three nullable columns on page_fans, no
  # default. The previous image never names them and writes page_fans by named
  # columns, so it runs unchanged after a rollback (and simply looks every fan
  # up again, as it always did).
  "0224_page_fan_account_lookup_stamps.sql"
  # Fansly per-page send guard (plan §2.5): two new tables, a seed row per
  # Fansly page and grants. The previous image never names either table, so
  # after a rollback it runs unchanged (without the guard, as before).
  "0225_fansly_page_send_guards.sql"
  # Fansly WS live overlay: one new table (dm_live_messages) and three
  # columns on fansly_ws_decode_receipts with defaults (the old image's capture
  # insert names neither, so its rows start 'pending' and the next image
  # applies them), plus a NOT VALID check and two partial indexes. The previous
  # image never names the table or the columns, so it runs unchanged after a
  # rollback; a later re-deploy finds the migration already applied.
  "0226_fansly_ws_live_overlay.sql"
  # Send guard checks (plan §2.4/§10): a nullable lease-end column on the
  # 0225 journal (catalog-only, no default) and the pace check's one-row
  # cursor table. The previous image names neither, so it runs unchanged.
  "0227_fansly_send_guard_checks.sql"
  # Fansly Sync Engine core state (design §2.2): three new tables (sync_pages,
  # sync_work, sync_attempts), two pure SQL functions, a seed row per Fansly
  # page (mode 'off') and grants. The previous image never names any of them,
  # so after a rollback it runs unchanged; a later re-deploy finds the
  # migration already applied.
  "0228_sync_engine_core.sql"
  # Owner of the Fansly send guard (sync engine design §2.7): two columns on
  # fansly_page_send_guards, owner_engine defaulting to 'legacy', plus a check.
  # The previous image never names them, and its capture (which does not test
  # the owner) is right while every row is 'legacy' — all of step 2; only the
  # step-3 switch flips a row.
  "0229_send_guard_owner_engine.sql"
  # Observation lineage of Fansly tip contexts (sync engine design §2.4): four
  # nullable columns on transaction_tip_contexts, no default, a pair check and
  # a partial index. The previous image never names them and inserts by named
  # columns, so its rows leave them null (which the check accepts) and it runs
  # unchanged after a rollback.
  "0230_tip_context_observation_lineage.sql"
  # Contiguous-chain coverage of DM threads (sync engine design §2.3): new
  # columns on page_dm_threads (nullable, or NOT NULL with a constant default:
  # catalog-only), their checks, a one-time 'unverified' marking of the new
  # history_state column, and two nullable columns on fansly_ws_connections.
  # The previous image never names any of them and writes threads by named
  # columns, so it runs unchanged after a rollback.
  "0231_dm_thread_history_chain.sql"
  # Fansly Sync Engine history requests (design §2.5): two new tables
  # (history_requests, history_request_items), their indexes, comments and
  # grants. The previous image never names either table, so after a rollback
  # it runs unchanged; requests are accepted only on live pages, so in step 2
  # both stay empty.
  "0232_history_requests.sql"
  # Fansly Sync Engine alerts (design §2.6, §9.6): one enum value,
  # notification_incident_kind 'fansly_sync_engine'. The previous image never
  # produces it. Only a latch opened before the rollback could reach it: its
  # paging sweep skips that row with a warning (per-incident isolation) and its
  # incidents list refuses to serialize it until the row is resolved or a
  # forward deploy returns.
  "0233_fansly_sync_engine_incident_kind.sql"
  # Fansly Sync Engine media handoff (design S3-04, owner decision №17): one
  # new table (sync_media_handoff), two indexes and comments, no grant. The
  # previous image never names it, and only the actor of a live page writes
  # it (no page is live before the step-3 switch), so a rollback finds it
  # empty and runs unchanged.
  "0234_sync_media_handoff.sql"
  # Lifted DM exclusions per page (design S3-06, owner decision №8): one
  # column on sync_pages, text[] NOT NULL DEFAULT '{}' (catalog-only), and its
  # check. The previous image never names it (sync_pages is read and written
  # by named columns), so it runs unchanged after a rollback; a lift the owner
  # made lapses there (its conversation list re-applies the reason) until a
  # forward deploy returns.
  "0235_sync_pages_lifted_dm_exclusions.sql"
  # DM thread summary from the archive (step 4, design S4-08 [E4]): one data
  # update of the live pages' stored_message_count and newest/oldest stored
  # ids, recounted from message_archive where they differ. No DDL. The
  # previous image increments the same columns from its hot inserts and
  # recounts them from page_dm_messages after a socket deletion, so it runs
  # unchanged after a rollback (it still writes page_dm_messages).
  "0236_fansly_thread_summary_from_archive.sql"
  # Route intervals on the attempt (I19 audit): two nullable columns on
  # sync_attempts without a default (catalog-only). The previous image never
  # names them (it inserts attempts by named columns), so it runs unchanged
  # after a rollback; its attempts carry no interval and the audit reads their
  # pairs as inconclusive.
  "0237_sync_attempt_route_intervals.sql"
  # Narrow chat-extension device tokens (chat-extension H-3): one nullable
  # column on device_tokens (no default; its CHECK scans a few dozen rows) and
  # an immutability trigger that fires only when an UPDATE names the column.
  # The previous image never names it: it inserts and updates device tokens by
  # named columns and runs unchanged. Known cost of a rollback: that image does
  # not know the profile, so a narrow token issued meanwhile acts as a full
  # token of the same person (who can mint one with the password anyway) until
  # a forward deploy returns. Before a manual rollback past H-3, list the live
  # narrow tokens read-only:
  #   select id, user_id, label from device_tokens where client_profile is not
  #   null and revoked_at is null and expires_at > now();
  # and revoke each (cabinet: Settings > Team > the person > "Завершить вход на
  # устройстве", i.e. DELETE /api/v1/admin/users/by-id/:userId/device-tokens/
  # :tokenId); the extension signs in again after the forward deploy.
  "0238_device_token_client_profile.sql"
  # Fansly legacy sync rows parked for good (step 4, design S4-21 [E17], the
  # point of no return, stage 2): one data update of the Fansly pages'
  # page_sync_states rows to paused / blocker 'retired' (code
  # fansly_sync_engine_owned), lease and retry fields cleared. No DDL. The
  # previous image (S4-10 … S4-20) never seeds, schedules, wakes, leases or
  # resets a Fansly page's legacy state, and its rollback command refuses, so
  # it runs unchanged; no image clears a 'retired' blocker.
  "0239_retire_fansly_legacy_sync_states.sql"
  # 0240_sync_holds.sql is NOT listed (since step 4, S4-32). The reason is
  # below, where 0243_sync_pages_drop_hold_step.sql was.

  # chat-extension greeting lease and send custody (hub-pr-plan H-7a): three
  # new tables (client_fan_leases, client_greetings, client_send_custody),
  # their checks, indexes and comments. The previous image never names them,
  # and no route writes them until H-7b ships behind owner switches, so a
  # rollback finds them empty (or unread) and runs unchanged.
  "0241_client_claim_tables.sql"
  # Overrides of the retired legacy Fansly config keys (step 4, design S4-26
  # [E15]): one data statement that deletes the config_settings rows of the
  # keys this release drops from the registry and appends one config_audit_log
  # row per removed row (old value and version, new null). No DDL. The previous
  # image still registers these keys but reads none of them, so with the rows
  # gone it shows their env defaults and runs unchanged; the removed values
  # stay readable in the audit log.
  "0242_retire_fansly_legacy_config_overrides.sql"
  # NOT listed (since step 4, S4-32): 0240_sync_holds.sql (the hold set's
  # table) and 0243_sync_pages_drop_hold_step.sql (the first old hold column
  # of sync_pages). The image before 0240 knows a page's holds in the old
  # hold columns of sync_pages alone; the one before 0243 compares those
  # columns with the table whenever it acquires a page and lets them win.
  # Both were compatible only while the hold writers rewrote the columns
  # from the table in the transaction of every hold write, which they did
  # through the release that carried 0243. From S4-32 on the tree writes
  # the table alone: the columns went stale there and are gone since S4-33
  # (the last entry of this list about them, below), so either image would
  # drop every hold taken since S4-32 started and bring back every hold
  # lifted, and neither runs at all without the columns. Both migrations
  # are long applied wherever S4-32 has been deployed, so no delta of a
  # later deploy holds them; a deploy that still had one of them to apply
  # keeps the automatic rollback off rather than fail open
  # (apps/runtime/src/sync/README.md, "Rollback targets").
  #
  # With the drop the question of the old columns is closed: no image that
  # reads or writes one runs on the table. The rollback targets of a
  # database that has the drop are the S4-32 image and the images after it;
  # the images before 0240 and before 0243, and the one that carried 0243
  # (S4-31), are not.

  # chat-extension client_health rollups (chat-extension H-11b): five new
  # tables (client_health_receipts and four *_hourly rollups), their checks,
  # comments and a read_only grant on the rollups. Nothing writes them until
  # the owner turns chatExtensionHealthIngestEnabled on. The previous image
  # never names them and runs unchanged after a rollback: its bootstrap does
  # not list client-health-perf-v1, so the extension stops sending reports
  # within its bootstrap cache (5 minutes), and a report that still arrives
  # from the extension's narrow token is refused there (400: the kind is not
  # in the token's profile), never journaled. Rollups already written stay
  # unread until a forward deploy returns.
  "0244_client_health_rollups.sql"
  # The old hold columns of sync_pages dropped (step 4, S4-33, owner decision
  # №26; the last of the three releases): five columns and the slot's two
  # CHECKs, one catalog-only ALTER TABLE under lock_timeout 5 s. The previous
  # image (S4-32) reads none of them: no statement selects or returns them,
  # its drizzle table does not map them, and it reads and writes sync_pages
  # by named columns only, never by *. It writes one, in one statement: the
  # marker its acquisition leaves in the old resource-hold map, a statement
  # of its own that goes on where the column is gone. So it runs unchanged
  # after a rollback. That is true of the S4-32 image ALONE: the one before
  # it ends every hold write by rewriting those columns, so on the migrated
  # table it takes no hold and lifts none while its pages keep sending. This
  # release is therefore deployed onto S4-32, deployed and run for its hour,
  # never in the deploy that brings S4-32 and never over an older image.
  # This list cannot tell those deploys apart (S4-32 has no migration of its
  # own), so the deploy asks the running images before it migrates anything:
  # verify_running_images_run_without_old_hold_columns.
  "0245_sync_pages_drop_old_hold_columns.sql"
  # chat-extension send custody (hub-pr-plan H-7b): one plain index on
  # client_send_custody (page_id, fan_ref, created_at), built on a table no
  # route has written yet. The claim status read of this release uses it; the
  # previous image has no claim route at all, never names the index, and runs
  # unchanged after a rollback (an extra index on a table it does not read).
  "0246_client_send_custody_fan_index.sql"
  # A socket message no longer vanishes after a day (arena "vanished chat",
  # R1): one nullable column on dm_live_messages without a default
  # (confirm_wait_reason, catalog-only), its CHECK added NOT VALID and
  # validated, comments, and one data update that turns the parity timer's
  # past `not_found` verdicts (no applied read of the chat in between) into
  # deferred rows: confirmed_at, confirm_outcome and confirm_due_at null. The
  # previous image never names the column. Its parity pass selects
  # `confirm_due_at <= now()` and its alert 3 needs `confirm_due_at is not
  # null`, so it never looks at a deferred row nor counts it; its readers hide
  # `not_found` only, so they show it; its DM apply still confirms one (by
  # `confirmed_at is null`) and leaves the reason, which means nothing once
  # `confirmed_at` is set. So it runs unchanged after a rollback. Known cost:
  # for new messages it gives its own 24-hour `not_found` again, and those
  # stay hidden after the forward deploy (docs/runbooks/sync.md).
  "0247_dm_live_confirm_wait_reason.sql"
  # Excluded-chat probes Fansly already answered (owner decision №8, arena
  # "vanished chat" D1): one data update that closes the open
  # probe.excluded-chat works whose latest answer was a subject_failure
  # carrying Fansly's own error envelope (production: lilly-1's 20, every one
  # a 500 "error getting group messages") — done, not_served:<status>, the
  # breaker cleared, the evidence in the result. No DDL, no hold touched. The
  # previous image picks no done work and reads a done probe with
  # served: false as not served; it ignores the result's extra keys, so it
  # runs unchanged after a rollback.
  "0248_sync_excluded_probe_not_served.sql"
  # The Spenders money stamp (asOf = money data complete as of): one partial
  # index on ofapi_webhook_events (platform_account_id, received_at) where
  # event_type = 'transactions.new', built CONCURRENTLY outside a transaction
  # (~1 000 of ~790 000 rows on production). No table, column or row changes.
  # The previous image never names the index; the planner may use it for the
  # previous image's own queries only where it would have read those rows
  # anyway, so it runs unchanged after a rollback (an extra index it ignores).
  "0250_ofapi_webhook_events_transactions_page_received_idx.sql"
  # The chat-unavailability episode (arena "vanished chat" §2, M2): a new
  # table page_dm_thread_unavailability (IF NOT EXISTS; FK to page_dm_threads
  # ON DELETE CASCADE, no fan identity, no page key), the open episodes the
  # attempt journal already proves (production: lora-1's and lora-2's refused
  # chats), the owner's note on lora-1's, and their unconfirmed socket
  # messages deferred chat_unavailable (a wait reason the 0247 CHECK already
  # admits). The previous image never names the table; its parity pass never
  # looks at a deferred row (no confirm_due_at), its alert 3 never counts one,
  # its readers show it; its page and fan erasure delete the threads and the
  # episodes go with them through the cascade.
  "0251_page_dm_thread_unavailability.sql"
  # A lookup miss no longer excludes a chat (arena "vanished chat", M3b): data
  # only, no DDL, no work, in one transaction — the erasure execution lock
  # (key 8154030001, which every image's erasure takes before any row lock),
  # every sync_pages row locked in page order (the previous image's sync keeps
  # running while the api migrates, and each of its actor transactions starts
  # by locking its page row, so none writes back a reason it read before), then
  # `partner_unresolvable_from_account_lookup` added to every page's
  # lifted_dm_exclusions (owner decision №8, 0235), then the threads that
  # carry the reason locked in id order and the reason taken off them
  # (production: 17). The previous image honours
  # the lift: its conversation list keeps no lifted reason on a bound chat
  # and its account probe assigns none; no chat carries the reason after
  # this, and it reads the re-included chats like any other. This image reads
  # the lift for nothing. So the previous image runs unchanged after a
  # rollback.
  "0254_retire_dm_unresolvable_exclusion.sql"
  # Every attempt of the OnlyFans link series is a row (traffic sources plan
  # 2026-10-08, PR 2): page_link_stat_runs gains four columns the previous
  # image never names (reason, window_at, attempt smallint NOT NULL DEFAULT 1,
  # ofapi_account_id), its status CHECK is swapped for one that also admits
  # 'failed' and 'skipped', and ofapi_account_id is filled on existing rows
  # from ofapi_account_bindings. The previous image inserts runs by column
  # name with the three old statuses (attempt takes its default, the rest stay
  # null) and reads runs only through status in ('complete', 'partial'), so it
  # never meets a failed or skipped row; traffic-control's SQL selects the
  # same two statuses and none of the new columns. Rows the previous image
  # writes after a rollback have no window and no account: the new image
  # treats an unknown account as "not this account" (no absence proof from
  # it), which is the cautious reading.
  "0255_page_link_stat_runs_attempts.sql"
  # The OnlyFans link money named for what it is (traffic sources plan
  # 2026-10-08, PR 6): page_link_stat_snapshots gains four nullable columns
  # the previous image never names (revenue_net_mills,
  # revenue_chargebacks_mills, trial_days, tags), revenue_net_mills is copied
  # from revenue_gross_mills where that is known, and revenue_gross_mills only
  # gets a comment — it is not renamed or dropped, and the new image keeps
  # writing the same value into it. The previous image inserts snapshots by
  # column name and keeps writing revenue_gross_mills; its rows after a
  # rollback have a null revenue_net_mills, which Hub's readers read through
  # coalesce(revenue_net_mills, revenue_gross_mills), and null chargebacks,
  # trial length and tags, which is "unknown". traffic-control's SQL reads
  # revenue_gross_mills and none of the new columns.
  "0256_page_link_stat_snapshots_net_revenue.sql"
  # Traffic sources, "link → channel → contractor" with dates (plan
  # 2026-10-08, PR 11, migration D): four new tables (traffic_contractors,
  # traffic_channels, traffic_channel_contractors, traffic_link_bindings;
  # IF NOT EXISTS), their checks and indexes, no data. No existing table,
  # column or row changes. The previous image never names the tables: it
  # runs unchanged after a rollback, and the bindings stay as they were
  # (only the owner's CLI writes them). Its page erasure does not know
  # traffic_link_bindings, whose RESTRICT FK to pages never fires (erasure
  # keeps the pages row), so a page erased by the previous image keeps its
  # bindings — link ids and channel keys, no fan data — until the next one.
  "0257_traffic_link_bindings.sql"
  # The session-less public account reader's egress (arena "vanished chat",
  # R5 M5): a new singleton table fansly_public_egress (the reader's own
  # proxy, no page key, no foreign key, nothing granted) and the source CHECK
  # of fansly_send_log replaced by the old list plus 'public_lookup' (added NOT
  # VALID, validated; lock_timeout 5 s). The previous image never names the
  # table, writes only sources the old list has and reads the column as text,
  # so it runs unchanged after a rollback. Nothing sends through the egress in
  # this release.
  "0258_fansly_public_lookup_egress.sql"
  # The session-less public account reader (arena "vanished chat", R5 M4):
  # two nullable columns on fans without a default (public_checked_at,
  # public_found; catalog-only) with their pair CHECK added NOT VALID and
  # validated (lock_timeout 5 s), and two new tables — the owner's re-check
  # queue (fan_id → fans ON DELETE CASCADE) and the reader's one-row state
  # (seeded). The previous image never names any of them and reads and writes
  # fans by named columns only, so it runs unchanged after a rollback, without
  # a reader: what the reader wrote stays, every cause reads `unchecked`, and
  # its fan erasure deletes the fans row and the queue row with it.
  "0259_fans_public_lookup.sql"
  # OnlyFans "link ↔ fan" (traffic sources plan 2026-10-08, PR 8, migration
  # C): four new tables (page_link_fan_walks, page_link_fans,
  # page_link_fan_periods, page_link_fan_journal_cursors; IF NOT EXISTS),
  # their checks and indexes, no data; lock_timeout 5 s for the FKs to pages,
  # fans and page_fans. No existing table, column or row changes. The
  # previous image never names the tables: after a rollback it keeps
  # journaling the fan sweep (PR 1 is in it) and the tables simply stop
  # moving — the cursor stays where it was and the next image applies the
  # pages journaled in between. ERASURE UNDER THE PREVIOUS IMAGE: every row
  # that names a fan (page_link_fans, and page_link_fan_periods through it)
  # hangs off the fan's page_fans row of the same page ON DELETE CASCADE, and
  # the previous image's page erasure deletes the page's page_fans (its fan
  # erasure the fan, and page_fans with him) — so no fan data outlives an
  # erasure it runs. What its page erasure leaves are the page's walks and
  # cursor (link ids, counts, an OFAPI account id; no fan), as with
  # traffic_link_bindings (0257), until the next image's erasure; the next
  # image's projection writes nothing an erasure tombstone covers.
  "0260_page_link_fans.sql"
  # The link ↔ fan projection's journal read (PR 8): one partial index on
  # sync_raw_payloads (page_id, id) over the three link_fans_* endpoints,
  # built CONCURRENTLY outside a transaction (after dropping an INVALID
  # leftover). Index-only; the previous image never reads it.
  "0261_sync_raw_payloads_link_fans_idx.sql"
  # The alert evaluator's proof of work (bug hunt Д11): one new table
  # sync_alert_evaluations (IF NOT EXISTS; RESTRICT FK to pages, like the
  # other engine tables), its comments and the read-role grant, no data.
  # Purely additive; the previous image never names the table. After a
  # rollback its rows stay unread and its sync writes none, and its api has no
  # watchdog leg that reads them; a forward deploy rewrites them on its first
  # pass. An `evaluator` latch open at the rollback is closed by the owner
  # (docs/runbooks/sync.md, "Watchdog restarts, shutdown and deploys") or by
  # the next forward deploy. Its page erasure does not know the table, whose
  # RESTRICT FK to pages never fires (erasure keeps the pages row), so a page
  # erased by the previous image keeps its rows — page × rule × instants, no
  # fan data — until the next one.
  "0262_sync_alert_evaluations.sql"
  # Д2 (an alert outlives a Telegram outage): one nullable self-reference on
  # notification_delivery_outbox (reported_in_outbox_id, no default: catalog
  # only; the FK is checked over a few hundred null rows) and the queue's
  # `sync_failure` rows raised to the new 400-attempt horizon. The previous
  # image never names the column, sends a missed-alerts summary as the
  # ordinary `resolved` row it is, treats a retired opening as terminal
  # `exhausted`, and honours any max_attempts (without stopping on the first
  # failure it sends in a row again, but loses nothing). No data to repair.
  "0263_notification_outbox_reported_in.sql"
  # Д3/У2 (a step without an outcome is counted): one nullable column on
  # sync_work without a default (catalog only); the previous image never names
  # it (it inserts and updates sync_work by named columns); its quarantine
  # reads `unknown_repeated` as any quarantined row (alert 2, requeue), and
  # its recovery repeats an `unknown` read without the limiter, as before.
  "0264_sync_work_failing_since.sql"
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
  scripts/archive-container-logs.sh \
  scripts/deploy-infrastructure.mjs \
  scripts/verify-desktop-lifecycle-v2-evidence.mjs \
  scripts/verify-client-sdk-retention.mjs
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

  # Not keyed on the exit status: bash killed by SIGINT (Ctrl-C) or another
  # signal while it reads a command substitution — `$(ssh …)`, such as the log
  # archive right before the recreate — runs this trap with $? = 0. Every exit
  # that quiesced and never recreated left the scheduler and worker stopped:
  # fail() restarts them itself (and clears the flag), and success recreates.
  if [[ "${STACK_RECREATED:-0}" != "1" && "${LEGACY_SYNC_QUIESCED:-0}" == "1" ]]; then
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

# Compose refuses a whole `logs` call, printing nothing, when one named service
# is missing from the compose file. fail() runs this dump after the rollback
# restored the previous release files, which may predate the sync service, so
# the sync logs are a call of their own, made only when those files define it.
dump_remote_diagnostics() {
  log "Remote verification failed; collecting docker compose status and recent logs"
  run_remote "set +e; cd ${REMOTE_APP_DIR_ESCAPED} || exit 0; ${REMOTE_COMPOSE} ps; printf '\\n'; ${REMOTE_COMPOSE} logs --tail=200 postgres api worker; if ${REMOTE_COMPOSE} config --services 2>/dev/null | grep -qx sync; then printf '\\n'; ${REMOTE_COMPOSE} logs --tail=200 sync; fi; exit 0" \
    || log "Unable to collect remote diagnostics"
}

# М1: a recreate deletes a container together with its log (the production
# `local` driver keeps it in the container's own directory, and nothing ships
# it elsewhere), so every deploy command that replaces or removes containers
# is preceded by this archive of their logs into ${APP_DIR}/container-logs.
# The helper only reads Docker and goes over ssh stdin from this checkout, so
# the version the tests ran is the one that runs, also after
# restore_remote_release_files. A running container is archived as a
# snapshot: nothing is stopped for it. The archive never fails the deploy or
# the rollback; anything but a full archive is a WARNING.
archive_remote_container_logs() {
  local phase="$1"
  shift
  local started=$SECONDS
  local status=0
  local output
  local remote_args
  remote_args="$(printf ' %q' --dir "${APP_DIR%/}/container-logs" --project-dir "$APP_DIR" \
    --reason "deploy ${DEPLOY_RUN_ID} ${APP_SOURCE_REVISION} ${phase}" "$@")"
  output="$(ssh "${SSH_ARGS[@]}" "$REMOTE" "timeout 300 bash -l -s --${remote_args}" \
    <"${SCRIPT_DIR}/archive-container-logs.sh" 2>&1)" || status=$?
  output="${output//$'\n'/; }"
  case "$status" in
    0)
      log "Container logs archived (${phase}) duration_seconds=$((SECONDS - started)): ${output}"
      ;;
    3)
      log "WARNING: container logs archived only partially (${phase}) duration_seconds=$((SECONDS - started)): ${output}"
      ;;
    *)
      log "WARNING: container logs NOT archived (${phase}) exit=${status} duration_seconds=$((SECONDS - started)): ${output}"
      ;;
  esac
  return 0
}

# The forward recreate's containers. App scope leaves sync to
# recreate_sync_service, which archives it right before its own `up`.
archive_before_stack_recreate() {
  if [[ "$RECREATE_SCOPE" == "apps" ]]; then
    archive_remote_container_logs forward api worker scheduler
  else
    archive_remote_container_logs forward postgres api worker scheduler sync
  fi
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

# The drop of the old hold columns of sync_pages (step 4, S4-33:
# *_sync_pages_drop_old_hold_columns.sql) is applied by the new api while the
# `sync` of the running image still works, and it is in
# ROLLBACK_COMPATIBLE_MIGRATIONS, so a failed deploy returns to that image.
# Both are safe under ONE image, the release before the drop (S4-32), and the
# list cannot say so: that release has no migration of its own. Every image
# older than it names the columns of the old hold slot in a statement. The one
# just before it ends every hold write by rewriting them, in the write's
# transaction: on the migrated table it takes no hold and lifts none (after a
# 401, a 429, a network failure) while its page keeps sending. It fails open,
# and every health gate stays green, since a 200 writes no hold.
#
# So the running images are asked before anything is migrated. While the drop
# is not in the schema baseline, the built code of the image of every running
# app container is searched for the slot's columns, and the deploy stops if
# one names them: the deploy that would bring S4-32 and the drop at once, and
# any deploy of this tree after a rollback to an older image.
#
# The witness is the three columns of the slot that have no namesake. The
# resource-hold map, dropped with them, is not part of it: the S4-32 image
# names it once, in the marker its acquisition leaves there, and that
# statement goes on where the column is gone
# (tests/sync-hold-set.integration.test.ts runs it after the drop).
#
# Fails closed: a container that cannot be listed or an image that cannot be
# searched stops the deploy too.
verify_running_images_run_without_old_hold_columns() {
  if grep -Eq '^[0-9]{4}_sync_pages_drop_old_hold_columns\.sql$' "$SCHEMA_BEFORE_FILE"; then
    return 0
  fi

  local slot_columns='hold_kind|hold_since|hold_detail'
  local report
  report="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}
defined=\"\$(${REMOTE_COMPOSE} config --services)\"
searched=' '
for service in api worker scheduler sync; do
  grep -qx \"\$service\" <<<\"\$defined\" || continue
  containers=\"\$(${REMOTE_COMPOSE} ps -q \"\$service\")\"
  for container_id in \$containers; do
    image_id=\"\$(docker inspect -f '{{.Image}}' \"\$container_id\")\"
    revision=\"\$(docker image inspect -f '{{ index .Config.Labels \"agency-hub.source-revision\" }}' \"\$image_id\")\"
    case \"\$searched\" in
      *\" \$image_id=names \"*) verdict=names ;;
      *\" \$image_id=clean \"*) verdict=clean ;;
      *)
        if docker run --rm \"\$image_id\" grep -rqE '${slot_columns}' apps/runtime/dist packages/db/dist; then
          verdict=names
        else
          status=\$?
          [[ \"\$status\" == 1 ]] || exit \"\$status\"
          verdict=clean
        fi
        searched+=\"\$image_id=\$verdict \"
        ;;
    esac
    printf '%s|%s|%s\\n' \"\$service\" \"\$revision\" \"\$verdict\"
  done
done")" \
    || fail "Unable to search the running images for the old hold slot of sync_pages; its drop is still to be applied and is safe only under the release before it"

  local older=()
  local containers=0
  local service
  local revision
  local verdict
  while IFS='|' read -r service revision verdict; do
    [[ -n "$service" ]] || continue
    if [[ -z "$revision" || "$revision" == "<no value>" ]]; then
      revision="unlabelled"
    fi
    case "$verdict" in
      clean)
        ;;
      names)
        older+=("${service} (source revision ${revision})")
        ;;
      *)
        fail "Unreadable answer about the running ${service} image; refusing to drop the old hold columns of sync_pages under it"
        ;;
    esac
    containers=$((containers + 1))
  done <<<"$report"

  if (( ${#older[@]} > 0 )); then
    printf '[deploy] The drop of the old hold columns of sync_pages is still to be applied, and these running\n' >&2
    printf '[deploy] images name the old hold slot in a statement:\n' >&2
    printf '[deploy]   %s\n' "${older[@]}" >&2
    printf '[deploy] Such an image does not run on the migrated table. The release just before S4-32 rewrites\n' >&2
    printf '[deploy] the dropped columns at every hold write: there it takes no hold and lifts none while its\n' >&2
    printf '[deploy] pages keep sending, and the automatic rollback would return to it. Deploy the release\n' >&2
    printf '[deploy] before the drop first (S4-32, from a checkout of its commit), let it run its hour, then\n' >&2
    printf '[deploy] deploy this one (apps/runtime/src/sync/README.md, "Rollback targets from this release on").\n' >&2
    fail "A running image is older than the release the drop of the old hold columns of sync_pages needs"
  fi

  if (( containers == 0 )); then
    log "No app container is running: nothing works on sync_pages while its old hold columns are dropped"
  else
    log "No running image names the old hold slot of sync_pages (${containers} running app container(s)); its drop may run under them"
  fi
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

  # An app-scope deploy kept the healthy PostgreSQL, so its rollback does too:
  # it lists the forward recreate's services, and Compose recreates an unlisted
  # dependency only when its configuration diverged, which the infrastructure
  # guard ruled out. With no list, --force-recreate would stop and replace
  # PostgreSQL as well. Sync rides in the same `up` (its depends_on starts it
  # once the rolled-back api is healthy), or, when the restored files predate
  # it, --remove-orphans removes it. A stack-scope deploy recreated everything,
  # PostgreSQL included, so its rollback still lists nothing. Either way the
  # failed candidate's containers go, so their logs are archived first (М1),
  # sync's whether it is recreated or removed.
  local release_has_sync=0
  remote_release_defines_sync && release_has_sync=1
  local services="${RECREATE_SERVICES:-}"
  if [[ -n "$services" && "$release_has_sync" == "1" ]]; then
    services+=" sync"
  fi
  local archived=(api worker scheduler sync)
  [[ -n "${RECREATE_SERVICES:-}" ]] || archived=(postgres "${archived[@]}")
  archive_remote_container_logs rollback "${archived[@]}"
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; docker tag $(printf '%q' "$ROLLBACK_IMAGE_TAG") $(printf '%q' "$IMAGE_TAG"); ${REMOTE_COMPOSE} up -d --remove-orphans --force-recreate --no-build${services:+ ${services}}" \
    || {
      log "Rollback command failed"
      return 0
    }

  if wait_for_api_health "$HEALTH_FILE"; then
    log "Rollback health check passed"
  else
    log "Rollback health check did not reach 200"
  fi

  # The rollback replaced every app container, sync included, so it runs the
  # forward path's confirmations: an owner of the replaced sync container that
  # did not write its safe release leaves its page waiting
  # `ownership_unconfirmed`, with no sender, and a Fansly request the stop cut
  # off leaves its page closed. The sync one waits for the rolled-back sync
  # container's healthcheck (its depends_on already waited for a healthy api),
  # whatever the API check above saw from here. Like the rest of the rollback,
  # neither ever stops fail().
  if [[ "$release_has_sync" == "1" ]]; then
    log "Waiting for the rolled-back sync container healthcheck"
    if wait_for_sync_container_health; then
      confirm_sync_owner_handover \
        || log "WARNING: the sync engine owner confirmation failed after the rollback; a page whose owner was cut off by the rollback waits (ownership_unconfirmed) until sync ownership confirm-stopped is run by hand"
    else
      log "WARNING: the rolled-back sync container never reached a healthy state; a page whose owner was cut off by the rollback waits (ownership_unconfirmed) until sync ownership confirm-stopped is run by hand"
    fi
  fi
  confirm_remote_fansly_send_guard_terminations \
    || log "WARNING: the Fansly send guard confirmation failed after the rollback; a page cut off by the rollback stays closed (with its alert) until fansly-send-guard confirm-terminated is run by hand"
}

# The restored release files may predate the sync service (see
# dump_remote_diagnostics), and Compose refuses to recreate a service its files
# lack. A failed read counts as defined, as in every current release: the
# recreate then reports the real problem.
remote_release_defines_sync() {
  local services
  services="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; ${REMOTE_COMPOSE} config --services")" \
    || return 0
  grep -qx sync <<<"$services"
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

# The Fansly Sync Engine's process. The app-scope recreate above leaves it
# alone on purpose: listed with api/worker/scheduler, Compose would stop the
# old engine while the new api is still migrating (its depends_on delays only
# the new container's start). Recreated here, once the api is healthy, Compose
# stops the old container (SIGTERM, 45 s grace: it finishes its in-flight
# request) and only then starts the new one. A stack-scope recreate already
# started the new container after API health through its depends_on, so it
# is not recreated twice. The old container's log is archived right before
# the `up`, while it still runs (М1, archive_remote_container_logs).
# scripts/check-compose-recreate-order.sh proves this order on a throwaway
# Compose project.
recreate_sync_service() {
  if [[ "$RECREATE_SCOPE" != "apps" ]]; then
    log "Stack recreate already started the sync container after API health"
    return 0
  fi
  log "Recreating the sync container after API health (migrations done)"
  archive_remote_container_logs sync sync
  run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED} && ${REMOTE_COMPOSE} up -d --no-deps --force-recreate --no-build sync"
}

# The sync container's compose healthcheck (health file freshness, written only
# after a successful heartbeat upsert) must reach 'healthy'.
wait_for_sync_container_health() {
  local attempt=0
  local status

  while (( attempt < 60 )); do
    attempt=$((attempt + 1))
    status="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}; container_id=\$(${REMOTE_COMPOSE} ps -q sync 2>/dev/null || true); if [[ -z \"\$container_id\" ]]; then printf missing; else docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \"\$container_id\"; fi" || true)"
    case "$status" in
      healthy)
        return 0
        ;;
      missing|exited|dead|restarting)
        log "Sync container status: ${status:-unknown}"
        ;;
    esac
    sleep 3
  done

  log "Sync container last observed status: ${status:-unknown}"
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
  verify_service_image_labels sync
}

# Plan §2.5: the per-page Fansly send guard. A request that the recreate cut
# off (a container killed past its stop grace, a crash) leaves its page closed:
# an expired lease never opens a page by itself, and the new containers'
# sweepers cannot see the old containers' processes. Docker can: a holder whose
# container is not running any more is gone with it. So, once the new stack is
# healthy, list the hostnames of every running container on the host and let
# the new api confirm every other holder terminated. The instant is taken
# BEFORE the listing and only holders captured before it are released, so a
# container that starts after the listing is never taken for a gone one.
#
# Never fails or rolls back the deploy: a failure only leaves a page closed,
# with its alert, until the same command is run by hand.
confirm_remote_fansly_send_guard_terminations() {
  local output
  output="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}
listed_at=\"\$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
running_hosts=\"\$(docker ps -q | xargs -r docker inspect -f '{{.Config.Hostname}}' | paste -sd, -)\"
test -n \"\$running_hosts\"
${REMOTE_COMPOSE} exec -T api node apps/runtime/dist/cli.js fansly-send-guard confirm-terminated --running-hosts \"\$running_hosts\" --include-unexpired --captured-before \"\$listed_at\"")" \
    || return 1
  log "Fansly send guard: confirmed the holders of stopped containers terminated: ${output//$'\n'/; }"
}

# Sync Engine design §3.6 rule (e), §9.3: the page owners of the recreated
# sync container. An owner that did not write its safe release (killed past its
# 45 s stop grace, a crash) leaves its page waiting `ownership_unconfirmed`: the
# new container cannot see the old one's processes, and a lost database session
# is never a confirmation. Docker can: an owner whose host is not one of the
# running sync containers is gone with its container. The instant is taken
# BEFORE the listing and only owners that acquired their page before it are
# confirmed, so a container that starts after the listing is never taken for
# a gone one.
#
# Never fails or rolls back the deploy: a failure only leaves a page waiting,
# with its alert, until the same command is run by hand.
confirm_sync_owner_handover() {
  local output
  output="$(run_remote "set -euo pipefail; cd ${REMOTE_APP_DIR_ESCAPED}
listed_at=\"\$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\"
sync_hosts=\"\$(${REMOTE_COMPOSE} ps -q sync | xargs -r docker inspect -f '{{.Config.Hostname}}' | paste -sd, -)\"
test -n \"\$sync_hosts\"
${REMOTE_COMPOSE} exec -T api node apps/runtime/dist/cli.js sync ownership confirm-stopped --running-hosts \"\$sync_hosts\" --acquired-before \"\$listed_at\"")" \
    || return 1
  log "Sync engine: confirmed the page owners of stopped sync containers: ${output//$'\n'/; }"
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
# The overlay's own build identity (the base image carries its revision's).
ENV GIT_SHA=\${APP_SOURCE_REVISION}

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

# A candidate keeps serving every client SDK the running hub registers
# (services/client-sdk-registry.ts: health lists those hashes and released
# clients gate on them). Both images print their registry; the verifier
# refuses a dropped hash or build the owner did not name with
# --drop-client-sdk. A running image that predates the print mode leaves
# nothing to compare, and the gate says so.
verify_candidate_client_sdks() {
  local candidate_sdks
  local running_sdks
  local running_error_file="${TEMP_DIR}/running-client-sdks.stderr"
  local drop
  local verifier_args=()

  candidate_sdks="$(run_remote "set -euo pipefail; docker run --rm $(printf '%q' "$IMAGE_CANDIDATE_TAG") node apps/runtime/dist/startup.js print-compatible-client-sdks")" \
    || fail "Unable to read the candidate's registered client SDKs"
  verifier_args+=(--candidate "$candidate_sdks")
  if [[ "${ROLLBACK_IMAGE_AVAILABLE:-0}" != "1" ]]; then
    log "No running image to compare registered client SDKs with"
  elif running_sdks="$(run_remote "set -euo pipefail; docker run --rm $(printf '%q' "$ROLLBACK_IMAGE_TAG") node apps/runtime/dist/startup.js print-compatible-client-sdks" 2>"$running_error_file")"; then
    verifier_args+=(--running "$running_sdks")
  elif grep -qF 'Unsupported Agency Hub runtime role "print-compatible-client-sdks"' "$running_error_file"; then
    log "Running image predates print-compatible-client-sdks; skipping the registered client SDK comparison"
  else
    cat "$running_error_file" >&2
    fail "Unable to read the running image's registered client SDKs"
  fi
  for drop in "${DROP_CLIENT_SDKS[@]}"; do
    verifier_args+=(--drop "$drop")
  done
  node "$SCRIPT_DIR/verify-client-sdk-retention.mjs" "${verifier_args[@]}" \
    || fail "Candidate would drop a registered client SDK, or its registry line is unreadable"
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
verify_candidate_client_sdks
prepare_remote_infrastructure_check
verify_remote_infrastructure_unchanged || fail "App release would change PostgreSQL/infrastructure; review an explicit --recreate-scope stack deployment"
finish_phase candidate-verification
start_phase migrations
capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE" \
  || fail "Unable to capture remote schema migration state before pre-recreate migration"
SCHEMA_BASELINE_CAPTURED=1
log "Captured remote schema migration state for rollback safety"
# Before anything is quiesced or migrated: a refusal here leaves the running
# stack as it was.
verify_running_images_run_without_old_hold_columns
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
# Before STACK_RECREATED=1: an interrupt during the archive leaves a deploy
# that recreated nothing, and cleanup_deploy restarts the quiesced services.
archive_before_stack_recreate
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
recreate_sync_service || fail "docker compose failed while recreating the sync container"

log "Waiting for the worker container healthcheck"
wait_for_worker_health || fail "Worker container never reached a healthy state"

log "Waiting for the scheduler container healthcheck"
wait_for_scheduler_health || fail "Scheduler container never reached a healthy state"

log "Waiting for the sync container healthcheck"
wait_for_sync_container_health || fail "Sync container never reached a healthy state"

verify_post_deploy_image_labels
confirm_remote_fansly_send_guard_terminations \
  || log "WARNING: the Fansly send guard confirmation failed; a page cut off by this deploy stays closed (with its alert) until fansly-send-guard confirm-terminated is run by hand"
confirm_sync_owner_handover \
  || log "WARNING: the sync engine owner confirmation failed; a page whose owner was cut off by this deploy waits (ownership_unconfirmed) until sync ownership confirm-stopped is run by hand"
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
