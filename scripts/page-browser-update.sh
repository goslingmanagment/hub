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
#       An update, rollback or snapshot cut off at any step goes on from it.
#   page-browser-update.sh rollback --page <page> [--reason <text>] [--detach]
#       The page's last update undone: its previous image WITH its snapshot.
#   page-browser-update.sh snapshot --page <page> [--engine hub|none]
#       A standing page's profile now (Chrome down — on its browser, under
#       the owner's stop, answered; the container stopped for it and
#       started again through page.sh): the host's half of `sync browser
#       snapshot`. Its record is written before the stop.
#   page-browser-update.sh status [--page <page>]
#   page-browser-update.sh prune
#
# One page's update (every step journaled; resumable from its state file):
#  1. take out — the page stops serving through the owner's lever, never by
#     killing it: its browser stopped by `sync browser snapshot
#     --if-no-owner-stop` (audited, carried out by the engine that owns the
#     page; refused in its own transaction, nothing changed, while a stop
#     of the owner's stands, or the page is not on its browser with no
#     leave pending — the update holds, the page stays as he has it): the
#     page paused by the stop, the operator's exit closed and Chrome
#     stopped, confirmed only by the operator's answer to that stop once
#     Chrome is down. The page stays on its browser transport (no Node: a
#     page with no Node session is updated too). A page the owner stopped
#     himself (his stop answered), a page on Node, or one with no engine
#     (--engine none: the stand, a page the Hub does not know), must stand
#     already. Either way Chrome must be down in the container, or nothing
#     goes on.
#  2. stop the container: nothing writes the profile any more;
#  3. snapshot the profile volume before the new Chrome first opens it —
#     Chrome upgrades a profile in place and never opens one a newer Chrome
#     wrote (stage 1): snapshots/<profile>/, its SHA-256 and Chrome version
#     beside it, the newest three kept;
#  4. the page on the new image (page.sh up: healthy, or the old one back);
#  5. host checks, exit closed: the new Chrome opens the profile and its
#     policy installs the image's rules extension (profile-check.mjs in the
#     container), and the profile now names the new Chrome;
#  6. give back — `sync browser start --if-no-halt --if-stop <its stop>`:
#     the update's stop and its pause lifted — only while the stop in force
#     is the update's own (a stop or start of the owner's since stays his:
#     the update holds) — the browser started by the engine (plan §4.1)
#     under the guard of every start, never clearing a halt held for the
#     owner's decision;
#  7. engine checks, read from the engine's record of the operator's state
#     (page_browsers): ready on the new Chrome — the self-test passed (the
#     extension's rules among its mechanisms), the environment verified, the
#     exit IP the pinned one, the site loaded, the session confirmed by the
#     engine's identity read: the same account and session fingerprint as
#     before, no new login;
#  8. the window (first page): ready all along, then `sync check live-hour`.
# Any failure before the new image ran puts the page back as it was (its
# old container, its transport); after it, a rollback — reading the page as
# it is then, never the update's old hand-over: its own confirmed stop of a
# browser that serves (unless Hub shows it stopped now), no container
# stopped under a running Chrome, a start only of a stop it made —: the page out again,
# the snapshot restored, the old image, the same checks — never the old
# Chrome on a profile the new one wrote: every container start goes through
# page.sh's start_state, which refuses it.
#
# Rules everything here keeps:
# - One guard (guard_quiet) right before every deed on the page's container
#   or profile — its stop, the profile's pack and restore, a start on any
#   image — on every path (update, resume, rollback, abort, snapshot): the
#   stop the operation took the page out under is the one in force,
#   answered ok, and Chrome is down in the container (Docker's state and
#   Chrome's own). Otherwise the operation holds for the owner, nothing
#   touched: a browser the owner started or stopped since is his.
# - What cannot be read is unknown, and unknown is never "stopped",
#   "nobody" or "failed": a state Docker or the Hub cannot tell stops the
#   step (nothing destructive happens on it), or holds the update for the
#   owner; only a confirmed outcome ends an operation.
# - A profile is packed or restored only under page.sh's lock, when page.sh
#   gives it to this page alone and no running container mounts it.
# - Each operation's record is written before its destructive step, so a
#   cut-off one is resumed, and the timer reports it.
#
# A halt the operator holds for the owner's decision (on its buffer volume,
# PR 17) — or Hub's mirror of one — is never the update's to clear or to
# pass: a halted page is not updated, a halt that comes during the update
# holds it for the owner, and the update's start never names one. Neither
# image may be one whose operator the engine refuses (protocol before 1.1).
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
# The operator protocol the engine works with (PR 17: it refuses a minor
# before 1 at the hello).
OPERATOR_MAJOR=1
OPERATOR_MIN_MINOR=1
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
TERMINAL_STEPS=" done aborted rolled_back failed "

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ORIGINAL_ARGS=("$@")
LOCK_HELD=0
ALERTED=0
C_STATE="" C_IMAGE="" C_HEALTH="" STATE_WHY="" OWN_WHY="" OP_WHY="" RB_WHY="" SNAP_NAME=""
WORK=""
CHECK_DETAIL="" LEAVE_WHY="" ENGINE_WHY="" REPO_WHY="" BUILD_WHY="" BUILT_TAG=""
PROFILE_CHROME="" PROFILE_BYTES=0
REPO_VERSION="" REPO_FILENAME="" REPO_SIZE="" REPO_SHA256="" REPO_DATE="" REPO_SIGNER=""
H_TRANSPORT="" H_LEAVE="" H_GENERATION="" H_PROFILE="" H_STEP="" H_STOP=""
H_PAUSED="" H_STOP_PAUSED="" H_OWNER_STOP="" H_HALT_REASON="" H_HALT_ID=""
CMD_ID="" CMD_OUTCOME="" CMD_EXPIRED="" CMD_DETAIL="" CMD_WHY="" OP_HALT="" PROTO="" PROTO_WHY="" HUB_OUT=""
STOP_SET="" STOP_ID="" STOP_OUTCOME="" STOP_OURS=""
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
# An image's commit ("" when it has no label); 1 when it cannot be read.
image_revision() {
  local revision
  revision="$(image_label "$1" agency-hub.page-browser.revision)" || return 1
  [[ "$revision" =~ ^[0-9a-f]{7,40}$ ]] && printf '%s' "$revision" || true
}

# ── a page's files ────────────────────────────────────────────────────────

value() {
  [[ -f "$2" ]] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}
page_env() { printf '%s/pages/%s/page.env' "$PB_BASE" "$1"; }
container_of() { printf 'page-browser-%s' "$1"; }

# The page's container, read and never guessed — one rule for every state
# this script reads: what cannot be read is unknown, and unknown is never
# "stopped" or "nobody". C_STATE running|stopped|absent, C_IMAGE, C_HEALTH;
# 1 (STATE_WHY) when Docker cannot say.
container_read() {
  local out rc=0
  C_STATE=unknown C_IMAGE="" C_HEALTH="" STATE_WHY=""
  out="$(docker inspect -f '{{.State.Running}} {{.Config.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(container_of "$1")" 2>&1)" || rc=$?
  if ((rc != 0)); then
    if grep -qiE 'no such (object|container)' <<<"$out"; then
      C_STATE=absent
      return 0
    fi
    STATE_WHY="$(container_of "$1") cannot be read: $(printf '%s' "$out" | scrub)"
    return 1
  fi
  if [[ ! "$out" =~ ^(true|false)\ ([^ ]+)\ ([a-z]+)$ ]]; then
    STATE_WHY="$(container_of "$1") reads '$(printf '%s' "$out" | scrub)'"
    return 1
  fi
  C_IMAGE="${BASH_REMATCH[2]}"
  C_HEALTH="${BASH_REMATCH[3]}"
  [[ "${BASH_REMATCH[1]}" == true ]] && C_STATE=running || C_STATE=stopped
}

# The containers that mount a profile's volume, "<name> <state>" a line; 1
# when Docker cannot list them.
profile_users() {
  docker ps -a --filter "volume=pb-profile-$1" --format '{{.Names}} {{.State}}'
}

# The profile is this page's (call it under page.sh's lock, which `up
# --profile` takes to give a profile to a page): its page.env names it, no
# other page's does, and no other container mounts its volume. 1 (OWN_WHY)
# otherwise, or when any of it cannot be read.
profile_owned() {
  local page="$1" profile="$2" file users
  OWN_WHY=""
  if [[ "$(value PB_PROFILE_ID "$(page_env "$page")")" != "$profile" ]]; then
    OWN_WHY="$page's profile is now '$(value PB_PROFILE_ID "$(page_env "$page")")', not $profile"
    return 1
  fi
  for file in "$PB_BASE"/pages/*/page.env "$PB_BASE"/pages/*/page.env.next; do
    [[ -f "$file" && "$file" != "$(page_env "$page")" ]] || continue
    if [[ "$(value PB_PROFILE_ID "$file")" == "$profile" ]]; then
      OWN_WHY="profile $profile is named by $file too"
      return 1
    fi
  done
  if ! users="$(profile_users "$profile")"; then
    OWN_WHY="the containers of pb-profile-$profile cannot be listed"
    return 1
  fi
  if grep -v "^$(container_of "$page") " <<<"$users" | grep -q .; then
    OWN_WHY="pb-profile-$profile is mounted by $(grep -v "^$(container_of "$page") " <<<"$users" | head -n 1)"
    return 1
  fi
}

# Nothing runs on the profile: the page's container stopped or gone, and no
# running container mounts its volume. 1 (STATE_WHY) otherwise, or unknown.
profile_quiet() {
  local page="$1" profile="$2" users
  container_read "$page" || return 1
  if [[ "$C_STATE" == running ]]; then
    STATE_WHY="$(container_of "$page") runs"
    return 1
  fi
  if ! users="$(profile_users "$profile")"; then
    STATE_WHY="the containers of pb-profile-$profile cannot be listed"
    return 1
  fi
  if grep -q ' running$' <<<"$users"; then
    STATE_WHY="pb-profile-$profile is in use by $(grep ' running$' <<<"$users" | head -n 1 | cut -d' ' -f1)"
    return 1
  fi
}

# page.sh's own lock ($PB_BASE/.page.lock): a profile cannot change hands
# while it is held. Never held across a call of page.sh.
page_lock() {
  exec 7>"$PB_BASE/.page.lock"
  flock -w 900 7
}
page_unlock() { exec 7>&-; }

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

# The newest three of a profile, and every one a page's update may still
# need: an unfinished update's, and a done one's — the page's way back, until
# its next update replaces it.
prune_snapshots() {
  local profile="$1" dir="$SNAP_DIR/$1" keep=" " meta name count=0 file step
  [[ -d "$dir" ]] || return 0
  for file in "$UPDATE_DIR"/pages/*/state; do
    [[ -f "$file" ]] || continue
    [[ "$(value PROFILE "$file")" == "$profile" ]] || continue
    step="$(value STEP "$file")"
    terminal "$step" && [[ "$step" != done ]] && continue
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
  local page="$1" image="$2" chrome="$3" profile="$4"
  if ! container_read "$page"; then
    CHECK_DETAIL="$STATE_WHY"
    return 1
  fi
  if [[ "$C_STATE $C_IMAGE $C_HEALTH" != "running $image healthy" ]]; then
    CHECK_DETAIL="the container is not running healthy on $image ($C_STATE ${C_IMAGE} ${C_HEALTH})"
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

# The page as the Hub knows it (H_*): its transport and a pending leave of
# its browser, its owner generation, the operator's last state as the
# engine recorded it (page_browsers), its pause (and whether it is the
# owner's browser stop's), the owner's stop, and Hub's mirror of a halt the
# operator holds for the owner's decision.
# Instants in milliseconds, on the database's clock.
hub_read() {
  local row
  row="$(hub_compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -AtqX -F "|"' <<SQL
-- pb-update:page $PAGE
BEGIN READ ONLY;
SELECT sp.transport,
       coalesce(sp.browser_leave_generation::text, ''),
       sp.owner_generation::text,
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
       (extract(epoch from clock_timestamp()) * 1000)::bigint::text,
       sp.paused_all::text,
       sp.browser_stop_paused::text,
       (pb.owner_stop_at IS NOT NULL)::text,
       coalesce(pb.halt_reason, ''),
       coalesce(pb.halt_id, '')
  FROM sync_pages sp
  JOIN pages p ON p.id = sp.page_id
  LEFT JOIN page_browsers pb ON pb.page_id = sp.page_id
 WHERE p.label = '$PAGE';
COMMIT;
SQL
)" || return 1
  row="$(sed -n '1p' <<<"$row")"
  [[ -n "$row" ]] || return 3
  IFS='|' read -r H_TRANSPORT H_LEAVE H_GENERATION H_PROFILE H_STEP H_STOP H_EXIT_OPEN \
    H_FINGERPRINT H_ACCOUNT H_EXIT_IP H_PINNED H_CHROME H_OPERATOR H_SELFTEST_OK H_SELFTEST_AT H_SELFTEST_FAILED H_STATE_AT H_NOW \
    H_PAUSED H_STOP_PAUSED H_OWNER_STOP H_HALT_REASON H_HALT_ID <<<"$row"
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

# A lever's note: the run and the lever's tag first — its command is found
# again by them (hub_command).
note_of() { printf 'page-browser-update %s %s: Chrome %s -> %s (%s)' "$RUN" "$1" "$(sget FROM_CHROME)" "$(sget TO_CHROME)" "$2"; }

# The forward steps failed: before the new image ran, the page goes back
# as it was; after, a rollback.
forward_failed() {
  sset "REASON=$1"
  alert update_failed "$1"
  if [[ "$(sget NEW_RAN)" == 1 ]]; then step_to rolling_back; else step_to aborting; fi
}

# The update stops where it is (resumable): the owner moved the page, or
# what it must judge cannot be read — never judged blind.
hold() {
  sset "HELD_FROM=$(sget STEP)" "HELD_WHY=$1"
  alert update_held "$1 — the update holds: page-browser-update.sh resume|rollback --page $PAGE"
  step_to held
}

# ── the hand-over: the page out of service on its browser, and back ──────
#
# The only place that knows HOW a page leaves service on its browser and
# returns to it: PR 17's levers of the owner, audited, carried out by the
# engine that owns the page over its link. The page stays on its browser
# transport throughout — no Node, so a page with no Node session is updated
# too:
# - out: `sync browser snapshot --if-no-owner-stop` — the update's own stop
#   of the browser and the pause it puts on the page, never asked over
#   another's stop nor of a page its owner moved off its browser (the page
#   read as it is now; refused in the transaction that would record it,
#   nothing changed); confirmed only by the operator's answer to that very
#   stopPage, which comes once Chrome is down;
# - back: `sync browser start --if-no-halt` — that stop and its pause
#   lifted, a start under the guard of every start, which never clears a
#   halt held for the owner's decision (refused, nothing changed, while
#   Hub mirrors one);
# - forced: none — a page whose operator does not confirm is never killed:
#   the update holds for the owner.
# Each lever's command is found again by its note (`page-browser-update
# <run> <tag>:`), so a resume knows what the run asked and how it ended.

# The run's last owner command of <kind> for <tag> ("*": any tag): CMD_ID
# ("" none), CMD_OUTCOME (ok|failed|expired|unknown, "" not ended),
# CMD_EXPIRED (true: past its expiry), CMD_DETAIL. 1: the Hub cannot be read.
hub_command() {
  local kind="$1" tag="$2" marker row
  marker="page-browser-update $RUN "
  [[ "$tag" == "*" ]] || marker+="$tag:"
  CMD_ID="" CMD_OUTCOME="" CMD_EXPIRED="" CMD_DETAIL=""
  row="$(hub_compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -AtqX -F "|"' <<SQL
-- pb-update:command $PAGE $kind
BEGIN READ ONLY;
SELECT c.id::text,
       coalesce(c.outcome, ''),
       (c.expires_at <= clock_timestamp())::text,
       coalesce(replace(replace(replace(c.detail, E'\n', ' '), E'\r', ' '), '|', '/'), '')
  FROM page_browser_commands c
  JOIN pages p ON p.id = c.page_id
 WHERE p.label = '$PAGE' AND c.kind = '$kind' AND c.note LIKE '$marker%'
 ORDER BY c.id DESC
 LIMIT 1;
COMMIT;
SQL
)" || return 1
  row="$(sed -n '1p' <<<"$row")"
  [[ -n "$row" ]] || return 0
  IFS='|' read -r CMD_ID CMD_OUTCOME CMD_EXPIRED CMD_DETAIL <<<"$row"
  [[ "$CMD_ID" =~ ^[0-9]+$ ]] || return 1
}

# The stop in force on the page's browser now: STOP_SET (the owner's stop
# stands), the page's latest stop command — STOP_ID, STOP_OUTCOME — and
# STOP_OURS (it is this run's); and where the page is: STOP_TRANSPORT, and
# STOP_LEAVE, a pending leave of its browser ("" none). 1: the Hub cannot be
# read.
hub_stop_now() {
  local row
  STOP_SET="" STOP_ID="" STOP_OUTCOME="" STOP_OURS="" STOP_TRANSPORT="" STOP_LEAVE=""
  row="$(hub_compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -AtqX -F "|"' <<SQL
-- pb-update:stop $PAGE
BEGIN READ ONLY;
SELECT (pb.owner_stop_at IS NOT NULL)::text,
       coalesce(c.id::text, ''),
       coalesce(c.outcome, ''),
       coalesce((c.note LIKE 'page-browser-update $RUN %')::text, 'false'),
       sp.transport,
       coalesce(sp.browser_leave_generation::text, '')
  FROM pages p
  JOIN page_browsers pb ON pb.page_id = p.id
  JOIN sync_pages sp ON sp.page_id = p.id
  LEFT JOIN LATERAL (
    SELECT id, outcome, note FROM page_browser_commands
     WHERE page_id = p.id AND kind = 'stopPage'
     ORDER BY id DESC LIMIT 1
  ) c ON true
 WHERE p.label = '$PAGE';
COMMIT;
SQL
)" || return 1
  row="$(sed -n '1p' <<<"$row")"
  [[ -n "$row" ]] || return 1
  IFS='|' read -r STOP_SET STOP_ID STOP_OUTCOME STOP_OURS STOP_TRANSPORT STOP_LEAVE <<<"$row"
  [[ "$STOP_SET" == true || "$STOP_SET" == false ]] || return 1
  [[ "$STOP_TRANSPORT" == node || "$STOP_TRANSPORT" == browser ]] || return 1
}

# The page is not on its browser now (STOP_*, read by hub_stop_now): its
# owner moved it — the update asks no stop of it, whatever its state file
# says. 0 (CMD_WHY) when so.
off_browser() {
  [[ "$STOP_TRANSPORT" == browser && -z "$STOP_LEAVE" ]] && return 1
  CMD_WHY="the page is not on its browser now (transport $STOP_TRANSPORT${STOP_LEAVE:+, a leave of it pending since generation $STOP_LEAVE}): its owner moved it — the update asks no stop of it"
}

# Waits for the run's <kind> command of <tag> to end. 0 ok; 1 the operator
# (or the engine) said no; 3 not known — expired (nobody took it), unknown
# (sent, no answer), not ended within the deadline, or the Hub unreadable
# (CMD_WHY says).
await_command() {
  local kind="$1" tag="$2" deadline=$(( $(now_s) + LEAVE_WAIT_S )) read_ok
  while :; do
    read_ok=0
    if hub_command "$kind" "$tag"; then
      read_ok=1
      if [[ -z "$CMD_ID" ]]; then
        CMD_WHY="no $kind of this update is recorded"
        return 3
      fi
      case "$CMD_OUTCOME" in
        ok) return 0 ;;
        failed) CMD_WHY="its $kind was refused: $(printf '%s' "${CMD_DETAIL:-no detail}" | scrub)"; return 1 ;;
        expired) CMD_WHY="its $kind expired: nobody took it (no engine runs the page?)"; return 3 ;;
        unknown) CMD_WHY="its $kind was sent and not answered"; return 3 ;;
      esac
      if [[ "$CMD_EXPIRED" == true ]]; then
        CMD_WHY="its $kind is past its expiry, not ended"
        return 3
      fi
    fi
    if (( $(now_s) >= deadline )); then
      if ((read_ok == 1)); then CMD_WHY="its $kind did not end within ${LEAVE_WAIT_S} s"; else CMD_WHY="the Hub cannot be read"; fi
      return 3
    fi
    sleep "$POLL_S"
  done
}

# A PR 17 lever of the Hub's CLI, its own outcome read from its command row
# afterwards (a lever that waits and gives up exits non-zero: no refusal).
hub_ask() {
  local out rc=0
  out="$(hub_compose exec -T api node apps/runtime/dist/cli.js "$@" </dev/null 2>&1)" || rc=$?
  [[ -z "$out" ]] || printf '%s\n' "$out" >&2
  HUB_OUT="$(printf '%s' "$out" | tail -n 1 | scrub)"
  journal hub_lever "$1 $2 $3 → exit $rc"
  return "$rc"
}

# The page's browser out of service. 0 the operator confirmed its stop
# (Chrome down; the page paused by it), CMD_ID its command; 1 refused; 3
# not known; 4 the owner's — a stop of his stands, never asked over (the
# update's own stop would then be the latest, and its start could lift
# his), or he moved the page off its browser (never paused by the update)
# (CMD_WHY). The page is read as it is now, never as the update's state
# file had it; the read is only a first look: the lever's
# `--if-no-owner-stop` refuses in the very transaction that would record
# the stop, nothing changed, if by then an owner's stop stands or the page
# is not on its browser with no leave pending.
handover_out() {
  local tag="$1" text="$2" before=""
  hub_stop_now || { CMD_WHY="the Hub cannot be read"; return 3; }
  off_browser && return 4
  if [[ "$STOP_SET" == true && "$STOP_OURS" != true ]]; then
    CMD_WHY="the owner's stop stands on the page's browser (stop command ${STOP_ID:-unknown}): it stays his"
    return 4
  fi
  # A stop this run asked before (a resume): its own outcome first — while
  # it is the stop in force (a start since, the owner's, lifted it).
  if [[ "$(sget "STOP_$tag")" == 1 ]]; then
    hub_command stopPage "$tag" || { CMD_WHY="the Hub cannot be read"; return 3; }
    before="$CMD_ID"
    if [[ -n "$CMD_ID" && "$STOP_SET" == true && "$STOP_ID" == "$CMD_ID" ]]; then
      [[ "$CMD_OUTCOME" == ok ]] && return 0
      if [[ -z "$CMD_OUTCOME" && "$CMD_EXPIRED" != true ]]; then
        await_command stopPage "$tag"
        return
      fi
    fi
    # Refused, expired, unknown or lifted since: asked again (the owner resumed it).
  fi
  # Recorded before the lever: whatever happens next, the run knows it asked.
  sset "STOP_$tag=1"
  # Never over another's stop: the run's own in force (asked again) is named.
  local -a only=(--if-no-owner-stop)
  [[ "$STOP_SET" == true && "$STOP_OURS" == true ]] && only+=("$STOP_ID")
  if ! hub_ask sync browser snapshot "$PAGE" "${only[@]}" --note "$(note_of "$tag" "$text")" --wait-ms "$(( LEAVE_WAIT_S * 1000 ))"; then
    # Refused with nothing recorded (its stop, pause and command commit
    # together): nothing changed.
    hub_command stopPage "$tag" || { CMD_WHY="the Hub cannot be read"; return 3; }
    if [[ "$CMD_ID" == "$before" ]]; then
      hub_stop_now || { CMD_WHY="the Hub cannot be read"; return 3; }
      if off_browser; then
        CMD_WHY="$CMD_WHY (moved meanwhile): the update's stop was refused, nothing changed"
        return 4
      fi
      if [[ "$STOP_SET" == true && "$STOP_OURS" != true ]]; then
        CMD_WHY="the owner's stop stands on the page's browser (stop command ${STOP_ID:-unknown}, asked meanwhile): the update's stop was refused, nothing changed — it stays his"
        return 4
      fi
      CMD_WHY="the stop was refused, nothing changed: ${HUB_OUT:-no word from the Hub}"
      return 1
    fi
  fi
  await_command stopPage "$tag"
}

# The page's browser back in service — never past a halt held for the
# owner's decision (Hub's mirror: the lever refuses on it in the same
# transaction; or the operator's own on its volume), and lifting only the
# stop this run made: the lever's `--if-stop` names this run's latest stop
# command, and refuses, nothing changed, if the stop in force is another's
# (the owner stopped or started the page since). <key>: the instant before
# the lever (the database's clock): the engine's checks count only what the
# operator said after it; a start asked before (a resume) keeps its instant.
# 0 the start went; 2 not started — a halt, a stop not the run's, refused
# (CMD_WHY); 3 not known (CMD_WHY).
handover_back() {
  local key="$1" tag="$2" text="$3"
  hub_read || { CMD_WHY="the Hub cannot be read"; return 3; }
  if [[ -n "$H_HALT_REASON" ]]; then
    CMD_WHY="its browser stands for the owner's decision ($H_HALT_REASON${H_HALT_ID:+, halt $H_HALT_ID})"
    return 2
  fi
  if ! operator_halt "$(sget PROFILE)" "$(container_image_or "$(sget FROM_IMAGE)")"; then
    CMD_WHY="the halt its operator may hold on its volume cannot be read"
    return 3
  fi
  if [[ -n "$OP_HALT" ]]; then
    CMD_WHY="its operator holds a halt for the owner's decision ($OP_HALT)"
    return 2
  fi
  local stop_id
  hub_command stopPage "*" || { CMD_WHY="the Hub cannot be read"; return 3; }
  stop_id="$CMD_ID"
  if [[ -z "$stop_id" ]]; then
    CMD_WHY="this update stopped nothing to start again"
    return 2
  fi
  if [[ "$(sget "START_$tag")" == 1 ]]; then
    hub_command restartBrowser "$tag" || { CMD_WHY="the Hub cannot be read"; return 3; }
    if [[ -n "$CMD_ID" ]]; then
      [[ "$CMD_OUTCOME" == ok ]] && return 0
      if [[ -z "$CMD_OUTCOME" && "$CMD_EXPIRED" != true ]]; then
        local rc=0
        await_command restartBrowser "$tag" || rc=$?
        ((rc == 1)) && return 2
        return "$rc"
      fi
    fi
  fi
  sset "$key=$H_NOW" "START_$tag=1"
  if ! hub_ask sync browser start "$PAGE" --if-no-halt --if-stop "$stop_id" --note "$(note_of "$tag" "$text")" --wait-ms "$(( LEAVE_WAIT_S * 1000 ))"; then
    hub_command restartBrowser "$tag" || { CMD_WHY="the Hub cannot be read"; return 3; }
    if [[ -z "$CMD_ID" ]]; then
      CMD_WHY="the start was refused, nothing changed: ${HUB_OUT:-no word from the Hub}"
      return 2
    fi
  fi
  local rc=0
  await_command restartBrowser "$tag" || rc=$?
  ((rc == 1)) && return 2
  return "$rc"
}

# A page whose operator does not confirm its stop has no forced way out: it
# is never killed. The update holds for the owner — the operator answers
# and he resumes, or he takes the page off its browser himself
# (deploy-page-browser.sh to-node).
handover_forced() {
  hold "$1: $CMD_WHY — a page is never killed: once its operator answers, resume; or take it off its browser (deploy-page-browser.sh to-node)"
}

# ── the guard of every deed on the page's container or profile ───────────
#
# Called right before each deed that touches the page's container or its
# profile — the container stopped; the profile packed or restored; the
# container started (on the new image, on its previous one, or as it was)
# — on every path: the update, its resume, its rollback and its abort, and
# a standalone snapshot. The page must be quiet under the stop the
# operation took it out under, <relied>:
# - Docker: the container is read; while it runs, Chrome in it is down
#   (s6 and Chrome's processes);
# - the Hub (a page its engine runs; one read-only transaction): on its
#   browser, the stop in force is <relied> — the operation's own stop
#   command, or the owner's it took the page out under and never lifts —
#   and the operator answered it ok, which it does once Chrome is down. A
#   start since (the owner's) lifts it; a newer stop is another's. A page
#   on Node (<relied> none) must still be on Node.
# 1 (GUARD_WHY) otherwise, or when any of it cannot be read: the caller
# holds for the owner, nothing touched. C_STATE: the container as read.
guard_quiet() {
  local relied="$1" row transport stop_set stop_id stop_outcome
  GUARD_WHY=""
  if ! container_read "$PAGE"; then
    GUARD_WHY="$STATE_WHY"
    return 1
  fi
  if [[ "$C_STATE" == running ]]; then
    local chrome
    chrome="$(chrome_state "$PAGE")"
    if [[ "$chrome" != down ]]; then
      GUARD_WHY="Chrome is $chrome in $(container_of "$PAGE")"
      return 1
    fi
  fi
  [[ "$(sget ENGINE)" == hub ]] || return 0
  row="$(hub_compose exec -T postgres sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -AtqX -F "|"' <<SQL
-- pb-update:guard $PAGE
BEGIN READ ONLY;
SELECT sp.transport,
       (pb.owner_stop_at IS NOT NULL)::text,
       coalesce(c.id::text, ''),
       coalesce(c.outcome, '')
  FROM sync_pages sp
  JOIN pages p ON p.id = sp.page_id
  LEFT JOIN page_browsers pb ON pb.page_id = sp.page_id
  LEFT JOIN LATERAL (
    SELECT id, outcome FROM page_browser_commands
     WHERE page_id = p.id AND kind = 'stopPage'
     ORDER BY id DESC LIMIT 1
  ) c ON true
 WHERE p.label = '$PAGE';
COMMIT;
SQL
)" || { GUARD_WHY="the Hub cannot be read"; return 1; }
  IFS='|' read -r transport stop_set stop_id stop_outcome <<<"$(sed -n '1p' <<<"$row")"
  case "$transport" in
    node)
      if [[ -n "$relied" ]]; then
        GUARD_WHY="the page is on Node now, no longer under stop command $relied"
        return 1
      fi
      return 0
      ;;
    browser) ;;
    *)
      GUARD_WHY="the Hub knows the page's transport as '${transport}'"
      return 1
      ;;
  esac
  if [[ -z "$relied" ]]; then
    GUARD_WHY="the page is on its browser now, and no stop it was taken out under holds it"
  elif [[ "$stop_set" != true ]]; then
    GUARD_WHY="no stop is in force on the page's browser: it was started since stop command $relied"
  elif [[ "$stop_id" != "$relied" ]]; then
    GUARD_WHY="the stop in force is command ${stop_id:-unknown}, not $relied it was taken out under"
  elif [[ "$stop_outcome" != ok ]]; then
    GUARD_WHY="stop command $relied is ${stop_outcome:-not answered}: its operator has not said Chrome is down"
  else
    return 0
  fi
  return 1
}

# The image a page's container runs now, else <fallback>.
container_image_or() {
  if container_read "$PAGE" && [[ -n "$C_IMAGE" ]]; then printf '%s' "$C_IMAGE"; else printf '%s' "$1"; fi
}

# The halt the page's operator holds on its buffer volume, read by the
# image's own operator code (src/state/halt-store.ts), the volume mounted
# read-only (a missing file stays missing: no halt): OP_HALT "<reason> <id>"
# or "". 1 when it cannot be read — never taken for "no halt".
operator_halt() {
  local profile="$1" image="$2" out
  OP_HALT=""
  out="$(docker run --rm --network none --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges --user 0 \
    --entrypoint node -v "pb-buffer-$profile:/data/buffer:ro" "$image" --no-warnings --input-type=module -e "$HALT_JS" pb-halt 2>/dev/null)" || return 1
  [[ "$out" =~ ^halt=([a-z_]*( [0-9a-f-]{36})?)$ ]] || return 1
  OP_HALT="${BASH_REMATCH[1]}"
}
# shellcheck disable=SC2016
HALT_JS='const { HaltStore } = await import("/opt/page-browser/src/state/halt-store.ts");
const held = new HaltStore("/data/buffer/operator/halt.json").read();
console.log("halt=" + (held.halt === null ? "" : `${held.halt.reason} ${held.halt.id}`));'

# The protocol an image's operator speaks: its label, else its own source.
# PROTO "<major>.<minor>"; 1 when it cannot be read.
image_protocol() {
  local label out
  PROTO=""
  label="$(image_label "$1" agency-hub.page-browser.protocol)" || return 1
  if [[ "$label" =~ ^[0-9]+\.[0-9]+$ ]]; then
    PROTO="$label"
    return 0
  fi
  out="$(docker run --rm --network none --entrypoint sh "$1" -c 'grep -o "PROTOCOL = { major: [0-9]*, minor: [0-9]*" /opt/page-browser/src/rpc/protocol.ts' pb-protocol 2>/dev/null)" || return 1
  [[ "$out" =~ major:\ ([0-9]+),\ minor:\ ([0-9]+) ]] || return 1
  PROTO="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
}

# The engine refuses an operator before protocol 1.1 (it holds no halt for
# the owner on its volume, PR 17): no page goes to such an image, and no
# update starts whose way back is one. 1 (PROTO_WHY) when <image> is one,
# or its protocol cannot be read.
protocol_ok() {
  PROTO_WHY=""
  if ! image_protocol "$1"; then
    PROTO_WHY="the protocol of $1's operator cannot be read"
    return 1
  fi
  local major="${PROTO%%.*}" minor="${PROTO#*.}"
  if ((10#$major != OPERATOR_MAJOR || 10#$minor < OPERATOR_MIN_MINOR)); then
    PROTO_WHY="$1's operator speaks protocol $PROTO: the engine works with $OPERATOR_MAJOR.$OPERATOR_MIN_MINOR or later of major $OPERATOR_MAJOR"
    return 1
  fi
}

# ── the profile, under page.sh's lock ─────────────────────────────────────

# Under page.sh's lock — a profile cannot change hands meanwhile — the
# profile must be the page's and nothing may run on it, then <op>:
# `snapshot` (SNAP_NAME, PROFILE_CHROME) or `restore <name>`. 1 (OP_WHY)
# when any of it is not so, or cannot be read. (Called in conditions, where
# errexit is off: every step checks itself.)
profile_op() {
  local op="$1" page="$2" profile="$3" image="$4" name="${5:-}" rc=0
  OP_WHY="" SNAP_NAME=""
  if ! page_lock; then
    OP_WHY="page.sh's lock ($PB_BASE/.page.lock) is not had"
    return 1
  fi
  if ! profile_owned "$page" "$profile"; then
    OP_WHY="$OWN_WHY"
    rc=1
  elif ! profile_quiet "$page" "$profile"; then
    OP_WHY="something may run on the profile: $STATE_WHY"
    rc=1
  elif [[ "$op" == snapshot ]]; then
    if ! read_profile "$profile" "$image"; then
      OP_WHY="the profile cannot be read"
      rc=1
    elif ! SNAP_NAME="$(take_snapshot "$profile" "$image" "$PROFILE_CHROME")"; then
      OP_WHY="the profile could not be packed"
      rc=1
    fi
  elif ! profile_helper restore "$profile" "$image" "$SNAP_DIR/$profile" "$name" >&2; then
    OP_WHY="the snapshot could not be restored"
    rc=1
  fi
  page_unlock
  return "$rc"
}

# ── one page's update: the steps ─────────────────────────────────────────

step_take_out() {
  if [[ "$(sget HANDOVER)" == 1 ]]; then
    local rc=0
    handover_out out "the update stops the page's browser" || rc=$?
    case "$rc" in
      0)
        sset "OUT_STOP=$CMD_ID"
        say taken_out "the page's browser stopped (stop command $CMD_ID): its operator confirmed it (Chrome down); the page paused by the stop, still on its browser"
        ;;
      1) forward_failed "the browser's stop: $CMD_WHY"; return ;;
      4) hold "$CMD_WHY: the update holds for him"; return ;;
      *) hold "the browser's stop is not confirmed: $CMD_WHY"; return ;;
    esac
  elif [[ "$(sget ENGINE)" == hub && "$(sget TRANSPORT_BEFORE)" == browser ]]; then
    # The owner's stop holds the page's browser: the update goes on under
    # it — answered, so Chrome is down — and never lifts it.
    if ! hub_stop_now; then
      hold "the Hub cannot be read: whether the owner's stop still holds the page's browser is unknown"
      return
    fi
    if [[ "$STOP_SET" != true || "$STOP_OUTCOME" != ok ]]; then
      hold "the owner's stop does not hold the page's browser now, answered (stop command ${STOP_ID:-none}: ${STOP_OUTCOME:-not answered}, in force: $STOP_SET): the update touches nothing of it"
      return
    fi
    sset "OUT_STOP=$STOP_ID"
  fi
  local chrome
  chrome="$(chrome_state "$PAGE")"
  if [[ "$chrome" != down ]]; then
    forward_failed "Chrome is $chrome in $(container_of "$PAGE"): the update never stops a working page"
    return
  fi
  step_to taken_out
}

# A deed of the update not done: the page is not quiet under the stop it
# was taken out under. Held, nothing touched; `rollback` ends the update
# with the page as it is (its abort, or its rollback, guarded the same way).
guard_held() {
  hold "$1: $GUARD_WHY — the update touches no page that is not quiet under its stop; nothing touched (rollback --page $PAGE ends it)"
}

step_stop() {
  # Recorded before the stop: a failure from here brings the container back.
  sset CONTAINER_STOPPED=1
  if ! guard_quiet "$(sget OUT_STOP)"; then guard_held "the container is not stopped"; return; fi
  if [[ "$C_STATE" == running ]] && ! docker stop -t 25 "$(container_of "$PAGE")" >/dev/null; then
    forward_failed "$(container_of "$PAGE") could not be stopped"
    return
  fi
  if ! container_read "$PAGE"; then forward_failed "$STATE_WHY"; return; fi
  if [[ "$C_STATE" != stopped ]]; then forward_failed "$(container_of "$PAGE") is $C_STATE, not stopped"; return; fi
  step_to stopped
}

step_snapshot() {
  local profile
  profile="$(sget PROFILE)"
  if ! guard_quiet "$(sget OUT_STOP)"; then guard_held "the profile is not packed"; return; fi
  if snapshot_valid "$profile" "$(sget SNAPSHOT)"; then step_to snapshotted; return; fi
  if ! profile_op snapshot "$PAGE" "$profile" "$(sget FROM_IMAGE)"; then
    forward_failed "no snapshot of the profile: $OP_WHY"
    return
  fi
  sset "SNAPSHOT=$SNAP_NAME" "SNAP_CHROME=$PROFILE_CHROME"
  say snapshot "snapshots/$profile/$SNAP_NAME (Chrome ${PROFILE_CHROME:-none})"
  step_to snapshotted
}

step_start_new() {
  local to
  to="$(sget TO_IMAGE)"
  if ! guard_quiet "$(sget OUT_STOP)"; then guard_held "$to is not started"; return; fi
  # Recorded before page.sh: from here the new Chrome may open the profile,
  # and a failure is a rollback.
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

step_give_back() {
  if [[ "$(sget HANDOVER)" != 1 ]]; then
    say engine_checks "skipped: $(sget HANDOVER_WHY); it stands until its engine (or its owner) starts it"
    sset ENGINE_CHECKS=skipped
    step_to engine_checked
    return
  fi
  local rc=0
  handover_back GIVEN_BACK_MS back "the update starts the page's browser on the new image" || rc=$?
  if ((rc != 0)); then
    hold "the browser is not started on the new image: $CMD_WHY"
    return
  fi
  step_to given_back
}

# The engine's record of the page on <chrome> since <ms>: 0 ready, 1 not
# yet, 2 failed (why in ENGINE_WHY), 3 the owner's (off its browser, its
# browser stopped by him, or a halt held for his decision).
judge_engine() {
  local chrome="$1" since="$2" revision="$3"
  ENGINE_WHY=""
  if [[ "$H_TRANSPORT" != browser || -n "$H_LEAVE" ]]; then
    ENGINE_WHY="the page is not on its browser (transport $H_TRANSPORT${H_LEAVE:+, a leave pending})"
    return 3
  fi
  if [[ -n "$H_HALT_REASON" ]]; then
    ENGINE_WHY="its browser stands for the owner's decision ($H_HALT_REASON${H_HALT_ID:+, halt $H_HALT_ID}): the update neither clears it nor decides it"
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
# failed, 3 the owner's doing, 4 the Hub could not be read at the deadline
# (ENGINE_WHY says).
wait_ready() {
  local chrome="$1" since="$2" revision="$3" deadline=$(( $(now_s) + READY_WAIT_S )) rc read_ok
  while :; do
    read_ok=0
    if hub_read; then
      read_ok=1
      rc=0
      judge_engine "$chrome" "$since" "$revision" || rc=$?
      case "$rc" in
        0) return 0 ;;
        2|3) return "$rc" ;;
      esac
    fi
    if (( $(now_s) >= deadline )); then
      if ((read_ok == 0)); then
        ENGINE_WHY="the Hub cannot be read: the page's start is not known"
        return 4
      fi
      ENGINE_WHY="not ready within ${READY_WAIT_S} s (last: ${ENGINE_WHY:-nothing})"
      return 2
    fi
    sleep "$POLL_S"
  done
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
    3|4) hold "$ENGINE_WHY" ;;
    *) forward_failed "engine checks on Chrome $(sget TO_CHROME): $ENGINE_WHY" ;;
  esac
}

step_window() {
  local window until misses=0 blind=0 rc
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
      # Not seen is not failed: the window holds for the owner.
      blind=$((blind + 1))
      if ((blind >= 2)); then hold "the Hub cannot be read: the window cannot judge the page"; return; fi
      continue
    fi
    blind=0
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
    if ((misses >= 2)); then forward_failed "during the window: $ENGINE_WHY"; return; fi
  done
  if ! hub_read; then hold "the Hub cannot be read: the window's end cannot be judged"; return; fi
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

# Before anything of a rollback: the snapshot to restore is whole, and the
# profile is still the page's — never another page's volume restored. 1
# (RB_WHY) when not.
rollback_ready() {
  local profile name rc=0
  profile="$(sget PROFILE)"
  name="$(sget SNAPSHOT)"
  RB_WHY=""
  if ! snapshot_valid "$profile" "$name"; then
    RB_WHY="the snapshot ${name:-(none)} is missing or does not match its SHA-256: Chrome $(sget FROM_CHROME) must not open a profile Chrome $(sget TO_CHROME) wrote"
    return 1
  fi
  if ! protocol_ok "$(sget FROM_IMAGE)"; then
    RB_WHY="$PROTO_WHY: the engine would refuse the page on it"
    return 1
  fi
  if ! page_lock; then
    RB_WHY="page.sh's lock ($PB_BASE/.page.lock) is not had"
    return 1
  fi
  profile_owned "$PAGE" "$profile" || rc=1
  page_unlock
  if ((rc != 0)); then
    RB_WHY="$OWN_WHY: the snapshot of $profile is not for $PAGE's profile now"
    return 1
  fi
}

# The rollback reads the page as it is now — never the update's old
# hand-over: a page on its browser is stopped by the rollback's own lever
# and confirmed, unless Hub shows its browser stopped right now (an owner's
# stop in force whose command the operator answered once Chrome was down).
# The browser is started again afterwards only if the stop in force is this
# run's (RB_START); a stop of the owner's stays his. A page on Node, or with
# no engine, must stand: rb_stop checks Chrome in the container.
rb_take_out() {
  if ! rollback_ready; then rollback_failed "$RB_WHY"; return; fi
  local start=0 relied=""
  if [[ "$(sget ENGINE)" == hub ]]; then
    if ! hub_read; then hold "rollback: the Hub cannot be read: the page's state now is unknown"; return; fi
    if [[ "$H_TRANSPORT" == browser ]]; then
      if ! hub_stop_now; then hold "rollback: the Hub cannot be read: whether the page's browser is stopped now is unknown"; return; fi
      if [[ "$STOP_SET" == true && "$STOP_OUTCOME" == ok ]]; then
        [[ "$STOP_OURS" == true ]] && start=1
        relied="$STOP_ID"
        say rollback "the page's browser is stopped now (stop command $STOP_ID, $( ((start == 1)) && echo "this update's" || echo "the owner's: it stays stopped"))"
      else
        local rc=0
        handover_out rbout "rollback: the update stops the page's browser" || rc=$?
        if ((rc == 4)); then hold "rollback: $CMD_WHY, and its stop is not confirmed: the rollback holds for him"; return; fi
        if ((rc != 0)); then handover_forced "rollback: the browser's stop is not confirmed"; return; fi
        start=1
        relied="$CMD_ID"
      fi
    fi
  fi
  sset "RB_START=$start" "RB_STOP=$relied" RB_STEP=taken_out
}

# A deed of the rollback not done: the page is not quiet under the stop it
# was taken out under. Held, nothing touched; its take-out is to be done
# again — a resume reads the page as it is then (rb_take_out).
rb_guard_held() {
  sset RB_STEP= RB_STOP=
  hold "rollback: $1: $GUARD_WHY — the rollback touches no page that is not quiet under its stop; nothing touched (resume takes the page out again, as it is then)"
}

rb_stop() {
  if ! guard_quiet "$(sget RB_STOP)"; then rb_guard_held "the container is not stopped"; return; fi
  if [[ "$C_STATE" == running ]]; then
    if ! docker stop -t 25 "$(container_of "$PAGE")" >/dev/null; then
      rollback_failed "$(container_of "$PAGE") could not be stopped"
      return
    fi
    if ! container_read "$PAGE" || [[ "$C_STATE" == running ]]; then
      rollback_failed "$(container_of "$PAGE") is not seen stopped (${STATE_WHY:-$C_STATE})"
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
  if ! guard_quiet "$(sget RB_STOP)"; then rb_guard_held "the snapshot is not restored"; return; fi
  if ! snapshot_valid "$profile" "$name"; then
    rollback_failed "the snapshot ${name:-(none)} is missing or does not match its SHA-256: Chrome $(sget FROM_CHROME) must not open a profile Chrome $(sget TO_CHROME) wrote"
    return
  fi
  if ! profile_op restore "$PAGE" "$profile" "$(sget FROM_IMAGE)" "$name"; then
    rollback_failed "no restore: $OP_WHY"
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
  if ! guard_quiet "$(sget RB_STOP)"; then rb_guard_held "$(sget FROM_IMAGE) is not started"; return; fi
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
  if [[ "$(sget RB_START)" == 1 ]]; then
    local rc=0
    handover_back RB_GIVEN_BACK_MS rbback "rollback: the update starts the page's browser on its previous image" || rc=$?
    if ((rc != 0)); then
      hold "rollback: the browser is not started on its previous image: $CMD_WHY"
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
    case "$rc" in
      0) sset RB_CHECKS=passed ;;
      # Unknown never ends the rollback: it holds at this step for the owner.
      3|4) hold "rollback: $ENGINE_WHY"; return ;;
      *)
        sset RB_CHECKS=failed
        alert rollback_checks "back on $(sget FROM_IMAGE) with its snapshot, but its start did not pass: $ENGINE_WHY"
        ;;
    esac
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
  if [[ "$(sget CONTAINER_STOPPED)" == 1 ]]; then
    if ! container_read "$PAGE"; then
      rollback_failed "$STATE_WHY: the page's container is not brought back blind"
      return
    fi
    if [[ "$C_STATE" != running ]]; then
      if ! guard_quiet "$(sget OUT_STOP)"; then
        hold "abort: $(sget FROM_IMAGE) is not started again: $GUARD_WHY — not started blind; nothing touched (once you decide: start it yourself, page.sh up --page $PAGE --image $(sget FROM_IMAGE), and resume)"
        return
      fi
      if ! "$PAGE_SH" up --page "$PAGE" --image "$(sget FROM_IMAGE)" >&2; then
        rollback_failed "page.sh up $(sget FROM_IMAGE) failed: the page's container is not back"
        return
      fi
    fi
  fi
  if [[ "$(sget HANDOVER)" == 1 && "$(sget STOP_out)" == 1 ]]; then
    # The browser started again only if this run's stop was asked at all,
    # and is still the stop in force: one the owner lifted (his start) or
    # replaced (his stop) is his.
    if ! hub_command stopPage out; then hold "abort: the Hub cannot be read: whether the update stopped the browser is unknown"; return; fi
    if [[ -n "$CMD_ID" ]] && ! hub_stop_now; then hold "abort: the Hub cannot be read: whose stop holds the page's browser is unknown"; return; fi
    if [[ -n "$CMD_ID" && ( "$STOP_SET" != true || "$STOP_OURS" != true ) ]]; then
      say abort "the page's browser is the owner's now ($( [[ "$STOP_SET" == true ]] && echo "his stop, command $STOP_ID" || echo "started since")): the abort leaves it so"
    elif [[ -n "$CMD_ID" ]]; then
      local rc=0
      handover_back RB_GIVEN_BACK_MS abortback "abort: the update starts the page's browser again, unchanged" || rc=$?
      if ((rc != 0)); then
        hold "abort: the browser is not started again: $CMD_WHY"
        return
      fi
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
  local env from profile from_chrome to_chrome
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
  ! snapshot_pending "$PAGE" || fail "a snapshot of $PAGE is unfinished: page-browser-update.sh resume --page $PAGE first"
  container_read "$PAGE" || fail "$STATE_WHY"
  [[ "$C_STATE $C_IMAGE $C_HEALTH" == "running $from healthy" ]] || fail "$(container_of "$PAGE") is not running healthy on $from ($C_STATE ${C_IMAGE} ${C_HEALTH})"
  docker image inspect "$image" >/dev/null 2>&1 || fail "no image $image here (page-browser-update.sh build, or deploy-page-browser.sh build)"
  from_chrome="$(image_chrome "$from")" || fail "the Chrome of $from cannot be read"
  to_chrome="$(image_chrome "$image")" || fail "the Chrome of $image cannot be read"
  local from_revision to_revision
  from_revision="$(image_revision "$from")" || fail "$from cannot be read"
  to_revision="$(image_revision "$image")" || fail "$image cannot be read"
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
  # The engine works with neither image's operator, or not with the way back's: no update.
  protocol_ok "$from" || fail "$PROTO_WHY: the update's way back would be an image the engine refuses"
  protocol_ok "$image" || fail "$PROTO_WHY"
  # A halt held for the owner's decision is never the update's to clear or
  # to pass: the page is not updated. Its operator's own, on its volume…
  operator_halt "$profile" "$from" || fail "the halt $PAGE's operator may hold on its volume cannot be read: not updated blind"
  if [[ -n "$OP_HALT" ]]; then
    alert update_refused "its operator holds a halt for the owner's decision ($OP_HALT): not updated — the owner decides it first (sync browser start)"
    exit 2
  fi
  local transport=none generation="" fingerprint="" account="" handover=0 handover_why="no engine of the Hub runs it here (--engine none)"
  if [[ "$engine" == hub ]]; then
    local rc=0
    hub_read || rc=$?
    ((rc == 0)) || { ((rc == 3)) && fail "the Hub knows no page $PAGE (--engine none for a page it does not know)"; fail "the Hub cannot be read"; }
    [[ -z "$H_LEAVE" ]] || fail "$PAGE is leaving its browser already (leave $H_LEAVE pending)"
    # … and Hub's mirror of one.
    if [[ -n "$H_HALT_REASON" ]]; then
      alert update_refused "its browser stands for the owner's decision ($H_HALT_REASON${H_HALT_ID:+, halt $H_HALT_ID}): not updated — the owner decides it first (sync browser start)"
      exit 2
    fi
    transport="$H_TRANSPORT"
    generation="$H_GENERATION"
    if [[ "$transport" == browser ]]; then
      [[ "$H_PROFILE" == "$profile" ]] || fail "the Hub binds profile ${H_PROFILE:-none} to $PAGE, its container has $profile"
      if [[ "$H_OWNER_STOP" == true ]]; then
        # The owner's stop is his: the update leaves the browser stopped.
        handover_why="the owner's stop holds the page's browser (sync browser stop): the update leaves it stopped"
      elif [[ "$H_PAUSED" == true ]]; then
        fail "$PAGE is paused by its owner: its browser's start and its checks need it running — resume it, or stop its browser (sync browser stop) and update it stopped"
      else
        handover=1
        handover_why=""
        fingerprint="$H_FINGERPRINT"
        account="$H_ACCOUNT"
      fi
    else
      handover_why="the page is on Node: its browser stands"
    fi
  fi
  RUN="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  rm -f "$STATE"
  sset "RUN=$RUN" "PAGE=$PAGE" "PROFILE=$profile" "ENGINE=$engine" \
    "FROM_IMAGE=$from" "TO_IMAGE=$image" "FROM_CHROME=$from_chrome" "TO_CHROME=$to_chrome" \
    "FROM_REVISION=$from_revision" "TO_REVISION=$to_revision" \
    "TRANSPORT_BEFORE=$transport" "PLAN_GENERATION=$generation" "FINGERPRINT_BEFORE=$fingerprint" "ACCOUNT_BEFORE=$account" \
    "HANDOVER=$handover" "HANDOVER_WHY=$handover_why" \
    "WINDOW_S=$window" "STARTED_AT=$(now_iso)"
  say planned "Chrome $from_chrome -> $to_chrome: $from -> $image (profile $profile, transport $transport, engine $engine, hand-over $( ((handover == 1)) && echo "by the owner's levers" || echo "none: $handover_why"), window ${window} s)"
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
  local resumed=0 step
  trap on_exit EXIT
  if snapshot_pending "$PAGE"; then
    STATE="$(snapshot_state "$PAGE")"
    RUN="$(sget RUN)"
    say resumed "the snapshot from step $(sget STEP)"
    advance_snapshot || exit 1
    resumed=1
  fi
  STATE="$UPDATE_DIR/pages/$PAGE/state"
  step="$(sget STEP)"
  if [[ ! -f "$STATE" ]] || terminal "$step"; then
    ((resumed == 1)) && exit 0
    fail "nothing of $PAGE to resume${step:+ (its last update ended $step)}"
  fi
  RUN="$(sget RUN)"
  case "$step" in
    held) step_to "$(sget HELD_FROM)" ;;
    rollback_failed) step_to rolling_back ;;
  esac
  say resumed "from step $(sget STEP)${step:+ (was $step)}"
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
  ! snapshot_pending "$PAGE" || fail "a snapshot of $PAGE is unfinished: page-browser-update.sh resume --page $PAGE first"
  STATE="$UPDATE_DIR/pages/$PAGE/state"
  [[ -f "$STATE" ]] || fail "no update of $PAGE to roll back"
  RUN="$(sget RUN)"
  local step
  step="$(sget STEP)"
  # Refused before anything changes: no snapshot to restore, or the profile
  # is not the page's any more.
  local restores=0
  case "$step" in
    done) restores=1 ;;
    aborted|rolled_back|rolling_back|aborting|rollback_failed) ;;
    *) [[ "$(sget NEW_RAN)" == 1 ]] && restores=1 ;;
  esac
  ((restores == 0)) || rollback_ready || fail "no rollback of $PAGE: $RB_WHY"
  case "$step" in
    aborted|rolled_back) fail "the last update of $PAGE ended $step: nothing to roll back" ;;
    rolling_back|aborting) ;;
    done)
      [[ "$(value PB_IMAGE "$(page_env "$PAGE")")" == "$(sget TO_IMAGE)" ]] \
        || fail "$PAGE is not on $(sget TO_IMAGE) any more: its last update is not the page's state to undo"
      sset "REASON=$reason" NEW_RAN=1 RB_STEP= RB_START= RB_STOP= RB_GIVEN_BACK_MS= STOP_rbout= START_rbback=
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

# ── a standalone snapshot, an operation of its own ───────────────────────
#
# Its record (update/pages/<page>/snapshot) is written before the container
# stops: a run cut off between the stop and the start is resumed (`resume
# --page`) and reported by the timer — never a page left stopped unknown.
# The container comes back through page.sh (its Chrome guard).

snapshot_state() { printf '%s/pages/%s/snapshot' "$UPDATE_DIR" "$1"; }
snapshot_pending() {
  local file
  file="$(snapshot_state "$1")"
  [[ -f "$file" ]] && ! terminal "$(value STEP "$file")"
}

# Only a confirmed outcome ends the operation: an unknown state leaves it
# where it is — resumable, and reported by the timer every pass — until
# the container is seen back as it was.
snap_stop() {
  if [[ "$(sget WAS_RUNNING)" == 1 ]]; then
    if ! container_read "$PAGE"; then
      alert snapshot_waiting "$STATE_WHY: the snapshot of $PAGE waits at step $(sget STEP) (resume --page $PAGE)"
      return 1
    fi
    if [[ "$C_STATE" == running ]]; then
      local chrome
      chrome="$(chrome_state "$PAGE")"
      if [[ "$chrome" == unknown ]]; then
        alert snapshot_waiting "Chrome's state in $(container_of "$PAGE") cannot be read: the snapshot of $PAGE waits (resume --page $PAGE)"
        return 1
      fi
      if [[ "$chrome" != down ]]; then
        # Confirmed: Chrome runs and nothing was stopped — the page as it was.
        sset "REASON=Chrome is $chrome"
        alert snapshot_failed "Chrome is $chrome in $(container_of "$PAGE"): stop the page's browser first (sync browser stop)"
        step_to failed
        return 1
      fi
      if ! guard_quiet "$(sget STOP)"; then
        # Nothing stopped: the page as it was.
        sset "REASON=$GUARD_WHY"
        alert snapshot_failed "$GUARD_WHY: $(container_of "$PAGE") is not stopped, nothing touched"
        step_to failed
        return 1
      fi
      docker stop -t 25 "$(container_of "$PAGE")" >/dev/null || log "warning: $(container_of "$PAGE") did not stop: the snapshot will not be taken"
    fi
  fi
  step_to stopped
}

snap_take() {
  if ! guard_quiet "$(sget STOP)"; then
    sset "SNAP_FAILED=$GUARD_WHY: not packed"
    alert snapshot_failed "no snapshot of $PAGE: $GUARD_WHY — nothing packed"
  elif profile_op snapshot "$PAGE" "$(sget PROFILE)" "$(sget IMAGE)"; then
    sset "SNAPSHOT=$SNAP_NAME" "SNAP_CHROME=$PROFILE_CHROME"
  else
    sset "SNAP_FAILED=$OP_WHY"
    alert snapshot_failed "no snapshot of $PAGE: $OP_WHY"
  fi
  step_to snapshotted
}

# The container back as it was; unknown or not back: the record stays, and
# resume tries again.
snap_start() {
  if [[ "$(sget WAS_RUNNING)" == 1 ]]; then
    if ! container_read "$PAGE"; then
      alert snapshot_failed "$STATE_WHY: $(container_of "$PAGE") is not started blind (resume --page $PAGE)"
      return 1
    fi
    if [[ "$C_STATE" != running ]]; then
      if ! guard_quiet "$(sget STOP)"; then
        alert snapshot_waiting "$GUARD_WHY: $(container_of "$PAGE") is not started blind (once you decide: start it yourself, page.sh up --page $PAGE --image $(sget IMAGE), and resume --page $PAGE)"
        return 1
      fi
      if ! "$PAGE_SH" up --page "$PAGE" --image "$(sget IMAGE)" >&2; then
        alert snapshot_failed "$(container_of "$PAGE") did not start again (resume --page $PAGE)"
        return 1
      fi
    fi
  fi
  if [[ -n "$(sget SNAP_FAILED)" ]]; then step_to failed; else step_to done; fi
}

advance_snapshot() {
  while :; do
    case "$(sget STEP)" in
      planned) snap_stop || return 1 ;;
      stopped) snap_take ;;
      snapshotted) snap_start || return 1 ;;
      done)
        say snapshot "snapshots/$(sget PROFILE)/$(sget SNAPSHOT) (Chrome $(sget SNAP_CHROME))"
        printf '%s/%s/%s\n' "$SNAP_DIR" "$(sget PROFILE)" "$(sget SNAPSHOT)"
        return 0
        ;;
      failed) return 1 ;;
      *) alert snapshot_failed "unknown step '$(sget STEP)' in $STATE"; return 1 ;;
    esac
  done
}

cmd_snapshot() {
  local engine=hub
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --page) PAGE="${2:-}"; shift 2 ;;
      --engine) engine="${2:-}"; shift 2 ;;
      *) fail "snapshot: unknown option $1" ;;
    esac
  done
  [[ "$PAGE" =~ $PAGE_RE ]] || fail "--page: lowercase letters, digits and dashes"
  [[ "$engine" == hub || "$engine" == none ]] || fail "--engine: hub or none"
  local env image profile update was_running=0
  env="$(page_env "$PAGE")"
  [[ -f "$env" ]] || fail "no page $PAGE here"
  image="$(value PB_IMAGE "$env")"
  profile="$(value PB_PROFILE_ID "$env")"
  take_lock || fail "another update, rollback or build holds $UPDATE_DIR/.lock"
  ! snapshot_pending "$PAGE" || fail "a snapshot of $PAGE is unfinished: page-browser-update.sh resume --page $PAGE"
  update="$(value STEP "$UPDATE_DIR/pages/$PAGE/state")"
  [[ -z "$update" ]] || terminal "$update" || fail "an update of $PAGE is unfinished (step $update): resume or rollback it first"
  container_read "$PAGE" || fail "$STATE_WHY"
  if [[ "$C_STATE" == running ]]; then
    [[ "$(chrome_state "$PAGE")" == down ]] || fail "Chrome is not down in $(container_of "$PAGE"): stop the page's browser first (sync browser stop)"
    was_running=1
  fi
  # A page its engine runs on its browser: the owner's stop holds it,
  # answered — the stop the snapshot goes on under (the guard's).
  local stop=""
  if [[ "$engine" == hub ]]; then
    local rc=0
    hub_read || rc=$?
    ((rc == 0)) || { ((rc == 3)) && fail "the Hub knows no page $PAGE (--engine none for a page it does not know)"; fail "the Hub cannot be read"; }
    if [[ "$H_TRANSPORT" == browser ]]; then
      hub_stop_now || fail "the Hub cannot be read"
      [[ "$STOP_SET" == true && "$STOP_OUTCOME" == ok ]] \
        || fail "the page's browser is not stopped, answered (stop command ${STOP_ID:-none}: ${STOP_OUTCOME:-not answered}, in force: $STOP_SET): stop it first (sync browser stop)"
      stop="$STOP_ID"
    fi
  fi
  STATE="$(snapshot_state "$PAGE")"
  RUN="manual-$(date -u +%Y%m%dT%H%M%SZ)"
  rm -f "$STATE"
  # The record before the container stops.
  sset "RUN=$RUN" "PAGE=$PAGE" "PROFILE=$profile" "IMAGE=$image" "ENGINE=$engine" "STOP=$stop" "WAS_RUNNING=$was_running" "STARTED_AT=$(now_iso)"
  step_to planned
  trap on_exit EXIT
  advance_snapshot
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
  local tags
  tags="$(docker image ls --format '{{.Repository}}:{{.Tag}}' hub-page-browser)" || return 1
  grep -E "$RELEASE_TAG_RE" <<<"$tags" || true
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
  local newest="" version tag tags
  tags="$(release_images)" || return 1
  while IFS= read -r tag; do
    [[ "$tag" =~ $RELEASE_TAG_RE ]] || continue
    version="${BASH_REMATCH[1]}"
    if [[ -z "$newest" ]] || ver_gt "$version" "$newest"; then newest="$version"; fi
  done <<<"$tags"
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
  local protocol
  protocol="$(sed -n 's/.*PROTOCOL = { major: \([0-9]*\), minor: \([0-9]*\) }.*/\1.\2/p' "$work/context/src/rpc/protocol.ts" | head -n 1)"
  [[ "$protocol" =~ ^[0-9]+\.[0-9]+$ ]] || { BUILD_WHY="the operator's protocol cannot be read in the build context"; return 1; }
  docker build --build-context vendor="$work/vendor" \
    --build-arg CHROME_VERSION="$version" --build-arg OPERATOR_VERSION="$revision" \
    --label agency-hub.page-browser.revision="$revision" \
    --label agency-hub.page-browser.protocol="$protocol" \
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
  local kept_versions=" " kept_revisions=" " tags
  if ! tags="$(release_images)"; then
    log "warning: the images cannot be listed: none is pruned"
    tags=""
  fi
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
  done < <(while IFS= read -r tag; do
      [[ -n "$tag" ]] || continue
      # An image whose age cannot be read is kept: never pruned blind.
      created="$(docker image inspect --format '{{.Created}}' "$tag" 2>/dev/null)" && [[ -n "$created" ]] || created="9999-kept-unread"
      printf '%s %s\n' "$created" "$tag"
    done <<<"$tags" | sort -r)
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
  # The daily Chrome build leaves its BuildKit cache behind, and nothing else
  # on this host prunes it (Hub's deploy does the same for its own builds,
  # scripts/deploy-production.sh). The cache, never an image: a kept image's
  # layers are not cache entries. Same age as the deploy's; a failure is
  # logged and never stops the prune.
  if docker builder prune --force --filter until=168h >/dev/null 2>&1; then
    journal build_cache_pruned "until=168h"
  else
    log "warning: the build cache could not be pruned"
  fi
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
    if [[ "$alerts" == 1 ]] && snapshot_pending "$page" && lock_free; then
      PAGE="$page" alert update_stuck "its snapshot stopped at step $(value STEP "$(snapshot_state "$page")"), its container perhaps stopped: page-browser-update.sh resume --page $page"
    fi
    if [[ "$alerts" == 1 && -n "$step" ]] && ! terminal "$step"; then
      if [[ "$step" == held || "$step" == rollback_failed ]]; then
        local why
        why="$(value HELD_WHY "$state")"
        [[ "$step" == held && -n "$why" ]] || why="$(value RB_FAILED "$state")"
        [[ -n "$why" ]] || why="$(value REASON "$state")"
        PAGE="$page" alert update_waiting "its update stands at $step ($why): the owner decides (resume or rollback)"
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
  # What waits for the owner is reported whatever the repository says.
  check_repository "$WORK" "$locked" "$build" || true
  local newest newest_since meta
  newest="$(newest_known)" || newest=""
  meta="$ARCHIVE_DIR/google-chrome-stable_${newest}_${ARCH}.deb.meta"
  newest_since="$(value fetched_s "$meta")"
  {
    printf 'checked %s: Chrome Stable %s (%s); newest here %s\n' "$(now_iso)" "${REPO_VERSION:-unknown}" "${REPO_DATE:-the repository not read}" "${newest:-none}"
    report_pages "$newest" "$newest_since" 1
  } > "$UPDATE_DIR/status.part"
  mv -f "$UPDATE_DIR/status.part" "$UPDATE_DIR/status"
  cat "$UPDATE_DIR/status" >&2
  # An alert fails the unit too (systemctl --failed shows it).
  return "$ALERTED"
}

# The repository's newest Chrome: fetched, verified, built and proposed if
# it is new. 1 after an alert.
check_repository() {
  local work="$1" locked="$2" build="$3"
  if ! repo_latest "$work"; then
    alert repository "Chrome's repository could not be read or verified: $REPO_WHY"
    return 1
  fi
  local release_s last_s
  release_s="$(epoch_of_rfc2822 "$REPO_DATE" || true)"
  if [[ ! "$release_s" =~ ^[0-9]+$ ]]; then
    alert repository "InRelease's Date ('$REPO_DATE') cannot be read: whether it is a replayed index is unknown"
    return 1
  fi
  last_s="$(cat "$UPDATE_DIR/repo-date" 2>/dev/null || true)"
  if [[ "$last_s" =~ ^[0-9]+$ ]] && ((release_s < last_s)); then
    alert repository "the repository's InRelease ($REPO_DATE) is older than one seen before: refused (a replayed index hides releases)"
    return 1
  fi
  printf '%s\n' "$release_s" >"$UPDATE_DIR/repo-date"
  local known
  if ! known="$(newest_known)"; then
    alert images "the images here cannot be listed: nothing is fetched or built blind"
    return 1
  fi
  if [[ -n "$known" ]] && ! ver_gt "$REPO_VERSION" "$known"; then
    say checked "Chrome Stable $REPO_VERSION ($REPO_DATE): no newer than the newest here ($known)"
  elif ((locked == 0)); then
    say checked "Chrome Stable $REPO_VERSION is new; an update or build runs: the next check takes it"
  else
    fetch_deb "$work" || { alert fetch "$REPO_WHY"; return 1; }
    say fetched "google-chrome-stable $REPO_VERSION ($ARCH, SHA-256 ${REPO_SHA256:0:16}…, signed by subkey $REPO_SIGNER, released $REPO_DATE)"
    if ((build == 0)); then
      propose proposed "Chrome $REPO_VERSION is fetched and verified; build it: page-browser-update.sh build --chrome $REPO_VERSION"
    elif ! build_image "$REPO_VERSION"; then
      alert build "Chrome $REPO_VERSION is fetched and verified, but its image was not built: $BUILD_WHY"
      return 1
    else
      say built "$BUILT_TAG"
      prune_all
      propose proposed "Chrome $REPO_VERSION is out ($REPO_DATE); its image $BUILT_TAG is built. No page is updated by itself (owner decision №15 is open). Next, 06:00–20:00 UTC: page-browser-update.sh update --page <first page> --image $BUILT_TAG --detach (1 h window); then page-browser-update.sh rollout --image $BUILT_TAG --detach"
    fi
  fi
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
    local file
    for file in "$UPDATE_DIR/pages/$PAGE/state" "$(snapshot_state "$PAGE")"; do
      if [[ -f "$file" ]]; then printf '%s:\n' "$(basename "$file")"; sed 's/^/  /' "$file"; fi
    done
    [[ -f "$UPDATE_DIR/pages/$PAGE/state" || -f "$(snapshot_state "$PAGE")" ]] || echo "no update or snapshot of $PAGE"
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
