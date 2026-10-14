#!/usr/bin/env bash
# Project Browser — a new Chrome for the pages' browsers (plan §4.10, §4.1,
# §4.9; spec §10; stage 3, PR 18). Runs on the server as root, next to the
# page containers: installed by `scripts/deploy-page-browser.sh host` at
# /opt/agency-hub/page-browser/page-browser-update.sh, beside page.sh. Hub's
# containers have no Docker; this script has, and it reaches the Hub only
# through the Hub's own CLI (audited levers) and read-only SQL.
#
#   page-browser-update.sh check [--no-build]
#       The timer's job (page-browser-update.timer, once a day): the newest
#       Chrome Stable in Google's repository, its metadata verified with
#       Google's key pinned in the repository (InRelease → Packages → .deb,
#       each by SHA-256); a newer one is archived in chrome/, built into
#       hub-page-browser:<Chrome>-<revision> from the build context the last
#       deploy kept, and PROPOSED: journaled, logged, the hook told. No page
#       is touched: whether pages update by themselves is the owner's
#       decision (plan §8 №15, open). Also: an update left unfinished, pages
#       behind the newest image (the 3-day goal of plan §4.10).
#   page-browser-update.sh build --chrome <deb version> [--revision <rev>]
#   page-browser-update.sh update --page <page> --image <tag> [--window <dur>]
#                                 [--engine hub|none] [--any-hour] [--detach]
#       One page onto a new image (below). --window: the watch after it
#       (default 60m, owner decision №7; 0: none). Starts only 06:00–20:00
#       UTC (plan §4.10) unless --any-hour. --detach: run as a transient
#       systemd unit (an hour's watch outlives an SSH session).
#   page-browser-update.sh rollout --image <tag> [--window <dur>] [--engine …]
#                                  [--any-hour] [--detach]
#       Every other page, one by one (default window 0), once a page passed
#       its window on that image; the first failure stops it.
#   page-browser-update.sh resume --page <page> [--detach]
#       An update or rollback cut off at any step goes on from that step.
#   page-browser-update.sh rollback --page <page> [--reason <text>] [--detach]
#       The page's last update undone: its previous image WITH its snapshot.
#   page-browser-update.sh snapshot --page <page>
#       A standing page's profile now (Chrome down; the container stopped
#       for it and started again): the host's half of `sync browser snapshot`.
#   page-browser-update.sh status [--page <page>]
#   page-browser-update.sh prune
#
# One page's update (every step journaled; resumable from its state file):
#  1. take out — the page stops serving through the engine's own hand-over,
#     never by killing it: a page on its browser leaves it (`sync page
#     transport <page> node`, audited): the operator's quiesced, its exit
#     closed, Chrome stopped, its buffer taken, the leave confirmed. A page
#     on Node, or with no engine (--engine none: the stand, a page the Hub
#     does not know), must stand already. Either way Chrome must be down in
#     the container, or nothing goes on.
#  2. stop the container: nothing writes the profile any more;
#  3. snapshot the profile volume before the new Chrome first opens it —
#     Chrome upgrades a profile in place and never opens one a newer Chrome
#     wrote (stage 1): snapshots/<profile>/, its SHA-256 and Chrome version
#     beside it, the newest three kept;
#  4. the page on the new image (page.sh up: healthy, or the old one back);
#  5. host checks, exit closed: the new Chrome opens the profile and its
#     policy installs the image's rules extension (profile-check.mjs in the
#     container), and the profile now names the new Chrome;
#  6. give back — the page returns to its browser (`sync page transport
#     <page> browser`), and the engine starts it (plan §4.1);
#  7. engine checks, read from the engine's record of the operator's state
#     (page_browsers): ready on the new Chrome — the self-test passed (the
#     extension's rules among its mechanisms), the environment verified, the
#     exit IP the pinned one, the site loaded, the session confirmed by the
#     engine's identity read: the same account and session fingerprint as
#     before, no new login;
#  8. the window (first page): ready all along, then `sync check live-hour`.
# Any failure before the new image ran puts the page back as it was (its
# old container, its transport); after it, a rollback: the page out again,
# the snapshot restored, the old image, the same checks — never the old
# Chrome on a profile the new one wrote.
#
# Until PR 17 (visibility) the hand-over is the transport switch: the page
# runs on Node meanwhile and needs its stored Node session; `sync browser
# stop|start` will take a page out without Node. The engine checks read
# what PR 17's engine records of the operator's state, and need its start
# of the browser when the page returns to it: without them they time out,
# and the update rolls back.
set -euo pipefail
umask 077

PB_BASE="${PB_BASE:-/opt/agency-hub/page-browser}"
HUB_DIR="${PB_HUB_DIR:-/opt/agency-hub}"
PAGE_SH="${PB_PAGE_SH:-$PB_BASE/page.sh}"
PROFILE_CHECK="${PB_PROFILE_CHECK:-$PB_BASE/profile-check.mjs}"
# Google's Linux package signing key (apps/page-browser/host/), and its
# primary key's fingerprint: a signature counts only by a key it binds.
SIGNING_KEY="${PB_CHROME_SIGNING_KEY:-$PB_BASE/google-linux-signing-key.asc}"
SIGNING_FPR="${PB_CHROME_SIGNING_FPR:-EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796}"
REPO_URL="${PB_CHROME_REPO:-https://dl.google.com/linux/chrome/deb}"
UPDATE_DIR="$PB_BASE/update"
SNAP_DIR="$PB_BASE/snapshots"
ARCHIVE_DIR="$PB_BASE/chrome"
CONTEXT_DIR="$PB_BASE/build/context"
VENDOR_DIR="$PB_BASE/vendor"

# Seconds.
POLL_S="${PB_UPDATE_POLL_S:-5}"
LEAVE_WAIT_S="${PB_UPDATE_LEAVE_WAIT_S:-600}"
READY_WAIT_S="${PB_UPDATE_READY_WAIT_S:-900}"
WINDOW_POLL_S="${PB_UPDATE_WINDOW_POLL_S:-300}"
# The engine records the operator's state at least every minute: older
# than this, the page is not known to be running.
STATE_FRESH_S=180
LAG_ALERT_S=$((3 * 86400))
QUIET_FROM_H=6
QUIET_TO_H=20
KEEP_SNAPSHOTS=3
KEEP_IMAGES=3
KEEP_DEBS=3
RELEASE_TAG_RE='^hub-page-browser:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-[0-9]+)-([0-9a-f]{12})$'
PAGE_RE='^[a-z0-9][a-z0-9-]{0,40}$'
# A stop of the browser's start that waiting does not cure: the update
# fails at once. The rest (the proxy's) is waited out until the deadline.
FATAL_STOPS=" selftest_failed env_mismatch exit_ip_changed cdp_lost holder_overflow buffer_full disk_full buffer_unavailable request_unended chrome_crashed unknown_ws_message ws_guard_failed ws_unaccounted header_mismatch login_required "
TERMINAL_STEPS=" done aborted rolled_back "

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ORIGINAL_ARGS=("$@")
LOCK_HELD=0
ALERTED=0
WORK=""
CHECK_DETAIL="" LEAVE_WHY="" ENGINE_WHY="" REPO_WHY="" BUILD_WHY="" BUILT_TAG=""
PROFILE_CHROME="" PROFILE_BYTES=0
REPO_VERSION="" REPO_FILENAME="" REPO_SIZE="" REPO_SHA256="" REPO_DATE="" REPO_SIGNER=""
H_TRANSPORT="" H_LEAVE="" H_LEFT_BY="" H_LEFT_GEN="" H_GENERATION="" H_NODE_SESSION="" H_PROFILE="" H_STEP="" H_STOP=""
H_EXIT_OPEN="" H_FINGERPRINT="" H_ACCOUNT="" H_EXIT_IP="" H_PINNED="" H_CHROME="" H_OPERATOR="" H_SELFTEST_OK=""
H_SELFTEST_AT="" H_SELFTEST_FAILED="" H_STATE_AT="" H_NOW=""

# ── output, journal, alerts ───────────────────────────────────────────────

now_s() { date -u +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# An epoch (seconds) as ISO 8601, GNU date or BSD date.
iso_of() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
# An RFC 2822 date (a Release's Date:) as an epoch.
epoch_of_rfc2822() {
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%a, %d %b %Y %H:%M:%S %Z' "$1" +%s 2>/dev/null
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

log() { printf '[page-browser-update] %s %s\n' "$(now_iso)" "$*" >&2; }
fail() {
  log "error: $*"
  exit 2
}

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')"
}

# What comes from outside (a CLI's error, a check's output) before it is
# journaled: no credentials, tokens or long hex, one short line.
scrub() {
  LC_ALL=C sed -E \
    -e 's#(://)[^/@ ]+@#\1***@#g' \
    -e 's/([Pp]assword|PASSWORD|[Tt]oken|TOKEN|[Ss]ecret|SECRET)([=:][ ]*)[^ ,;"]+/\1\2***/g' \
    -e 's/Bearer [A-Za-z0-9._~+\/-]+=*/Bearer ***/g' \
    -e 's/[0-9a-fA-F]{32,}/***/g' \
    | tr '\n\r' '  ' | cut -c1-400
}

RUN="" PAGE=""
journal() {
  local event="$1" detail="${2:-}"
  mkdir -p "$UPDATE_DIR"
  printf '{"at":%s,"run":%s,"page":%s,"event":%s,"detail":%s}\n' \
    "$(json_str "$(now_iso)")" "$(json_str "$RUN")" "$(json_str "$PAGE")" "$(json_str "$event")" "$(json_str "$detail")" \
    >> "$UPDATE_DIR/journal.jsonl"
}

# The owner hears of it: the system journal (priority), and the hook
# $PB_BASE/update/notify if there is one (one line, never a secret).
notify() {
  local level="$1" text="$2"
  if command -v logger >/dev/null 2>&1; then logger -t page-browser-update -p "user.$level" -- "$text" 2>/dev/null || true; fi
  if [[ -x "$UPDATE_DIR/notify" ]]; then "$UPDATE_DIR/notify" "$level" "$text" </dev/null >/dev/null 2>&1 || log "warning: the notify hook failed"; fi
}
say() {
  log "$2"
  journal "$1" "$2"
}
alert() {
  ALERTED=1
  log "ALERT: $2"
  journal "$1" "$2"
  notify err "page-browser-update${PAGE:+ $PAGE}: $2"
}
propose() {
  log "$2"
  journal "$1" "$2"
  notify warning "page-browser-update: $2"
}

# ── versions ──────────────────────────────────────────────────────────────

# 155.0.8059.79 out of anything that names it (a .deb version, a label,
# "Google Chrome 155.0.8059.79", "Chrome/155.0.8059.79").
chrome_of() {
  [[ "$1" =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
}
# ver_gt a b: a is a later Chrome than b.
ver_gt() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$(chrome_of "$1")"
  read -r -a b <<<"$(chrome_of "$2")"
  local i
  for i in 0 1 2 3; do
    ((10#${a[i]:-0} > 10#${b[i]:-0})) && return 0
    ((10#${a[i]:-0} < 10#${b[i]:-0})) && return 1
  done
  return 1
}

image_label() {
  docker image inspect --format "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null | sed -n '1p'
}
# An image's Chrome: its label, else the binary's own word.
image_chrome() {
  local label version
  label="$(image_label "$1" agency-hub.page-browser.chrome-version)" || return 1
  version="$(chrome_of "$label" || true)"
  if [[ -z "$version" ]]; then
    label="$(docker run --rm --network none --entrypoint /usr/bin/google-chrome-stable "$1" --version 2>/dev/null)" || return 1
    version="$(chrome_of "$label" || true)"
  fi
  [[ -n "$version" ]] && printf '%s' "$version"
}
image_revision() {
  local revision
  revision="$(image_label "$1" agency-hub.page-browser.revision || true)"
  [[ "$revision" =~ ^[0-9a-f]{7,40}$ ]] && printf '%s' "$revision" || true
}

# ── a page's files ────────────────────────────────────────────────────────

value() {
  [[ -f "$2" ]] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}
page_env() { printf '%s/pages/%s/page.env' "$PB_BASE" "$1"; }
container_of() { printf 'page-browser-%s' "$1"; }

# The container: "<running> <image> <health>", nothing when there is none.
container_state() {
  docker inspect -f '{{.State.Running}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(container_of "$1")" 2>/dev/null || true
}
container_running() { [[ "$(container_state "$1")" == true\ * ]]; }

# Chrome in the page's container: "down" only when s6 says so and no
# process of Chrome's user runs Chrome.
chrome_state() {
  docker exec "$(container_of "$1")" sh -c '
    up="$(/command/s6-svstat -o up /run/service/chrome 2>/dev/null || echo unknown)"
    if [ "$up" = false ] && ! pgrep -u pb-chrome -f "^/opt/google/chrome/chrome" >/dev/null 2>&1; then echo down; else echo up; fi
  ' pb-chrome-state 2>/dev/null || echo unknown
}

# ── the profile volume, through a container of the page's own image (its
# GNU tar; Docker's volumes are Docker's business) ─────────────────────────

# shellcheck disable=SC2016
HELPER_SH='set -eu
op="$1"; file="${2:-}"
case "$op" in
  version)
    v=""
    if [ -f "/profile/Last Version" ]; then
      v="$(head -c 64 "/profile/Last Version" | tr -cd "0-9.")"
    elif [ -f /profile/Default/Preferences ]; then
      v="$(grep -o "\"last_chrome_version\":\"[0-9.]*\"" /profile/Default/Preferences | head -n 1 | tr -cd "0-9.")"
    fi
    echo "version=$v"
    echo "bytes=$(du -sb /profile | cut -f1)"
    ;;
  snapshot)
    tar --numeric-owner \
      --exclude=Cache --exclude="Code Cache" --exclude=GPUCache --exclude=GrShaderCache --exclude=ShaderCache \
      --exclude=GraphiteDawnCache --exclude=DawnGraphiteCache --exclude=DawnWebGPUCache --exclude="Singleton*" \
      -czf "/snap/$file" -C /profile .
    ;;
  restore)
    find /profile -mindepth 1 -delete
    tar --numeric-owner -xzpf "/snap/$file" -C /profile
    ;;
  *) exit 2 ;;
esac'

profile_volume_exists() { docker volume inspect "pb-profile-$1" >/dev/null 2>&1; }

# profile_helper <op> <profile> <image> [<snapshot dir> <file>]
profile_helper() {
  local op="$1" profile="$2" image="$3" dir="${4:-}" file="${5:-}"
  local -a args=(run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 0 --entrypoint sh)
  case "$op" in
    version) args+=(--cap-add DAC_OVERRIDE -v "pb-profile-$profile:/profile:ro") ;;
    snapshot) args+=(--cap-add DAC_OVERRIDE -v "pb-profile-$profile:/profile:ro" -v "$dir:/snap") ;;
    restore) args+=(--cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER -v "pb-profile-$profile:/profile" -v "$dir:/snap:ro") ;;
  esac
  profile_volume_exists "$profile" || { log "no volume pb-profile-$profile"; return 1; }
  docker "${args[@]}" "$image" -c "$HELPER_SH" pb-helper "$op" "$file"
}

# The Chrome that last opened the profile ("" for one no Chrome opened)
# and its size: PROFILE_CHROME, PROFILE_BYTES.
read_profile() {
  local out
  out="$(profile_helper version "$1" "$2")" || return 1
  PROFILE_CHROME="$(sed -n 's/^version=//p' <<<"$out" | head -n 1)"
  PROFILE_BYTES="$(sed -n 's/^bytes=//p' <<<"$out" | head -n 1)"
  [[ "$PROFILE_BYTES" =~ ^[0-9]+$ ]] || PROFILE_BYTES=0
}

# The Chrome version an archive of a profile names.
archive_chrome() {
  local version
  version="$(tar -xzOf "$1" './Last Version' 2>/dev/null | head -c 64 || true)"
  if [[ -z "$version" ]]; then
    version="$(tar -xzOf "$1" ./Default/Preferences 2>/dev/null | grep -o '"last_chrome_version":"[0-9.]*"' | head -n 1 || true)"
  fi
  chrome_of "$version" || true
}

snapshot_valid() {
  local dir="$SNAP_DIR/$1" name="$2"
  [[ -n "$name" && -f "$dir/$name" && -f "$dir/$name.meta" ]] || return 1
  [[ "$(sha256_of "$dir/$name")" == "$(value sha256 "$dir/$name.meta")" ]]
}

# Snapshot a profile whose container is stopped. Prints the file's name.
# (Called in conditions, where errexit is off: every step checks itself.)
take_snapshot() {
  local profile="$1" image="$2" chrome="$3" dir name part sha bytes named
  dir="$SNAP_DIR/$profile"
  install -d -m 700 "$SNAP_DIR" "$dir" || return 1
  rm -f "$dir"/.*.part
  name="$(date -u +%Y%m%dT%H%M%SZ)-chrome-${chrome:-none}-${RUN:-manual}.tar.gz"
  part=".$name.part"
  if ! profile_helper snapshot "$profile" "$image" "$dir" "$part" >&2; then
    rm -f "$dir/$part"
    log "the profile could not be packed"
    return 1
  fi
  if ! tar -tzf "$dir/$part" >/dev/null 2>&1; then
    rm -f "$dir/$part"
    log "the snapshot does not read back"
    return 1
  fi
  named="$(archive_chrome "$dir/$part")"
  if [[ "$named" != "$chrome" ]]; then
    rm -f "$dir/$part"
    log "the snapshot names Chrome ${named:-none}, the profile ${chrome:-none}"
    return 1
  fi
  sha="$(sha256_of "$dir/$part")" && [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  bytes="$(wc -c <"$dir/$part" | tr -d ' ')"
  chmod 600 "$dir/$part" && mv -f "$dir/$part" "$dir/$name" || return 1
  # The metadata last: a snapshot without it is no snapshot.
  printf 'profile=%s\npage=%s\nimage=%s\nchrome=%s\ncreated=%s\nsha256=%s\nbytes=%s\nrun=%s\n' \
    "$profile" "$PAGE" "$image" "$chrome" "$(now_iso)" "$sha" "$bytes" "${RUN:-manual}" > "$dir/.$name.meta.part" || return 1
  mv -f "$dir/.$name.meta.part" "$dir/$name.meta" || return 1
  prune_snapshots "$profile"
  printf '%s' "$name"
}

# The newest three of a profile, and every one an unfinished update names.
prune_snapshots() {
  local profile="$1" dir="$SNAP_DIR/$1" keep=" " meta name count=0 file
  [[ -d "$dir" ]] || return 0
  for file in "$UPDATE_DIR"/pages/*/state; do
    [[ -f "$file" ]] || continue
    [[ "$(value PROFILE "$file")" == "$profile" ]] || continue
    terminal "$(value STEP "$file")" && continue
    keep+="$(value SNAPSHOT "$file") "
  done
  while IFS= read -r meta; do
    [[ -n "$meta" ]] || continue
    name="$(basename "$meta" .meta)"
    count=$((count + 1))
    ((count <= KEEP_SNAPSHOTS)) && continue
    [[ "$keep" == *" $name "* ]] && continue
    rm -f "$dir/$name" "$meta"
    journal snapshot_pruned "$profile/$name"
  done < <(ls -1 "$dir"/*.meta 2>/dev/null | sort -r)
}

# ── the page's checks in its container (exit closed, nothing leaves) ──────

# The new Chrome opens the profile, and the image's rules extension is
# installed by policy (profile-check.mjs). Sets CHECK_DETAIL.
profile_check() {
  local page="$1" expected="$2" container out line chrome
  container="$(container_of "$page")"
  CHECK_DETAIL=""
  if ! docker cp "$PROFILE_CHECK" "$container:/tmp/pb-profile-check.mjs" >/dev/null 2>&1 \
    || ! docker exec "$container" chmod 644 /tmp/pb-profile-check.mjs; then
    CHECK_DETAIL="the profile check could not be put in the container"
    return 1
  fi
  out="$(docker exec "$container" /command/s6-setuidgid pb-operator node --no-warnings /tmp/pb-profile-check.mjs 2>&1)" || true
  line="$(grep '^{' <<<"$out" | tail -n 1 || true)"
  if [[ "$line" != *'"ok":true'* ]]; then
    local failed error
    failed="$(sed -n 's/.*"failed":\[\([^]]*\)\].*/\1/p' <<<"$line" | tr -d '"' | tr ',' ' ')"
    error="$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' <<<"$line")"
    CHECK_DETAIL="profile check failed: ${failed:-no report}${error:+ ($error)}"
    [[ -n "$line" ]] || CHECK_DETAIL+=": $(printf '%s' "$out" | tail -n 2 | scrub)"
    journal profile_check "$(printf '%s' "${line:-$out}" | scrub)"
    return 1
  fi
  chrome="$(chrome_of "$(sed -n 's/.*"chrome":"\([^"]*\)".*/\1/p' <<<"$line")" || true)"
  if [[ "$chrome" != "$expected" ]]; then
    CHECK_DETAIL="the container's Chrome is ${chrome:-unknown}, not $expected"
    return 1
  fi
}

# Every host check of the page on <image>: the container runs it, healthy;
# its Chrome opens the profile with the rules extension; the profile names
# that Chrome afterwards.
host_checks() {
  local page="$1" image="$2" chrome="$3" profile="$4" state
  state="$(container_state "$page")"
  if [[ "$state" != "true $image healthy" ]]; then
    CHECK_DETAIL="the container is not running healthy on $image (${state:-absent})"
    return 1
  fi
  profile_check "$page" "$chrome" || return 1
  if ! read_profile "$profile" "$image"; then
    CHECK_DETAIL="the profile cannot be read"
    return 1
  fi
  if [[ "$PROFILE_CHROME" != "$chrome" ]]; then
    CHECK_DETAIL="the profile names Chrome ${PROFILE_CHROME:-none} after the check, not $chrome"
    return 1
  fi
}

# ── the Hub: its CLI (audited levers) and read-only SQL ──────────────────

hub_compose() { (cd "$HUB_DIR" && docker compose --env-file .env.production -f docker-compose.production.yml "$@"); }

# A lever of the Hub's CLI; its output to the operator's terminal, its
# refusal journaled.
hub_lever() {
  local out rc=0
  out="$(hub_compose exec -T api node apps/runtime/dist/cli.js "$@" </dev/null 2>&1)" || rc=$?
  [[ -z "$out" ]] || printf '%s\n' "$out" >&2
  if ((rc != 0)); then
    journal hub_refused "$* → exit $rc: $(printf '%s' "$out" | tail -n 3 | scrub)"
    return "$rc"
  fi
}

# The page as the Hub knows it (H_*): its transport and leave of its
# browser, whether a Node session is stored, its owner generation, and the
# operator's last state as the engine recorded it (page_browsers).
# Instants in milliseconds, on the database's clock.
hub_read() {
  local row
  row="$(hub_compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -AtqX -F "|"' <<SQL
-- pb-update:page $PAGE
BEGIN READ ONLY;
SELECT sp.transport,
       coalesce(sp.browser_leave_generation::text, ''),
       coalesce(sp.browser_left_by, ''),
       coalesce(sp.browser_left_generation::text, ''),
       sp.owner_generation::text,
       (EXISTS (SELECT 1 FROM page_credentials pc WHERE pc.platform_account_id = sp.page_id))::text,
       coalesce(pb.profile_id::text, ''),
       coalesce(pb.step, ''),
       coalesce(pb.stop_reason, ''),
       coalesce(pb.exit_open::text, ''),
       coalesce(pb.session_fingerprint, ''),
       coalesce(pb.account_id, ''),
       coalesce(pb.exit_ip, ''),
       coalesce(pb.pinned_exit_ip, ''),
       coalesce(pb.chrome_version, ''),
       coalesce(pb.operator_version, ''),
       coalesce(pb.selftest_ok::text, ''),
       coalesce((extract(epoch from pb.selftest_at) * 1000)::bigint::text, ''),
       coalesce(pb.selftest_failed, ''),
       coalesce((extract(epoch from pb.last_state_at) * 1000)::bigint::text, ''),
       (extract(epoch from clock_timestamp()) * 1000)::bigint::text
  FROM sync_pages sp
  JOIN pages p ON p.id = sp.page_id
  LEFT JOIN page_browsers pb ON pb.page_id = sp.page_id
 WHERE p.label = '$PAGE';
COMMIT;
SQL
)" || return 1
  row="$(sed -n '1p' <<<"$row")"
  [[ -n "$row" ]] || return 3
  IFS='|' read -r H_TRANSPORT H_LEAVE H_LEFT_BY H_LEFT_GEN H_GENERATION H_NODE_SESSION H_PROFILE H_STEP H_STOP H_EXIT_OPEN \
    H_FINGERPRINT H_ACCOUNT H_EXIT_IP H_PINNED H_CHROME H_OPERATOR H_SELFTEST_OK H_SELFTEST_AT H_SELFTEST_FAILED H_STATE_AT H_NOW <<<"$row"
  [[ "$H_TRANSPORT" == node || "$H_TRANSPORT" == browser ]] || return 1
}

# ── the state of a page's update (key=value, rewritten whole) ─────────────

STATE=""
terminal() { [[ "$TERMINAL_STEPS" == *" $1 "* ]]; }
sget() {
  [[ -f "$STATE" ]] || return 0
  sed -n "s/^$1=//p" "$STATE" | tail -n 1
}
sset() {
  local kv keys="UPDATED_AT" tmp="$STATE.tmp"
  for kv in "$@"; do keys+="|${kv%%=*}"; done
  install -d -m 700 "$(dirname "$STATE")"
  {
    if [[ -f "$STATE" ]]; then grep -v -E "^($keys)=" "$STATE" || true; fi
    for kv in "$@"; do printf '%s\n' "$(printf '%s' "$kv" | tr '\n\r' '  ')"; done
    printf 'UPDATED_AT=%s\n' "$(now_iso)"
  } > "$tmp"
  mv -f "$tmp" "$STATE"
}
step_to() {
  sset "STEP=$1"
  journal step "$1"
}

# ── the lock: one update, rollback, build or prune at a time ──────────────

take_lock() {
  install -d -m 700 "$UPDATE_DIR"
  exec 9>"$UPDATE_DIR/.lock"
  flock -n 9 || return 1
  LOCK_HELD=1
}
# Nobody holds the lock (this process holds it, or it is free): an update
# that is not finished is not running.
lock_free() {
  ((LOCK_HELD == 1)) && return 0
  (exec 8>"$UPDATE_DIR/.lock" && flock -n 8)
}

# ── one page's update ─────────────────────────────────────────────────────

note_of() { printf 'page-browser-update %s: Chrome %s -> %s (%s)' "$RUN" "$(sget FROM_CHROME)" "$(sget TO_CHROME)" "$1"; }

# The forward steps failed: before the new image ran, the page goes back
# as it was; after, a rollback.
forward_failed() {
  sset "REASON=$1"
  alert update_failed "$1"
  if [[ "$(sget NEW_RAN)" == 1 ]]; then step_to rolling_back; else step_to aborting; fi
}

# Waits until the page's leave of its browser is confirmed. 0: by the
# operator; 1: the deadline; 2: something else happened (said).
wait_leave() {
  local since="$1" deadline=$(( $(now_s) + LEAVE_WAIT_S ))
  while :; do
    if hub_read; then
      if [[ "$H_TRANSPORT" != node ]]; then
        LEAVE_WHY="the page is back on its browser (transport $H_TRANSPORT): not this update's doing"
        return 2
      fi
      if [[ -z "$H_LEAVE" && -n "$H_LEFT_GEN" ]] && ((10#$H_LEFT_GEN >= 10#$since)); then
        [[ "$H_LEFT_BY" == operator ]] && return 0
        LEAVE_WHY="the leave was confirmed by the $H_LEFT_BY's word, not by the operator"
        return 2
      fi
      if [[ -z "$H_LEAVE" && -z "$H_LEFT_GEN" ]]; then
        LEAVE_WHY="the page is on Node with no leave pending or confirmed"
        return 2
      fi
    fi
    (( $(now_s) < deadline )) || { LEAVE_WHY="the leave was not confirmed within ${LEAVE_WAIT_S} s"; return 1; }
    sleep "$POLL_S"
  done
}

step_take_out() {
  local page="$PAGE"
  if [[ "$(sget ENGINE)" == hub && "$(sget TRANSPORT_BEFORE)" == browser ]]; then
    if ! hub_read; then forward_failed "the Hub cannot be read"; return; fi
    if [[ "$H_TRANSPORT" == browser ]]; then
      sset TRANSPORT_CHANGED=1
      if ! hub_lever sync page transport "$page" node --note "$(note_of 'the page leaves its browser for the update')"; then
        forward_failed "the Hub refused to take $page off its browser"
        return
      fi
    fi
    local rc=0
    wait_leave "$(sget PLAN_GENERATION)" || rc=$?
    if ((rc != 0)); then forward_failed "$LEAVE_WHY"; return; fi
    say taken_out "the page left its browser: the operator confirmed it (generation $H_LEFT_GEN); Node has the page"
  fi
  local chrome
  chrome="$(chrome_state "$page")"
  if [[ "$chrome" != down ]]; then
    forward_failed "Chrome is $chrome in $(container_of "$page"): the update never stops a working page"
    return
  fi
  step_to taken_out
}

step_stop() {
  sset CONTAINER_STOPPED=1
  if container_running "$PAGE" && ! docker stop -t 25 "$(container_of "$PAGE")" >/dev/null; then
    forward_failed "$(container_of "$PAGE") could not be stopped"
    return
  fi
  if container_running "$PAGE"; then forward_failed "$(container_of "$PAGE") still runs"; return; fi
  step_to stopped
}

step_snapshot() {
  local profile name
  profile="$(sget PROFILE)"
  if snapshot_valid "$profile" "$(sget SNAPSHOT)"; then step_to snapshotted; return; fi
  if container_running "$PAGE"; then forward_failed "$(container_of "$PAGE") runs: no snapshot of a profile in use"; return; fi
  if ! read_profile "$profile" "$(sget FROM_IMAGE)"; then forward_failed "the profile cannot be read"; return; fi
  if ! name="$(take_snapshot "$profile" "$(sget FROM_IMAGE)" "$PROFILE_CHROME")"; then
    forward_failed "the profile's snapshot failed"
    return
  fi
  sset "SNAPSHOT=$name" "SNAP_CHROME=$PROFILE_CHROME"
  say snapshot "snapshots/$profile/$name (Chrome ${PROFILE_CHROME:-none})"
  step_to snapshotted
}

step_start_new() {
  local to
  to="$(sget TO_IMAGE)"
  # From here the new Chrome may open the profile: a failure is a rollback.
  sset NEW_RAN=1
  if ! "$PAGE_SH" up --page "$PAGE" --image "$to" >&2; then
    forward_failed "page.sh up $to failed"
    return
  fi
  step_to started
}

step_host_checks() {
  if ! host_checks "$PAGE" "$(sget TO_IMAGE)" "$(sget TO_CHROME)" "$(sget PROFILE)"; then
    forward_failed "host check on $(sget TO_IMAGE): $CHECK_DETAIL"
    return
  fi
  say host_checks "the new Chrome $(sget TO_CHROME) opened the profile; the image's rules extension is installed by policy"
  step_to host_checked
}

# The page back to its browser, when this update took it off. <key>: where
# the instant goes (the database's clock, before the lever): the engine's
# checks count only what the operator said after it. A give-back already
# done (a resume after a crash) keeps the instant it had.
give_back() {
  local key="$1" note="$2"
  if ! hub_read; then return 1; fi
  if [[ "$H_TRANSPORT" == browser && -z "$H_LEAVE" ]]; then
    [[ -n "$(sget "$key")" ]] || sset "$key=$H_NOW"
    return 0
  fi
  sset "$key=$H_NOW"
  hub_lever sync page transport "$PAGE" browser --note "$(note_of "$note")"
}

step_give_back() {
  if [[ "$(sget ENGINE)" != hub || "$(sget TRANSPORT_BEFORE)" != browser ]]; then
    say engine_checks "skipped: the page was not on its browser before the update (${ENGINE_WHY:-$(sget TRANSPORT_BEFORE)}); it stands until its engine starts it"
    sset ENGINE_CHECKS=skipped
    step_to engine_checked
    return
  fi
  if ! give_back GIVEN_BACK_MS "the page returns to its browser on the new image"; then
    forward_failed "the Hub refused to give the page back to its browser"
    return
  fi
  step_to given_back
}

# The engine's record of the page on <chrome> since <ms>: 0 ready, 1 not
# yet, 2 failed (why in ENGINE_WHY), 3 the owner's doing (off its browser,
# or its browser stopped by him).
judge_engine() {
  local chrome="$1" since="$2" revision="$3"
  ENGINE_WHY=""
  if [[ "$H_TRANSPORT" != browser || -n "$H_LEAVE" ]]; then
    ENGINE_WHY="the page is not on its browser (transport $H_TRANSPORT${H_LEAVE:+, a leave pending})"
    return 3
  fi
  if [[ -z "$H_STATE_AT" ]] || ((10#$H_STATE_AT <= 10#$since)); then
    ENGINE_WHY="no state of the operator since the page was given back"
    return 1
  fi
  if [[ -n "$H_STOP" ]]; then
    ENGINE_WHY="stopped: $H_STOP"
    # The owner's stop of the browser: his to decide, not a failure.
    [[ "$H_STOP" == owner_stop ]] && return 3
    [[ "$FATAL_STOPS" == *" $H_STOP "* ]] && return 2
    return 1
  fi
  [[ "$H_STEP" == ready ]] || { ENGINE_WHY="at $H_STEP"; return 1; }
  local -a wrong=()
  [[ "$(chrome_of "$H_CHROME" || true)" == "$chrome" ]] || wrong+=("Chrome ${H_CHROME:-unknown}, not $chrome")
  [[ -z "$revision" || "$H_OPERATOR" == "$revision" ]] || wrong+=("operator ${H_OPERATOR:-unknown}, not $revision")
  [[ "$H_SELFTEST_OK" == true && -z "$H_SELFTEST_FAILED" && -n "$H_SELFTEST_AT" ]] && ((10#$H_SELFTEST_AT > 10#$since)) \
    || wrong+=("no self-test passed since (ok=${H_SELFTEST_OK:-none} failed=${H_SELFTEST_FAILED:-none})")
  [[ "$H_EXIT_OPEN" == true ]] || wrong+=("the exit is closed")
  [[ -n "$H_PINNED" && "$H_EXIT_IP" == "$H_PINNED" ]] || wrong+=("exit IP ${H_EXIT_IP:-none}, pinned ${H_PINNED:-none}")
  local account fingerprint
  account="$(sget ACCOUNT_BEFORE)"
  fingerprint="$(sget FINGERPRINT_BEFORE)"
  [[ -z "$account" || "$H_ACCOUNT" == "$account" ]] || wrong+=("another account answers")
  [[ -z "$fingerprint" || "$H_FINGERPRINT" == "$fingerprint" ]] || wrong+=("another session (a new login): the session did not survive")
  if ((${#wrong[@]} > 0)); then
    ENGINE_WHY="ready, but: $(IFS=';'; printf '%s' "${wrong[*]}")"
    return 2
  fi
}

# Waits for the engine to report the page ready on <chrome>. 0 ready, 2
# failed, 3 off its browser (ENGINE_WHY says).
wait_ready() {
  local chrome="$1" since="$2" revision="$3" deadline=$(( $(now_s) + READY_WAIT_S )) rc
  while :; do
    if hub_read; then
      rc=0
      judge_engine "$chrome" "$since" "$revision" || rc=$?
      case "$rc" in
        0) return 0 ;;
        2|3) return "$rc" ;;
      esac
    else
      ENGINE_WHY="the Hub cannot be read"
    fi
    if (( $(now_s) >= deadline )); then
      ENGINE_WHY="not ready within ${READY_WAIT_S} s (last: ${ENGINE_WHY:-nothing})"
      return 2
    fi
    sleep "$POLL_S"
  done
}

# The update stops where it is (resumable): the owner moved the page.
hold() {
  sset "HELD_FROM=$(sget STEP)" "REASON=$1"
  alert update_held "$1 — the update holds: page-browser-update.sh resume|rollback --page $PAGE"
  step_to held
}

step_engine_checks() {
  local rc=0
  wait_ready "$(sget TO_CHROME)" "$(sget GIVEN_BACK_MS)" "$(sget TO_REVISION)" || rc=$?
  case "$rc" in
    0)
      sset "READY_MS=$H_STATE_AT" ENGINE_CHECKS=passed
      say engine_checks "ready on Chrome $(sget TO_CHROME): self-test, environment, exit IP $H_EXIT_IP, site, the same session confirmed by the engine's identity read"
      step_to engine_checked
      ;;
    3) hold "$ENGINE_WHY" ;;
    *) forward_failed "engine checks on Chrome $(sget TO_CHROME): $ENGINE_WHY" ;;
  esac
}

step_window() {
  local window until misses=0 rc
  window="$(sget WINDOW_S)"
  if [[ "$(sget ENGINE_CHECKS)" != passed || "${window:-0}" == 0 ]]; then
    sset WINDOW=none
    step_to done
    return
  fi
  until="$(sget WINDOW_UNTIL)"
  if [[ -z "$until" ]]; then
    until=$(( $(now_s) + window ))
    sset "WINDOW_FROM=$(now_s)" "WINDOW_UNTIL=$until"
    say window "watching until $(iso_of "$until")"
  fi
  while (( $(now_s) < until )); do
    local left=$(( until - $(now_s) ))
    sleep "$(( left < WINDOW_POLL_S ? left : WINDOW_POLL_S ))"
    if ! hub_read; then
      misses=$((misses + 1))
      ENGINE_WHY="the Hub cannot be read"
    else
      rc=0
      judge_engine "$(sget TO_CHROME)" "$(sget GIVEN_BACK_MS)" "$(sget TO_REVISION)" || rc=$?
      if ((rc == 0)) && (( 10#$H_NOW - 10#$H_STATE_AT > STATE_FRESH_S * 1000 )); then
        rc=1
        ENGINE_WHY="no state of the operator for $(( (10#$H_NOW - 10#$H_STATE_AT) / 1000 )) s"
      fi
      case "$rc" in
        0) misses=0 ;;
        3) hold "during the window: $ENGINE_WHY"; return ;;
        2) forward_failed "during the window: $ENGINE_WHY"; return ;;
        *) misses=$((misses + 1)) ;;
      esac
    fi
    if ((misses >= 2)); then forward_failed "during the window: $ENGINE_WHY"; return; fi
  done
  local since out=0
  since="$(iso_of $(( 10#$(sget READY_MS) / 1000 )))"
  hub_lever sync check live-hour --page "$PAGE" --since "$since" --until "$(iso_of "$until")" || out=$?
  if ((out != 0)); then
    forward_failed "sync check live-hour over the window: exit $out (1 failed, 2 inconclusive)"
    return
  fi
  sset WINDOW=passed
  say window "passed: ready all along, sync check live-hour accepted"
  step_to done
}

# ── rollback: the page out again, its snapshot, its previous image ────────

rollback_failed() {
  sset "RB_FAILED=$1"
  alert rollback_failed "$1 — the page stays out of service on its browser; the owner decides (page-browser-update.sh resume --page $PAGE tries the rollback again)"
  step_to rollback_failed
}

rb_take_out() {
  if [[ "$(sget ENGINE)" == hub && "$(sget TRANSPORT_CHANGED)" == 1 ]]; then
    if ! hub_read; then rollback_failed "the Hub cannot be read"; return; fi
    local since="$H_GENERATION"
    if [[ "$H_TRANSPORT" == browser ]]; then
      if ! hub_lever sync page transport "$PAGE" node --note "$(note_of 'rollback: the page leaves its browser')"; then
        rollback_failed "the Hub refused to take $PAGE off its browser"
        return
      fi
    elif [[ -n "$H_LEAVE" ]]; then
      since="$H_LEAVE"
    else
      since="$(sget PLAN_GENERATION)"
    fi
    local rc=0
    wait_leave "$since" || rc=$?
    if ((rc == 1)); then
      # Its operator cannot confirm (the new image's?): the container goes
      # first, then the Hub is told — as `deploy-page-browser.sh to-node`.
      alert rollback_forced "$LEAVE_WHY: the container is removed, then the Hub told it stopped (--browser-stopped)"
      sset RB_FORCED=1
      if ! "$PAGE_SH" down --page "$PAGE" >&2 || [[ -n "$(container_state "$PAGE")" ]]; then
        rollback_failed "$(container_of "$PAGE") could not be removed"
        return
      fi
      if ! hub_lever sync page transport "$PAGE" node --browser-stopped --note "$(note_of 'rollback: the container is removed')"; then
        rollback_failed "the Hub was not told the browser stopped"
        return
      fi
    elif ((rc != 0)); then
      rollback_failed "$LEAVE_WHY"
      return
    fi
  fi
  sset RB_STEP=taken_out
}

rb_stop() {
  if [[ -n "$(container_state "$PAGE")" ]] && container_running "$PAGE"; then
    if ! docker stop -t 25 "$(container_of "$PAGE")" >/dev/null || container_running "$PAGE"; then
      rollback_failed "$(container_of "$PAGE") could not be stopped"
      return
    fi
  fi
  sset RB_STEP=stopped
}

rb_restore() {
  local profile name expected
  profile="$(sget PROFILE)"
  name="$(sget SNAPSHOT)"
  expected="$(sget SNAP_CHROME)"
  if ! snapshot_valid "$profile" "$name"; then
    rollback_failed "the snapshot ${name:-(none)} is missing or does not match its SHA-256: Chrome $(sget FROM_CHROME) must not open a profile Chrome $(sget TO_CHROME) wrote"
    return
  fi
  if container_running "$PAGE"; then rollback_failed "$(container_of "$PAGE") runs: no restore under it"; return; fi
  if ! profile_helper restore "$profile" "$(sget FROM_IMAGE)" "$SNAP_DIR/$profile" "$name" >&2; then
    rollback_failed "the snapshot could not be restored"
    return
  fi
  if ! read_profile "$profile" "$(sget FROM_IMAGE)" || [[ "$PROFILE_CHROME" != "$expected" ]]; then
    rollback_failed "the restored profile names Chrome ${PROFILE_CHROME:-none}, its snapshot ${expected:-none}"
    return
  fi
  say restored "snapshots/$profile/$name restored (Chrome ${expected:-none})"
  sset RB_STEP=restored
}

rb_start_old() {
  if ! "$PAGE_SH" up --page "$PAGE" --image "$(sget FROM_IMAGE)" >&2; then
    rollback_failed "page.sh up $(sget FROM_IMAGE) failed"
    return
  fi
  sset RB_STEP=started
}

rb_host_checks() {
  if ! host_checks "$PAGE" "$(sget FROM_IMAGE)" "$(sget FROM_CHROME)" "$(sget PROFILE)"; then
    rollback_failed "host check on $(sget FROM_IMAGE): $CHECK_DETAIL"
    return
  fi
  sset RB_STEP=host_checked
}

rb_give_back() {
  if [[ "$(sget ENGINE)" == hub && "$(sget TRANSPORT_CHANGED)" == 1 ]]; then
    if ! give_back RB_GIVEN_BACK_MS "rollback: the page returns to its browser on its previous image"; then
      rollback_failed "the Hub refused to give the page back to its browser"
      return
    fi
    sset RB_STEP=given_back
  else
    sset RB_STEP=given_back RB_CHECKS=skipped
  fi
}

rb_engine_checks() {
  if [[ "$(sget RB_CHECKS)" != skipped ]]; then
    local rc=0
    wait_ready "$(sget FROM_CHROME)" "$(sget RB_GIVEN_BACK_MS)" "$(sget FROM_REVISION)" || rc=$?
    if ((rc == 0)); then
      sset RB_CHECKS=passed
    else
      sset RB_CHECKS=failed
      alert rollback_checks "back on $(sget FROM_IMAGE) with its snapshot, but its start did not pass: $ENGINE_WHY"
    fi
  fi
  alert rolled_back "the update to $(sget TO_IMAGE) is rolled back ($(sget REASON)): the page is on $(sget FROM_IMAGE) with its profile from before (engine checks: $(sget RB_CHECKS))"
  step_to rolled_back
}

step_rollback() {
  case "$(sget RB_STEP)" in
    "") rb_take_out ;;
    taken_out) rb_stop ;;
    stopped) rb_restore ;;
    restored) rb_start_old ;;
    started) rb_host_checks ;;
    host_checked) rb_give_back ;;
    given_back) rb_engine_checks ;;
    *) rollback_failed "unknown rollback step $(sget RB_STEP)" ;;
  esac
}

# Before the new image ran: the page as it was.
step_abort() {
  if [[ "$(sget CONTAINER_STOPPED)" == 1 ]] && ! container_running "$PAGE"; then
    if ! "$PAGE_SH" up --page "$PAGE" --image "$(sget FROM_IMAGE)" >&2; then
      rollback_failed "page.sh up $(sget FROM_IMAGE) failed: the page's container is not back"
      return
    fi
  fi
  if [[ "$(sget ENGINE)" == hub && "$(sget TRANSPORT_CHANGED)" == 1 ]]; then
    if ! give_back RB_GIVEN_BACK_MS "abort: the page returns to its browser, unchanged"; then
      rollback_failed "the Hub refused to give the page back to its browser"
      return
    fi
  fi
  alert aborted "the update to $(sget TO_IMAGE) did not happen ($(sget REASON)): the page is as it was, on $(sget FROM_IMAGE)"
  step_to aborted
}

# Runs the page's update from its recorded step to an end.
advance() {
  local step
  while :; do
    step="$(sget STEP)"
    case "$step" in
      planned) step_take_out ;;
      taken_out) step_stop ;;
      stopped) step_snapshot ;;
      snapshotted) step_start_new ;;
      started) step_host_checks ;;
      host_checked) step_give_back ;;
      given_back) step_engine_checks ;;
      engine_checked) step_window ;;
      rolling_back) step_rollback ;;
      aborting) step_abort ;;
      done)
        propose updated "$PAGE is on $(sget TO_IMAGE) (Chrome $(sget TO_CHROME)); window: $(sget WINDOW)"
        return 0
        ;;
      aborted|rolled_back|held|rollback_failed) return 1 ;;
      *) alert update_state "unknown step '$step' in $STATE"; return 1 ;;
    esac
  done
}

on_exit() {
  local rc=$?
  if [[ -n "$STATE" && -f "$STATE" ]]; then
    local step
    step="$(sget STEP)"
    if ! terminal "$step" && [[ "$step" != held && "$step" != rollback_failed ]]; then
      alert update_interrupted "stopped at step $step (exit $rc): page-browser-update.sh resume --page $PAGE goes on from there"
    fi
  fi
}

# The page's update: refusals change nothing (exit 2).
plan_update() {
  local image="$1" window="$2" engine="$3" any_hour="$4"
  local env from profile from_chrome to_chrome run_state
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  [[ "$image" =~ ^hub-page-browser:[A-Za-z0-9_.-]+$ ]] || fail "--image: hub-page-browser:<tag>"
  env="$(page_env "$PAGE")"
  [[ -f "$env" ]] || fail "no page $PAGE here ($env)"
  STATE="$UPDATE_DIR/pages/$PAGE/state"
  if [[ -f "$STATE" ]] && ! terminal "$(sget STEP)"; then
    [[ "$(sget TO_IMAGE)" == "$image" ]] || fail "an update of $PAGE to $(sget TO_IMAGE) is unfinished (step $(sget STEP)): resume or rollback it first"
    log "the update of $PAGE to $image is unfinished: resuming it at step $(sget STEP) (its own window and engine as planned)"
    return 0
  fi
  from="$(value PB_IMAGE "$env")"
  profile="$(value PB_PROFILE_ID "$env")"
  [[ -n "$from" && "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "$env names no image or profile"
  [[ "$from" != "$image" ]] || fail "$PAGE is on $image already"
  run_state="$(container_state "$PAGE")"
  [[ "$run_state" == "true $from healthy" ]] || fail "$(container_of "$PAGE") is not running healthy on $from (${run_state:-absent})"
  docker image inspect "$image" >/dev/null 2>&1 || fail "no image $image here (page-browser-update.sh build, or deploy-page-browser.sh build)"
  from_chrome="$(image_chrome "$from")" || fail "the Chrome of $from cannot be read"
  to_chrome="$(image_chrome "$image")" || fail "the Chrome of $image cannot be read"
  ver_gt "$from_chrome" "$to_chrome" && fail "$image has Chrome $to_chrome, older than $from_chrome: Chrome never goes back on a profile (rollback restores a snapshot)"
  read_profile "$profile" "$from" || fail "the profile pb-profile-$profile cannot be read"
  ver_gt "$PROFILE_CHROME" "$to_chrome" && fail "the profile was last opened by Chrome $PROFILE_CHROME, newer than $to_chrome"
  local free_kb need_kb
  install -d -m 700 "$SNAP_DIR"
  free_kb="$(df -Pk "$SNAP_DIR" | awk 'NR == 2 { print $4 }')"
  need_kb=$(( PROFILE_BYTES / 1024 + 1048576 ))
  [[ "$free_kb" =~ ^[0-9]+$ ]] && ((free_kb >= need_kb)) || fail "not enough room for the profile's snapshot in $SNAP_DIR (${free_kb:-?} KiB free, $need_kb needed)"
  if [[ "$any_hour" != 1 ]]; then
    local hour
    hour="$(date -u +%H)"
    ((10#$hour >= QUIET_FROM_H && 10#$hour < QUIET_TO_H)) \
      || fail "a page is updated between ${QUIET_FROM_H}:00 and ${QUIET_TO_H}:00 UTC, when someone can react (plan §4.10); --any-hour to override"
  fi
  local transport=none generation="" fingerprint="" account=""
  if [[ "$engine" == hub ]]; then
    local rc=0
    hub_read || rc=$?
    ((rc == 0)) || { ((rc == 3)) && fail "the Hub knows no page $PAGE (--engine none for a page it does not know)"; fail "the Hub cannot be read"; }
    [[ -z "$H_LEAVE" ]] || fail "$PAGE is leaving its browser already (leave $H_LEAVE pending)"
    transport="$H_TRANSPORT"
    generation="$H_GENERATION"
    if [[ "$transport" == browser ]]; then
      [[ "$H_PROFILE" == "$profile" ]] || fail "the Hub binds profile ${H_PROFILE:-none} to $PAGE, its container has $profile"
      [[ "$H_NODE_SESSION" == true ]] \
        || fail "$PAGE has no Node session stored: taking its browser out without one needs \`sync browser stop\` (Project Browser PR 17)"
      fingerprint="$H_FINGERPRINT"
      account="$H_ACCOUNT"
    fi
  fi
  RUN="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  rm -f "$STATE"
  sset "RUN=$RUN" "PAGE=$PAGE" "PROFILE=$profile" "ENGINE=$engine" \
    "FROM_IMAGE=$from" "TO_IMAGE=$image" "FROM_CHROME=$from_chrome" "TO_CHROME=$to_chrome" \
    "FROM_REVISION=$(image_revision "$from")" "TO_REVISION=$(image_revision "$image")" \
    "TRANSPORT_BEFORE=$transport" "PLAN_GENERATION=$generation" "FINGERPRINT_BEFORE=$fingerprint" "ACCOUNT_BEFORE=$account" \
    "WINDOW_S=$window" "STARTED_AT=$(now_iso)"
  say planned "Chrome $from_chrome -> $to_chrome: $from -> $image (profile $profile, transport $transport, engine $engine, window ${window} s)"
  step_to planned
}

window_seconds() {
  case "$1" in
    0) echo 0 ;;
    *[0-9]s) echo "${1%s}" ;;
    *[0-9]m) echo $(( ${1%m} * 60 )) ;;
    *[0-9]h) echo $(( ${1%h} * 3600 )) ;;
    *) fail "--window: 0, <n>s, <n>m or <n>h" ;;
  esac
}

# The same command as a transient unit of its own, with this run's PB_*
# settings: an hour's window outlives the SSH session that started it.
detach() {
  local unit="page-browser-update-$1-$(date -u +%Y%m%dT%H%M%S)" arg name
  local -a args=() env=()
  for arg in "${ORIGINAL_ARGS[@]}"; do [[ "$arg" == --detach ]] || args+=("$arg"); done
  while IFS= read -r name; do env+=("--setenv=$name=${!name}"); done < <(compgen -e | grep '^PB_' || true)
  systemd-run --unit "$unit" --collect --quiet --property=TimeoutStartSec=infinity "${env[@]+"${env[@]}"}" "$SELF" "${args[@]}"
  log "running as the unit $unit: follow it with journalctl -fu $unit (it outlives this session)"
  exit 0
}

cmd_update() {
  local image="" window="60m" engine=hub any_hour=0 detached=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      --image) image="${2:-}"; shift 2 ;;
      --window) window="${2:-}"; shift 2 ;;
      --engine) engine="${2:-}"; shift 2 ;;
      --any-hour) any_hour=1; shift ;;
      --detach) detached=1; shift ;;
      *) fail "update: unknown option $1" ;;
    esac
  done
  [[ "$engine" == hub || "$engine" == none ]] || fail "--engine: hub or none"
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  ((detached == 0)) || detach "$PAGE"
  local seconds
  seconds="$(window_seconds "$window")"
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  plan_update "$image" "$seconds" "$engine" "$any_hour"
  RUN="$(sget RUN)"
  trap on_exit EXIT
  advance
}

cmd_resume() {
  local detached=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      --detach) detached=1; shift ;;
      *) fail "resume: unknown option $1" ;;
    esac
  done
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  ((detached == 0)) || detach "$PAGE"
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  STATE="$UPDATE_DIR/pages/$PAGE/state"
  [[ -f "$STATE" ]] || fail "no update of $PAGE to resume"
  RUN="$(sget RUN)"
  local step
  step="$(sget STEP)"
  terminal "$step" && fail "the last update of $PAGE ended ($step): nothing to resume"
  case "$step" in
    held) step_to "$(sget HELD_FROM)" ;;
    rollback_failed) step_to rolling_back ;;
  esac
  say resumed "from step $(sget STEP)${step:+ (was $step)}"
  trap on_exit EXIT
  advance
}

cmd_rollback() {
  local reason="the owner's rollback" detached=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      --reason) reason="${2:-}"; shift 2 ;;
      --detach) detached=1; shift ;;
      *) fail "rollback: unknown option $1" ;;
    esac
  done
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  ((detached == 0)) || detach "$PAGE"
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  STATE="$UPDATE_DIR/pages/$PAGE/state"
  [[ -f "$STATE" ]] || fail "no update of $PAGE to roll back"
  RUN="$(sget RUN)"
  local step
  step="$(sget STEP)"
  case "$step" in
    aborted|rolled_back) fail "the last update of $PAGE ended $step: nothing to roll back" ;;
    rolling_back|aborting) ;;
    done)
      [[ "$(value PB_IMAGE "$(page_env "$PAGE")")" == "$(sget TO_IMAGE)" ]] \
        || fail "$PAGE is not on $(sget TO_IMAGE) any more: its last update is not the page's state to undo"
      sset "REASON=$reason" NEW_RAN=1 RB_STEP= RB_GIVEN_BACK_MS= TRANSPORT_CHANGED="$([[ "$(sget TRANSPORT_BEFORE)" == browser ]] && echo 1 || echo 0)"
      step_to rolling_back
      ;;
    *)
      sset "REASON=$reason"
      if [[ "$(sget NEW_RAN)" == 1 ]]; then step_to rolling_back; else step_to aborting; fi
      ;;
  esac
  say rollback "asked: $reason"
  trap on_exit EXIT
  advance
}

cmd_rollout() {
  local image="" window="0" engine=hub any_hour=0 detached=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --image) image="${2:-}"; shift 2 ;;
      --window) window="${2:-}"; shift 2 ;;
      --engine) engine="${2:-}"; shift 2 ;;
      --any-hour) any_hour=1; shift ;;
      --detach) detached=1; shift ;;
      *) fail "rollout: unknown option $1" ;;
    esac
  done
  [[ "$image" =~ ^hub-page-browser:[A-Za-z0-9_.-]+$ ]] || fail "--image: hub-page-browser:<tag>"
  window_seconds "$window" >/dev/null
  ((detached == 0)) || detach all
  local file pilot=""
  for file in "$UPDATE_DIR"/pages/*/state; do
    [[ -f "$file" ]] || continue
    if [[ "$(value TO_IMAGE "$file")" == "$image" && "$(value STEP "$file")" == done && "$(value WINDOW "$file")" == passed ]]; then
      pilot="$(value PAGE "$file")"
      break
    fi
  done
  [[ -n "$pilot" ]] || fail "no page has passed its window on $image yet: update one first (update --page <page> --image $image)"
  local page env to_chrome
  to_chrome="$(image_chrome "$image")" || fail "the Chrome of $image cannot be read"
  local -a pages=()
  local chrome
  for env in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$env" ]] || continue
    page="$(value PB_PAGE "$env")"
    [[ "$(value PB_IMAGE "$env")" == "$image" ]] && continue
    # A page on this Chrome or a later one already (another revision): not
    # this rollout's.
    chrome="$(image_chrome "$(value PB_IMAGE "$env")" || true)"
    [[ -n "$chrome" ]] && ! ver_gt "$to_chrome" "$chrome" && continue
    pages+=("$page")
  done
  PAGE=""
  say rollout "$image (Chrome $to_chrome) after $pilot's window: ${pages[*]:-no page left}"
  local -a extra=(--window "$window" --engine "$engine")
  ((any_hour == 0)) || extra+=(--any-hour)
  for page in "${pages[@]}"; do
    PAGE="$page"
    if ! "$SELF" update --page "$page" --image "$image" "${extra[@]}"; then
      alert rollout_stopped "the rollout of $image stops at $page: see its update (page-browser-update.sh status --page $page)"
      return 1
    fi
  done
  PAGE=""
  propose rollout_done "every page is on $image (Chrome $to_chrome)"
}

cmd_snapshot() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      *) fail "snapshot: unknown option $1" ;;
    esac
  done
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  local env image profile name was_running=0
  env="$(page_env "$PAGE")"
  [[ -f "$env" ]] || fail "no page $PAGE here"
  image="$(value PB_IMAGE "$env")"
  profile="$(value PB_PROFILE_ID "$env")"
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  if container_running "$PAGE"; then
    [[ "$(chrome_state "$PAGE")" == down ]] || fail "Chrome is not down in $(container_of "$PAGE"): stop the page's browser first (sync browser stop)"
    was_running=1
    docker stop -t 25 "$(container_of "$PAGE")" >/dev/null || fail "$(container_of "$PAGE") could not be stopped"
  fi
  RUN="manual-$(date -u +%Y%m%dT%H%M%SZ)"
  local rc=0
  read_profile "$profile" "$image" && name="$(take_snapshot "$profile" "$image" "$PROFILE_CHROME")" || rc=$?
  if ((was_running == 1)); then docker start "$(container_of "$PAGE")" >/dev/null || alert snapshot "$(container_of "$PAGE") did not start again"; fi
  ((rc == 0)) || { alert snapshot "the snapshot of $PAGE failed"; exit 1; }
  say snapshot "snapshots/$profile/$name (Chrome ${PROFILE_CHROME:-none})"
  printf '%s/%s/%s\n' "$SNAP_DIR" "$profile" "$name"
}

# ── Chrome's repository: the newest Stable, verified ─────────────────────

ARCH=""
host_arch() {
  if [[ -n "${PB_ARCH:-}" ]]; then ARCH="$PB_ARCH"; return; fi
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) fail "no Chrome for $(uname -m)" ;;
  esac
}

# The armored key as a keyring gpgv reads.
dearmor() {
  awk '/^-----BEGIN PGP PUBLIC KEY BLOCK-----/ { inside = 1; body = 0; next }
       /^-----END PGP PUBLIC KEY BLOCK-----/ { inside = 0; next }
       inside && !body && /^$/ { body = 1; next }
       inside && body && /^=/ { next }
       inside && body { print }' "$1" | base64 -d
}

# Sets REPO_VERSION, REPO_FILENAME, REPO_SIZE, REPO_SHA256, REPO_DATE,
# REPO_SIGNER from InRelease (signed by Google's key) and Packages (by its
# SHA-256 in InRelease). 1 with REPO_WHY.
repo_latest() {
  local work="$1" status primary entry
  REPO_WHY=""
  if ! curl -fsS --proto '=https' --max-time 120 --retry 2 -o "$work/InRelease" "$REPO_URL/dists/stable/InRelease" 2>"$work/curl.err"; then
    REPO_WHY="InRelease could not be fetched: $(scrub <"$work/curl.err")"
    return 1
  fi
  [[ -f "$SIGNING_KEY" ]] || { REPO_WHY="no signing key at $SIGNING_KEY"; return 1; }
  dearmor "$SIGNING_KEY" >"$work/key.gpg" 2>/dev/null || { REPO_WHY="the signing key does not read"; return 1; }
  install -d -m 700 "$work/gnupg"
  if ! GNUPGHOME="$work/gnupg" gpgv --status-fd 3 --keyring "$work/key.gpg" -o - "$work/InRelease" \
    3>"$work/gpgv.status" >"$work/Release" 2>"$work/gpgv.err"; then
    REPO_WHY="InRelease is not signed by Google's key: $(scrub <"$work/gpgv.err")"
    return 1
  fi
  status="$work/gpgv.status"
  if grep -Eq '^\[GNUPG:\] (BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY)' "$status" \
    || [[ "$(grep -c '^\[GNUPG:\] GOODSIG ' "$status")" != 1 || "$(grep -c '^\[GNUPG:\] VALIDSIG ' "$status")" != 1 ]]; then
    REPO_WHY="InRelease's signature is not one good signature: $(grep -o '^\[GNUPG:\] [A-Z_]*' "$status" | cut -d' ' -f2 | tr '\n' ' ')"
    return 1
  fi
  primary="$(awk '$2 == "VALIDSIG" { print $NF }' "$status")"
  if [[ "$primary" != "$SIGNING_FPR" ]]; then
    REPO_WHY="InRelease is signed under the key $primary, not Google's $SIGNING_FPR"
    return 1
  fi
  REPO_SIGNER="$(awk '$2 == "VALIDSIG" { print $3 }' "$status")"
  [[ "$(sed -n 's/^Suite: //p' "$work/Release" | head -n 1)" == stable ]] || { REPO_WHY="InRelease is not of the stable suite"; return 1; }
  REPO_DATE="$(sed -n 's/^Date: //p' "$work/Release" | head -n 1)"
  entry="$(awk -v want="main/binary-$ARCH/Packages" '/^SHA256:/ { inside = 1; next } /^[^ ]/ { inside = 0 } inside && $3 == want { print $1, $2 }' "$work/Release")"
  [[ "$entry" =~ ^([0-9a-f]{64})\ ([0-9]+)$ ]] || { REPO_WHY="InRelease names no SHA-256 of main/binary-$ARCH/Packages"; return 1; }
  local packages_sha="${BASH_REMATCH[1]}" packages_size="${BASH_REMATCH[2]}"
  if ! curl -fsS --proto '=https' --max-time 120 --retry 2 -o "$work/Packages" "$REPO_URL/dists/stable/main/binary-$ARCH/Packages" 2>"$work/curl.err"; then
    REPO_WHY="Packages could not be fetched: $(scrub <"$work/curl.err")"
    return 1
  fi
  if [[ "$(sha256_of "$work/Packages")" != "$packages_sha" || "$(wc -c <"$work/Packages" | tr -d ' ')" != "$packages_size" ]]; then
    REPO_WHY="Packages does not match its SHA-256 in InRelease"
    return 1
  fi
  local line
  line="$(awk 'BEGIN { RS = ""; FS = "\n" }
    { pkg = ""; ver = ""; fn = ""; sz = ""; sha = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^Package: /) pkg = substr($i, 10)
        else if ($i ~ /^Version: /) ver = substr($i, 10)
        else if ($i ~ /^Filename: /) fn = substr($i, 11)
        else if ($i ~ /^Size: /) sz = substr($i, 7)
        else if ($i ~ /^SHA256: /) sha = substr($i, 9)
      }
      if (pkg == "google-chrome-stable") print ver, fn, sz, sha }' "$work/Packages" | head -n 1)"
  read -r REPO_VERSION REPO_FILENAME REPO_SIZE REPO_SHA256 <<<"$line" || true
  if [[ ! "${REPO_VERSION:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ \
    || "${REPO_FILENAME:-}" != "pool/main/g/google-chrome-stable/google-chrome-stable_${REPO_VERSION}_${ARCH}.deb" \
    || ! "${REPO_SIZE:-}" =~ ^[0-9]+$ || ! "${REPO_SHA256:-}" =~ ^[0-9a-f]{64}$ ]]; then
    REPO_WHY="Packages names no well-formed google-chrome-stable for $ARCH"
    return 1
  fi
}

# Downloads REPO_VERSION into the archive, checked against Packages.
fetch_deb() {
  local work="$1" name part
  name="google-chrome-stable_${REPO_VERSION}_${ARCH}.deb"
  install -d -m 755 "$ARCHIVE_DIR"
  if [[ -f "$ARCHIVE_DIR/$name" && -f "$ARCHIVE_DIR/$name.meta" && "$(sha256_of "$ARCHIVE_DIR/$name")" == "$REPO_SHA256" ]]; then
    return 0
  fi
  part="$ARCHIVE_DIR/.$name.part"
  rm -f "$part"
  if ! curl -fsS --proto '=https' --max-time 1800 --retry 2 -o "$part" "$REPO_URL/$REPO_FILENAME" 2>"$work/curl.err"; then
    rm -f "$part"
    REPO_WHY="$name could not be fetched: $(scrub <"$work/curl.err")"
    return 1
  fi
  if [[ "$(wc -c <"$part" | tr -d ' ')" != "$REPO_SIZE" || "$(sha256_of "$part")" != "$REPO_SHA256" ]]; then
    rm -f "$part"
    REPO_WHY="$name does not match its size and SHA-256 in Packages"
    return 1
  fi
  chmod 644 "$part"
  mv -f "$part" "$ARCHIVE_DIR/$name"
  printf 'version=%s\nsha256=%s\nbytes=%s\nrelease_date=%s\nsigner=%s\nfetched_at=%s\nfetched_s=%s\nsource=%s\n' \
    "$REPO_VERSION" "$REPO_SHA256" "$REPO_SIZE" "$REPO_DATE" "$REPO_SIGNER" "$(now_iso)" "$(now_s)" "$REPO_URL" >"$ARCHIVE_DIR/.$name.meta.part"
  mv -f "$ARCHIVE_DIR/.$name.meta.part" "$ARCHIVE_DIR/$name.meta"
  chmod 644 "$ARCHIVE_DIR/$name.meta"
}

# Release tags (hub-page-browser:<Chrome .deb version>-<revision>).
release_images() {
  docker image ls --format '{{.Repository}}:{{.Tag}}' hub-page-browser 2>/dev/null | grep -E "$RELEASE_TAG_RE" || true
}
archived_versions() {
  local file
  for file in "$ARCHIVE_DIR"/google-chrome-stable_*_"$ARCH".deb; do
    [[ -f "$file" && -f "$file.meta" ]] || continue
    value version "$file.meta"
  done
}
# The newest Chrome among the release images and the archive.
newest_known() {
  local newest="" version tag
  while IFS= read -r tag; do
    [[ "$tag" =~ $RELEASE_TAG_RE ]] || continue
    version="${BASH_REMATCH[1]}"
    if [[ -z "$newest" ]] || ver_gt "$version" "$newest"; then newest="$version"; fi
  done < <(release_images)
  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    if [[ -z "$newest" ]] || ver_gt "$version" "$newest"; then newest="$version"; fi
  done < <(archived_versions)
  printf '%s' "$newest"
}

build_image() {
  local version="$1" revision="${2:-}" deb sha tag work
  deb="$ARCHIVE_DIR/google-chrome-stable_${version}_${ARCH}.deb"
  [[ -f "$deb" && -f "$deb.meta" ]] || { BUILD_WHY="no archived $deb"; return 1; }
  sha="$(value sha256 "$deb.meta")"
  [[ "$(sha256_of "$deb")" == "$sha" ]] || { BUILD_WHY="$deb does not match its SHA-256"; return 1; }
  [[ -n "$revision" ]] || revision="$(cat "$CONTEXT_DIR/LATEST" 2>/dev/null || true)"
  [[ "$revision" =~ ^[0-9a-f]{12}$ && -f "$CONTEXT_DIR/$revision.tar" ]] \
    || { BUILD_WHY="no build context kept for revision '${revision}' (deploy-page-browser.sh build keeps the deployed one)"; return 1; }
  tag="hub-page-browser:${version}-${revision}"
  BUILT_TAG="$tag"
  if docker image inspect "$tag" >/dev/null 2>&1; then return 0; fi
  install -d -m 700 "$PB_BASE/build" || return 1
  work="$(mktemp -d "$PB_BASE/build/.work.XXXXXX")" || return 1
  local rc=0
  build_in "$work" "$revision" "$version" "$deb" "$sha" "$tag" || rc=$?
  rm -rf "$work"
  ((rc == 0)) || { BUILD_WHY="the image $tag was not built (${BUILD_WHY:-docker build failed})"; return 1; }
}

# (Called in a condition, where errexit is off: every step checks itself.)
build_in() {
  local work="$1" revision="$2" version="$3" deb="$4" sha="$5" tag="$6" file
  BUILD_WHY=""
  # The archive's own modes (this script's umask is 077: the image's files
  # must stay readable to Chrome's and the operator's users).
  tar -xpf "$CONTEXT_DIR/$revision.tar" -C "$work" && [[ -f "$work/context/Dockerfile" && -f "$work/context/vendor.sha256" ]] \
    || { BUILD_WHY="the build context of $revision does not read"; return 1; }
  mkdir "$work/vendor" && cp "$deb" "$work/vendor/" || return 1
  for file in "$VENDOR_DIR"/kasmvncserver_* "$VENDOR_DIR"/s6-overlay-*; do
    [[ -f "$file" ]] || { BUILD_WHY="no KasmVNC and s6-overlay kept in $VENDOR_DIR"; return 1; }
    cp "$file" "$work/vendor/" || return 1
  done
  # The Chrome the repository's signature vouches for, in place of the one
  # the revision pinned; everything else as the revision has it.
  { grep -v '  google-chrome-stable_' "$work/context/vendor.sha256" || true; printf '%s  %s\n' "$sha" "$(basename "$deb")"; } >"$work/vendor.sha256" \
    && chmod 644 "$work/vendor.sha256" && mv -f "$work/vendor.sha256" "$work/context/vendor.sha256" || return 1
  docker build --build-context vendor="$work/vendor" \
    --build-arg CHROME_VERSION="$version" --build-arg OPERATOR_VERSION="$revision" \
    --label agency-hub.page-browser.revision="$revision" \
    --label agency-hub.page-browser.chrome-version="$version" \
    --label agency-hub.page-browser.chrome-sha256="$sha" \
    --label agency-hub.page-browser.built-by=page-browser-update \
    -t "$tag" "$work/context" >&2
}

cmd_build() {
  local version="" revision=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --chrome) version="${2:-}"; shift 2 ;;
      --revision) revision="${2:-}"; shift 2 ;;
      *) fail "build: unknown option $1" ;;
    esac
  done
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] || fail "--chrome: a .deb version (155.0.8059.79-1)"
  host_arch
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  build_image "$version" "$revision" || fail "$BUILD_WHY"
  say built "$BUILT_TAG"
  printf '%s\n' "$BUILT_TAG"
}

# Images, archived packages and build contexts beyond the newest three —
# never one a page runs, keeps as its previous, or an unfinished update
# names; never a tag that is not a release's.
prune_all() {
  local keep=" " file tag created count=0 version revision
  for file in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$file" ]] || continue
    keep+="$(value PB_IMAGE "$file") $(value PB_PREVIOUS_IMAGE "$file") "
  done
  for file in "$UPDATE_DIR"/pages/*/state; do
    [[ -f "$file" ]] || continue
    terminal "$(value STEP "$file")" && continue
    keep+="$(value FROM_IMAGE "$file") $(value TO_IMAGE "$file") "
  done
  local kept_versions=" " kept_revisions=" "
  while IFS=' ' read -r created tag; do
    [[ -n "$tag" ]] || continue
    count=$((count + 1))
    [[ "$tag" =~ $RELEASE_TAG_RE ]] || continue
    version="${BASH_REMATCH[1]}"
    revision="${BASH_REMATCH[2]}"
    if ((count <= KEEP_IMAGES)) || [[ "$keep" == *" $tag "* ]]; then
      kept_versions+="$version "
      kept_revisions+="$revision "
      continue
    fi
    if docker image rm "$tag" >/dev/null 2>&1; then journal image_pruned "$tag"; else log "warning: $tag could not be removed"; fi
  done < <(release_images | while IFS= read -r tag; do printf '%s %s\n' "$(docker image inspect --format '{{.Created}}' "$tag" 2>/dev/null)" "$tag"; done | sort -r)
  count=0
  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    count=$((count + 1))
    ((count <= KEEP_DEBS)) && continue
    [[ "$kept_versions" == *" $version "* ]] && continue
    rm -f "$ARCHIVE_DIR/google-chrome-stable_${version}_${ARCH}.deb" "$ARCHIVE_DIR/google-chrome-stable_${version}_${ARCH}.deb.meta"
    journal deb_pruned "$version"
  done < <(archived_versions | sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr)
  local latest
  latest="$(cat "$CONTEXT_DIR/LATEST" 2>/dev/null || true)"
  for file in "$CONTEXT_DIR"/*.tar; do
    [[ -f "$file" ]] || continue
    revision="$(basename "$file" .tar)"
    [[ "$revision" == "$latest" || "$kept_revisions" == *" $revision "* ]] && continue
    rm -f "$file"
    journal context_pruned "$revision"
  done
  local dir
  for dir in "$SNAP_DIR"/*/; do
    [[ -d "$dir" ]] && prune_snapshots "$(basename "$dir")"
  done
  return 0
}

cmd_prune() {
  host_arch
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  prune_all
  say pruned "images, packages, build contexts and snapshots beyond the newest $KEEP_IMAGES/$KEEP_DEBS/$KEEP_SNAPSHOTS"
}

# The pages, their images and Chrome, and how their updates stand.
report_pages() {
  local newest="$1" newest_since="$2" alerts="$3" env page image chrome state step lagging=0
  for env in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$env" ]] || continue
    page="$(value PB_PAGE "$env")"
    image="$(value PB_IMAGE "$env")"
    chrome="$(image_chrome "$image" 2>/dev/null || true)"
    state="$UPDATE_DIR/pages/$page/state"
    step="$(value STEP "$state")"
    printf '%-20s %-48s Chrome %-16s update: %s\n' "$page" "$image" "${chrome:-?}" "${step:-none}${step:+ ($(value TO_IMAGE "$state"), $(value UPDATED_AT "$state"))}"
    if [[ -n "$newest" && -n "$chrome" ]] && ver_gt "$newest" "$chrome"; then lagging=$((lagging + 1)); fi
    if [[ "$alerts" == 1 && -n "$step" ]] && ! terminal "$step"; then
      if [[ "$step" == held || "$step" == rollback_failed ]]; then
        PAGE="$page" alert update_waiting "its update stands at $step ($(value REASON "$state")): the owner decides (resume or rollback)"
      elif lock_free; then
        PAGE="$page" alert update_stuck "its update stopped at step $step: page-browser-update.sh resume --page $page"
      fi
    fi
  done
  if [[ "$alerts" == 1 ]] && ((lagging > 0)) && [[ -n "$newest_since" ]] && (( $(now_s) - newest_since > LAG_ALERT_S )); then
    alert pages_behind "$lagging page(s) still run a Chrome older than $newest, out for more than 3 days (plan §4.10)"
  fi
}

cmd_check() {
  local build=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-build) build=0; shift ;;
      *) fail "check: unknown option $1" ;;
    esac
  done
  host_arch
  install -d -m 700 "$UPDATE_DIR"
  local locked=1
  take_lock || { locked=0; build=0; log "an update or build is running: this check only looks"; }
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  local work="$WORK"
  if ! repo_latest "$work"; then
    alert repository "Chrome's repository could not be read or verified: $REPO_WHY"
    exit 1
  fi
  local release_s last_s
  release_s="$(epoch_of_rfc2822 "$REPO_DATE" || true)"
  last_s="$(cat "$UPDATE_DIR/repo-date" 2>/dev/null || true)"
  if [[ "$release_s" =~ ^[0-9]+$ && "$last_s" =~ ^[0-9]+$ ]] && ((release_s < last_s)); then
    alert repository "the repository's InRelease ($REPO_DATE) is older than one seen before: refused (a replayed index hides releases)"
    exit 1
  fi
  [[ "$release_s" =~ ^[0-9]+$ ]] && printf '%s\n' "$release_s" >"$UPDATE_DIR/repo-date"
  local known
  known="$(newest_known)"
  if [[ -n "$known" ]] && ! ver_gt "$REPO_VERSION" "$known"; then
    say checked "Chrome Stable $REPO_VERSION ($REPO_DATE): no newer than the newest here ($known)"
  elif ((locked == 0)); then
    say checked "Chrome Stable $REPO_VERSION is new; an update or build runs: the next check takes it"
  else
    fetch_deb "$work" || { alert fetch "$REPO_WHY"; exit 1; }
    say fetched "google-chrome-stable $REPO_VERSION ($ARCH, SHA-256 ${REPO_SHA256:0:16}…, signed by subkey $REPO_SIGNER, released $REPO_DATE)"
    if ((build == 0)); then
      propose proposed "Chrome $REPO_VERSION is fetched and verified; build it: page-browser-update.sh build --chrome $REPO_VERSION"
    elif ! build_image "$REPO_VERSION"; then
      alert build "Chrome $REPO_VERSION is fetched and verified, but its image was not built: $BUILD_WHY"
    else
      say built "$BUILT_TAG"
      prune_all
      propose proposed "Chrome $REPO_VERSION is out ($REPO_DATE); its image $BUILT_TAG is built. No page is updated by itself (owner decision №15 is open). Next, 06:00–20:00 UTC: page-browser-update.sh update --page <first page> --image $BUILT_TAG --detach (1 h window); then page-browser-update.sh rollout --image $BUILT_TAG --detach"
    fi
  fi
  local newest newest_since meta
  newest="$(newest_known)"
  meta="$ARCHIVE_DIR/google-chrome-stable_${newest}_${ARCH}.deb.meta"
  newest_since="$(value fetched_s "$meta")"
  {
    printf 'checked %s: Chrome Stable %s (%s); newest here %s\n' "$(now_iso)" "$REPO_VERSION" "$REPO_DATE" "${newest:-none}"
    report_pages "$newest" "$newest_since" 1
  } > "$UPDATE_DIR/status.part"
  mv -f "$UPDATE_DIR/status.part" "$UPDATE_DIR/status"
  cat "$UPDATE_DIR/status" >&2
  # An alert fails the unit too (systemctl --failed shows it).
  return "$ALERTED"
}

cmd_status() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      *) fail "status: unknown option $1" ;;
    esac
  done
  host_arch
  if [[ -n "$PAGE" ]]; then
    STATE="$UPDATE_DIR/pages/$PAGE/state"
    [[ -f "$STATE" ]] || { echo "no update of $PAGE"; return 0; }
    cat "$STATE"
    return 0
  fi
  echo "pages:"
  report_pages "" "" 0
  echo "images:"
  release_images | sed 's/^/  /'
  echo "archived Chrome ($ARCH):"
  archived_versions | sed 's/^/  /'
  echo "snapshots:"
  local dir
  for dir in "$SNAP_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    printf '  %s: %s\n' "$(basename "$dir")" "$(ls -1 "$dir"/*.meta 2>/dev/null | wc -l | tr -d ' ')"
  done
}

usage() { sed -n '2,/^set -euo pipefail$/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; }

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift
case "$COMMAND" in
  check) cmd_check "$@" ;;
  build) cmd_build "$@" ;;
  update) cmd_update "$@" ;;
  resume) cmd_resume "$@" ;;
  rollback) cmd_rollback "$@" ;;
  rollout) cmd_rollout "$@" ;;
  snapshot) cmd_snapshot "$@" ;;
  status) cmd_status "$@" ;;
  prune) cmd_prune "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
