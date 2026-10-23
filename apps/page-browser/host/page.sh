#!/usr/bin/env bash
# A page's browser container on the server (plan §3.1; stage 3, PR 2), run
# as root by scripts/deploy-page-browser.sh over SSH — the only way these
# containers are created, recreated and removed.
#
#   page.sh up --page <name> --image <tag> [--socks <host:port>]
#              [--profile <uuid> | --new-profile] [--tz <zone>] [--lang <tag>]
#              [--screen <WxH>] [--cores <cpus> | --cores all] [--fonts <set>]
#              (a new page needs --socks and a profile; an existing one keeps
#              what it had unless told otherwise; --tz and --lang are only
#              Chrome's defaults until the engine's hello brings the page's
#              own environment)
#   page.sh add-profile --page <name> --image <tag> --socks <host:port>
#              [--tz <zone>] [--lang <tag>] [--screen <WxH>]
#              [--cores <cpus> | --cores all] [--fonts <set>]
#              (Project Browser PR 16: a new profile for a page that has no
#              container here — `up --new-profile`, refused for a page that
#              has one; its last lines name it: PB_PROFILE_ID=<uuid> and
#              PB_SOCKS=<ip>:<port>, the SOCKS5 its rules admit. A start that
#              fails takes its files and volumes with it only once Docker
#              says its container is absent; else all stays, and it says so)
#   page.sh remove-profile --page <name> --profile <uuid>
#              (a profile given up before it served a page: its container
#              removed, its files and its two volumes deleted — the session
#              its profile may hold goes with them; only while the page's
#              files still name that profile, checked under the lock)
#   page.sh rollback --page <name>
#   page.sh down --page <name>
#   page.sh forget --page <name>
#   page.sh status [--page <name>]
#   page.sh log --page <name> [--kind requests|connections|states|sockets]
#              [--since <iso>] [--path <prefix>] [--method <M>]
#              (the operator's journals on the page's buffer volume, read
#              here: Hub's containers cannot reach them — plan §4.11)
#
# A page's device (owner decision 2026-10-23): what the site sees of the
# machine, real — nothing is spoofed in the page —, and its own, so the
# pages do not all look like one device. Kept in page.env like the rest:
#   --screen  the X server's geometry and Chrome's window: 1920x1080
#             (default), 2560x1440, 1680x1050, 1600x900, 1440x900, 1366x768;
#   --cores   the CPUs the container may run on, a Docker cpuset of this
#             host's online CPUs, two at least (`0-3`, `2-7`, `0,2,4-5`) —
#             navigator.hardwareConcurrency is their count; `all` (default):
#             every CPU of the host;
#   --fonts   the image's font set (apps/page-browser/fonts/): base
#             (default), office, croscore, croscore-office.
# An image from before 2026-10-23 shows every page 1920x1080 with the base
# fonts, whatever page.env says: one is refused for a page whose screen or
# fonts are not those (`up`, `rollback`).
#
# A page's files: $PB_BASE/pages/<page>/page.env (the Compose variables:
# image and the previous one, profile, addresses, SOCKS5, zone, language,
# device) and secrets/ — vnc_password (the owner's screen) and rpc_token (the
# operator's RPC), made here once, root's only. Its addresses in pb-control
# and pb-egress end in the same octet, chosen once. The profile's volumes
# outlive the container: `down` keeps them; `forget` drops a removed page's
# files, and `up --profile` then gives its profile to another page. A
# profile belongs to one page at a time.
#
# A new container replaces the old one only when it is healthy: until then
# page.env keeps the old state, and a failed `up` or `rollback` brings the
# old container back.
#
# Chrome upgrades a profile in place and never opens one a newer Chrome
# wrote (stage 1; plan §4.10): every start of a container goes through
# start_state, which refuses an image whose Chrome is older than the one
# that last opened the page's profile — `up`, `rollback`, and the way back
# after a failed switch, which leaves the page stopped instead. The way back
# to an older Chrome is the profile's snapshot with it:
# page-browser-update.sh rollback (PR 18). A state Docker cannot read is
# never taken for "stopped" or "nobody".
set -euo pipefail

PB_BASE="${PB_BASE:-/opt/agency-hub/page-browser}"
COMPOSE_FILE="$PB_BASE/docker-compose.page-browser.yml"
CONTROL_PREFIX="${PB_CONTROL_PREFIX:-10.230.0}"
EGRESS_PREFIX="${PB_EGRESS_PREFIX:-10.230.1}"
# `sync` and `api` in pb-control (Hub's compose file, PR 3).
SYNC_IP="$CONTROL_PREFIX.2"
API_IP="$CONTROL_PREFIX.3"
HEALTH_WAIT_S=90

fail() {
  echo "page: $*" >&2
  exit 1
}

command="${1:-}"
[[ -n "$command" ]] && shift
PAGE="" IMAGE="" SOCKS="" PROFILE="" NEW_PROFILE=0 TZ_ARG="" LANG_ARG=""
SCREEN_ARG="" CORES_ARG="" FONTS_ARG=""
LOG_KIND="requests" LOG_SINCE="" LOG_PATH="" LOG_METHOD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind) LOG_KIND="$2"; shift 2 ;;
    --since) LOG_SINCE="$2"; shift 2 ;;
    --path) LOG_PATH="$2"; shift 2 ;;
    --method) LOG_METHOD="$2"; shift 2 ;;
    --page) PAGE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --socks) SOCKS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --new-profile) NEW_PROFILE=1; shift ;;
    --tz) TZ_ARG="$2"; shift 2 ;;
    --lang) LANG_ARG="$2"; shift 2 ;;
    --screen) SCREEN_ARG="$2"; shift 2 ;;
    --cores) CORES_ARG="$2"; shift 2 ;;
    --fonts) FONTS_ARG="$2"; shift 2 ;;
    *) fail "unknown option $1" ;;
  esac
done
[[ -z "$PAGE" || "$PAGE" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fail "--page: lowercase letters, digits and dashes"

page_dir() { printf '%s/pages/%s' "$PB_BASE" "$PAGE"; }
env_file() { printf '%s/page.env' "$(page_dir)"; }
next_file() { printf '%s/page.env.next' "$(page_dir)"; }
value() {
  [[ -f "$2" ]] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}
# Compose with a given env file: page.env, or the next state being tried.
compose_with() {
  local env="$1"
  shift
  docker compose -p "page-browser-$PAGE" -f "$COMPOSE_FILE" --env-file "$env" "$@"
}

# The container's health (the image's check: the kernel check passed, the X
# server is up); 1 with its log's start lines when it is not healthy.
healthy() {
  local container="page-browser-$PAGE" health=""
  for _ in $(seq 1 "$HEALTH_WAIT_S"); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$health" == "starting" || -z "$health" ]] || break
    sleep 1
  done
  if [[ "$health" != "healthy" ]]; then
    docker logs --tail 60 "$container" 2>&1 | grep -E 'init-net|net-selftest|xvnc|s6-rc|rc.init' >&2 || true
    echo "page: $container is ${health:-missing}" >&2
    return 1
  fi
}

# The page's container, read and never guessed: running, stopped or absent.
# 1 (why on stderr) when Docker cannot say: unknown is never "stopped".
container_status() {
  local out
  if out="$(docker inspect -f '{{.State.Running}}' "page-browser-$PAGE" 2>&1)"; then
    case "$out" in
      true) echo running ;;
      false) echo stopped ;;
      *) echo "page: page-browser-$PAGE: its state reads '$out'" >&2; return 1 ;;
    esac
  elif grep -qiE 'no such (object|container)' <<<"$out"; then
    echo absent
  else
    echo "page: page-browser-$PAGE cannot be read: $out" >&2
    return 1
  fi
}

# Recreate/down delete Docker's local stdout/stderr log. Archive only this
# page's Compose project, outside its removable pages/ files. A failed archive
# is explicit and partial output is kept; recovery is not blocked by disk full.
archive_browser() {
  local why="$1" state rc=0
  state="$(container_status)" || { echo "page: warning: $PAGE logs cannot be located before $why" >&2; return 0; }
  [[ "$state" != absent ]] || return 0
  if [[ ! -x "$PB_BASE/archive-container-logs.sh" ]]; then
    echo "page: warning: $PAGE log archive helper is missing before $why (deploy host files)" >&2
    return 0
  fi
  "$PB_BASE/archive-container-logs.sh" --dir "$PB_BASE/container-logs/$PAGE" \
    --project-dir "$PB_BASE" --project-name "page-browser-$PAGE" --reason "$why $PAGE" browser || rc=$?
  ((rc == 0)) || echo "page: warning: $PAGE log archive incomplete before $why (status $rc); partial files kept" >&2
  return 0
}

# Every start of a page's container goes through here — `up`, `rollback`,
# the way back after a failed switch, and so every start
# page-browser-update.sh makes: never an older Chrome on a profile a newer
# one wrote. 2: refused (or the profile cannot be read), nothing started.
start_state() {
  local env="$1"
  compatible "$(value PB_IMAGE "$env")" "$(value PB_PROFILE_ID "$env")" || return 2
  archive_browser recreate
  compose_with "$env" up -d --force-recreate --no-build >/dev/null
}

# Run the candidate state (page.env.next). The host's rules admit it before
# it starts — the page's current state and the candidate, both its own, until
# the switch ends; if they cannot be applied, nothing changes. Healthy: the
# candidate becomes page.env. Refused before it started: nothing changed.
# Started and not healthy: it is stopped first — its Chrome may have opened
# the profile — and the previous state runs again only if its Chrome may open
# the profile as the candidate left it; else the page stays stopped until its
# snapshot is back (page-browser-update.sh rollback). Either way this fails.
switch_to() {
  local what="$1" next rc=0 state
  next="$(next_file)"
  if ! "$PB_BASE/egress-rules.sh" apply; then
    rm -f "$next"
    fail "$what: the host's rules could not admit the new state; nothing changed"
  fi
  start_state "$next" || rc=$?
  if ((rc == 0)) && healthy; then
    mv "$next" "$(env_file)"
    "$PB_BASE/egress-rules.sh" apply \
      || echo "page: warning: the host's rules still admit $PAGE's previous SOCKS5 too (run egress-rules.sh apply)" >&2
    echo "page: page-browser-$PAGE healthy on $(value PB_IMAGE "$(env_file)")"
    return 0
  fi
  rm -f "$next"
  if ((rc == 2)); then
    "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the refused state's SOCKS5" >&2
    fail "$what refused before anything started; page-browser-$PAGE is as it was"
  fi
  docker stop -t 20 "page-browser-$PAGE" >/dev/null 2>&1 || true
  state="$(container_status)" || fail "$what failed, and page-browser-$PAGE cannot be read: it is left as it is"
  [[ "$state" != running ]] || fail "$what failed, and page-browser-$PAGE does not stop: it is left as it is"
  "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the failed state's SOCKS5" >&2
  if [[ -f "$(env_file)" ]]; then
    rc=0
    start_state "$(env_file)" || rc=$?
    ((rc != 2)) || fail "$what failed; page-browser-$PAGE stays stopped: the profile is not for $(value PB_IMAGE "$(env_file)")'s Chrome any more (page-browser-update.sh rollback restores its snapshot)"
    ((rc == 0)) && healthy && fail "$what failed; page-browser-$PAGE is back on $(value PB_IMAGE "$(env_file)")"
    fail "$what failed, and page-browser-$PAGE did not come back healthy on $(value PB_IMAGE "$(env_file)")"
  fi
  archive_browser failed_switch
  docker rm -f "page-browser-$PAGE" >/dev/null 2>&1 || true
  "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the removed page" >&2
  fail "$what failed; the new page was removed"
}

# Who else holds a profile: another page's files, or another container
# mounting its volume. Two Chromes on one profile would share its session
# and corrupt it. 1 when Docker cannot list them: never taken for nobody.
profile_owner() {
  local profile="$1" file users
  for file in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$file" && "$file" != "$(env_file)" ]] || continue
    [[ "$(value PB_PROFILE_ID "$file")" == "$profile" ]] && { value PB_PAGE "$file"; return 0; }
  done
  users="$(docker ps -a --filter "volume=pb-profile-$profile" --format '{{.Names}}')" || return 1
  grep -vx "page-browser-$PAGE" <<<"$users" | sed '/^$/d' | head -n 1 || true
}

# A Chrome version out of anything that names it; ver_gt a b: a is later.
chrome_of() {
  [[ "$1" =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"
}
ver_gt() {
  local IFS=. i
  local -a a b
  read -r -a a <<<"$(chrome_of "$1")"
  read -r -a b <<<"$(chrome_of "$2")"
  for i in 0 1 2 3; do
    ((10#${a[i]:-0} > 10#${b[i]:-0})) && return 0
    ((10#${a[i]:-0} < 10#${b[i]:-0})) && return 1
  done
  return 1
}

# Whether <image>'s Chrome may open <profile>: not when the profile was last
# opened by a newer Chrome than the image's. Read through a container of the
# image itself, with no network: the profile is Chrome's user's alone. 1
# (why on stderr) when it may not — or when either cannot be read.
compatible() {
  local image="$1" profile="$2" label image_chrome profile_chrome
  if ! label="$(docker image inspect --format '{{ index .Config.Labels "agency-hub.page-browser.chrome-version" }}' "$image" 2>/dev/null)"; then
    echo "page: the image $image cannot be read" >&2
    return 1
  fi
  image_chrome="$(chrome_of "$label" || true)"
  if [[ -z "$image_chrome" ]]; then
    image_chrome="$(chrome_of "$(docker run --rm --network none --entrypoint /usr/bin/google-chrome-stable "$image" --version 2>/dev/null)" || true)"
  fi
  [[ -n "$image_chrome" ]] || { echo "page: the Chrome of $image cannot be read" >&2; return 1; }
  if ! profile_chrome="$(docker run --rm --network none --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges --user 0 \
    --entrypoint sh -v "pb-profile-$profile:/profile:ro" "$image" -c '
      if [ -f "/profile/Last Version" ]; then head -c 64 "/profile/Last Version"
      elif [ -f /profile/Default/Preferences ]; then grep -o "\"last_chrome_version\":\"[0-9.]*\"" /profile/Default/Preferences | head -n 1
      fi' pb-helper version)"; then
    echo "page: the profile $profile cannot be read" >&2
    return 1
  fi
  profile_chrome="$(chrome_of "$profile_chrome" || true)"
  if [[ -n "$profile_chrome" ]] && ver_gt "$profile_chrome" "$image_chrome"; then
    echo "page: $image has Chrome $image_chrome, but the profile $profile was last opened by Chrome $profile_chrome: Chrome never opens a profile a newer one wrote (page-browser-update.sh rollback restores its snapshot)" >&2
    return 1
  fi
}

new_uuid() {
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    uuidgen | tr '[:upper:]' '[:lower:]'
  fi
}

free_octet() {
  local used octet
  used="$(cat "$PB_BASE"/pages/*/page.env 2>/dev/null | sed -n "s/^PB_EGRESS_IP=$EGRESS_PREFIX\.//p" | sort -n)"
  for octet in $(seq 10 250); do
    grep -qx "$octet" <<<"$used" || { printf '%s' "$octet"; return 0; }
  done
  fail "no free address in pb-egress"
}

# The CPUs of a cpuset list (`0-3`, `0,2,4-5`), one a line; 1 when it is
# not one.
cpus_in() {
  local part lo hi IFS=,
  [[ "$1" =~ ^(0|[1-9][0-9]{0,3})(-(0|[1-9][0-9]{0,3}))?(,(0|[1-9][0-9]{0,3})(-(0|[1-9][0-9]{0,3}))?)*$ ]] || return 1
  for part in $1; do
    lo="${part%-*}"
    hi="${part#*-}"
    ((lo <= hi)) || return 1
    seq "$lo" "$hi"
  done
}

# A page's cpuset (--cores): CPUs this host has online, two at least — the
# container's two CPUs of time (docker-compose.page-browser.yml) run on
# them, and on one the work tab missed CDP's answers (2026-10-21).
valid_cpuset() {
  local wanted online cpu
  wanted="$(cpus_in "$1")" || return 1
  online="$(cpus_in "$(cat /sys/devices/system/cpu/online 2>/dev/null)")" || return 1
  for cpu in $wanted; do
    grep -qx "$cpu" <<<"$online" || return 1
  done
  (($(sort -nu <<<"$wanted" | wc -l) >= 2))
}

# Whether <image> shows a page's screen and fonts: one from before
# 2026-10-23 (no font sets in it) shows every page 1920x1080 with the base
# fonts, whatever page.env says, and an image without the set would not
# start Chrome. Read through a container of the image itself, with no
# network; the defaults need no look.
device_ok() {
  local image="$1" screen="${2:-1920x1080}" fonts="${3:-base}"
  [[ "$screen" == 1920x1080 && "$fonts" == base ]] && return 0
  docker run --rm --network none --entrypoint /bin/sh "$image" \
    -c 'test -f "/opt/page-browser/fonts/$1.conf"' pb-fonts "$fonts" >/dev/null 2>&1
}

up() {
  [[ -n "$PAGE" ]] || fail "--page is required"
  [[ "$IMAGE" =~ ^hub-page-browser:[A-Za-z0-9_.-]+$ ]] || fail "--image: hub-page-browser:<tag>"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no image $IMAGE here (build it first)"
  local dir old="" profile octet previous="" time_zone lang socks_ip socks_port
  dir="$(page_dir)"
  [[ -f "$(env_file)" ]] && old="$(env_file)"
  if [[ -z "$SOCKS" && -n "$old" ]]; then
    # The page's SOCKS5 as it was.
    socks_ip="$(value PB_SOCKS_IP "$old")"
    socks_port="$(value PB_SOCKS_PORT "$old")"
  else
    [[ "$SOCKS" =~ ^([A-Za-z0-9.-]+):([0-9]{1,5})$ ]] || fail "--socks: <host>:<port>"
    socks_port="${BASH_REMATCH[2]}"
    socks_ip="$(getent ahostsv4 "${BASH_REMATCH[1]}" | awk 'NR == 1 { print $1 }')"
  fi
  [[ "$socks_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "cannot resolve the SOCKS5 host"
  if [[ "$NEW_PROFILE" == 1 ]]; then
    [[ -z "$PROFILE" ]] || fail "--profile and --new-profile together"
    profile="$(new_uuid)"
  else
    profile="${PROFILE:-$(value PB_PROFILE_ID "$old")}"
    [[ -n "$profile" ]] || fail "a new page needs --profile <uuid> or --new-profile"
    [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "--profile: a UUID"
    docker volume inspect "pb-profile-$profile" "pb-buffer-$profile" >/dev/null 2>&1 || fail "no volumes of profile $profile"
    local owner
    owner="$(profile_owner "$profile")" || fail "the containers of profile $profile cannot be listed"
    [[ -z "$owner" ]] || fail "profile $profile belongs to $owner (remove it with down, then forget)"
  fi
  octet="$(value PB_EGRESS_IP "$old" | sed -n "s/^$EGRESS_PREFIX\.//p")"
  [[ -n "$octet" ]] || octet="$(free_octet)"
  previous="$(value PB_IMAGE "$old")"
  [[ "$previous" == "$IMAGE" ]] && previous="$(value PB_PREVIOUS_IMAGE "$old")"
  time_zone="${TZ_ARG:-$(value PB_TZ "$old")}"
  lang="${LANG_ARG:-$(value PB_LANG "$old")}"
  # By the rules Chrome's run script checks them with (src/env/rules.ts).
  [[ ${#time_zone} -le 64 && "${time_zone:-UTC}" =~ ^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){0,2}$ ]] || fail "--tz: an IANA zone name"
  [[ "${lang:-en-US}" =~ ^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$ ]] || fail "--lang: a language tag"
  # The page's device (above), given or as it was: by the rules the image's
  # run scripts check it with, the cores against this host; refused here,
  # before anything changes, for an image that would not show it.
  local screen cpuset fonts
  screen="${SCREEN_ARG:-$(value PB_SCREEN "$old")}"
  screen="${screen:-1920x1080}"
  cpuset="${CORES_ARG:-$(value PB_CPUSET "$old")}"
  [[ "$cpuset" != all ]] || cpuset=""
  fonts="${FONTS_ARG:-$(value PB_FONTS "$old")}"
  fonts="${fonts:-base}"
  [[ "$screen" =~ ^(1920x1080|2560x1440|1680x1050|1600x900|1440x900|1366x768)$ ]] \
    || fail "--screen: 1920x1080, 2560x1440, 1680x1050, 1600x900, 1440x900 or 1366x768"
  [[ -z "$cpuset" ]] || valid_cpuset "$cpuset" \
    || fail "--cores: two or more of this host's online CPUs ($(cat /sys/devices/system/cpu/online 2>/dev/null || echo unknown)) as a cpuset — 0-3, 2-7, 0,2,4-5 — or all"
  [[ "$fonts" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || fail "--fonts: the name of one of the image's font sets"
  device_ok "$IMAGE" "$screen" "$fonts" \
    || fail "up $IMAGE refused: it has no font set $fonts (an image from before 2026-10-23 shows every page 1920x1080 with the base fonts)"

  if [[ "$NEW_PROFILE" == 1 ]]; then
    docker volume create "pb-profile-$profile" >/dev/null
    docker volume create "pb-buffer-$profile" >/dev/null
  else
    # Refused here before anything changes; start_state holds it again.
    compatible "$IMAGE" "$profile" || fail "up $IMAGE refused"
  fi
  install -d -m 700 "$dir" "$dir/secrets"
  if [[ ! -s "$dir/secrets/vnc_password" ]]; then
    (umask 077; openssl rand -hex 24 > "$dir/secrets/vnc_password")
  fi
  # The page's RPC token: the operator answers only an engine's hello that
  # carries it (plan §4.13).
  if [[ ! -s "$dir/secrets/rpc_token" ]]; then
    (umask 077; openssl rand -hex 32 > "$dir/secrets/rpc_token")
  fi
  # The API's own token for the login form's calls (plan §4.8): never the
  # engine's.
  if [[ ! -s "$dir/secrets/api_token" ]]; then
    (umask 077; openssl rand -hex 32 > "$dir/secrets/api_token")
  fi
  local next
  next="$(next_file)"
  (umask 077; : > "$next")
  cat > "$next" <<EOF
PB_PAGE=$PAGE
PB_IMAGE=$IMAGE
PB_PREVIOUS_IMAGE=$previous
PB_PROFILE_ID=$profile
PB_CONTROL_IP=$CONTROL_PREFIX.$octet
PB_EGRESS_IP=$EGRESS_PREFIX.$octet
PB_SOCKS_IP=$socks_ip
PB_SOCKS_PORT=$socks_port
PB_SYNC_IP=$SYNC_IP
PB_API_IP=$API_IP
PB_TZ=${time_zone:-UTC}
PB_LANG=${lang:-en-US}
PB_SCREEN=$screen
PB_CPUSET=$cpuset
PB_FONTS=$fonts
PB_SECCOMP_PROFILE=$PB_BASE/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=${PB_APPARMOR_PROFILE:-page-browser}
PB_SECRETS_DIR=$dir/secrets
EOF
  chmod 600 "$next"
  # A new page's addresses are in the host's rules only once it is healthy:
  # until then the host lets it reach nothing.
  switch_to "up $IMAGE"
}

# A new profile (Project Browser PR 16): a container with a profile of its
# own, an empty buffer and secrets of its own, for a page that has none here.
# Its last lines name the profile and the SOCKS5 its rules admit, for the
# deploy script to register it in Hub.
add_profile() {
  [[ -n "$PAGE" ]] || fail "--page is required"
  [[ ! -f "$(env_file)" ]] || fail "$PAGE has a container here already (status; remove-profile gives up a profile no page has)"
  [[ -z "$PROFILE" && "$NEW_PROFILE" == 0 ]] || fail "add-profile makes a new profile: no --profile, no --new-profile"
  [[ -n "$SOCKS" ]] || fail "add-profile needs --socks <host>:<port>"
  local profile
  profile="$(new_uuid)"
  [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "no UUID for the new profile"
  # Nothing half-made stays: a start that fails takes the new profile's
  # volumes and files with it.
  trap 'add_profile_undo '"$profile" EXIT
  docker volume create "pb-profile-$profile" >/dev/null
  docker volume create "pb-buffer-$profile" >/dev/null
  PROFILE="$profile"
  up
  trap - EXIT
  printf 'PB_PROFILE_ID=%s\n' "$(value PB_PROFILE_ID "$(env_file)")"
  printf 'PB_SOCKS=%s:%s\n' "$(value PB_SOCKS_IP "$(env_file)")" "$(value PB_SOCKS_PORT "$(env_file)")"
}

# The new profile's undo, when its start failed: its files and volumes go
# only once Docker says its container is absent. A container left as it is
# (one that would not stop, a Docker that cannot be read — switch_to's own
# words) keeps everything: its secrets and its profile may be in use
# (Astra's review of PR 16, round 4).
add_profile_undo() {
  local profile="$1" state
  [[ -f "$(env_file)" ]] && return 0
  if ! state="$(container_status)" || [[ "$state" != absent ]]; then
    cat >&2 <<EOF
page: the new profile $profile of $PAGE is kept as it is: page-browser-$PAGE is ${state:-unreadable}, its files $(page_dir) and the volumes pb-profile-$profile and pb-buffer-$profile stay.
page: once \`docker inspect page-browser-$PAGE\` says it is gone (docker rm -f page-browser-$PAGE after checking it), remove them:
page:   rm -rf $(page_dir) && docker volume rm pb-profile-$profile pb-buffer-$profile && $PB_BASE/egress-rules.sh apply
EOF
    return 0
  fi
  rm -rf "$(page_dir)"
  docker volume rm "pb-profile-$profile" "pb-buffer-$profile" >/dev/null 2>&1 || true
  echo "page: the new profile $profile of $PAGE was not kept (its volumes and files removed)" >&2
}

# A profile given up (Project Browser PR 16): its container removed, its
# files and both its volumes deleted. Hub forgets it first (the deploy
# script's remove-profile): a profile Hub still has is never removed here.
# The profile Hub forgot is named (--profile) and compared, under the
# server's lock, with the one the page's files name before anything goes:
# another operation may have given the page another profile since (Astra's
# review of PR 16, item 7).
remove_profile() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  [[ "$PROFILE" =~ ^[0-9a-f-]{36}$ ]] || fail "remove-profile needs --profile <uuid>: the profile Hub forgot"
  local profile
  profile="$(value PB_PROFILE_ID "$(env_file)")"
  [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "$PAGE names no profile"
  [[ "$profile" == "$PROFILE" ]] || fail "$PAGE's files name profile $profile, not $PROFILE: nothing removed"
  archive_browser remove_profile
  compose_with "$(env_file)" down >/dev/null 2>&1 || true
  # Gone means Docker says so (as forget): a state it cannot read is never
  # taken for absent.
  local state
  state="$(container_status)" || fail "page-browser-$PAGE cannot be read: nothing of $PAGE is removed"
  [[ "$state" == absent ]] || fail "page-browser-$PAGE is still there"
  rm -rf "$(page_dir)"
  "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the removed page" >&2
  docker volume rm "pb-profile-$profile" "pb-buffer-$profile" >/dev/null
  echo "page: $PAGE removed with its profile $profile (container, files, volumes)"
}

rollback() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  local current previous
  current="$(value PB_IMAGE "$(env_file)")"
  previous="$(value PB_PREVIOUS_IMAGE "$(env_file)")"
  [[ -n "$previous" ]] || fail "$PAGE has no previous image"
  docker image inspect "$previous" >/dev/null 2>&1 || fail "the previous image $previous is gone"
  compatible "$previous" "$(value PB_PROFILE_ID "$(env_file)")" || fail "rollback to $previous refused"
  device_ok "$previous" "$(value PB_SCREEN "$(env_file)")" "$(value PB_FONTS "$(env_file)")" \
    || fail "rollback to $previous refused: it would not show $PAGE's screen and fonts (up --screen 1920x1080 --fonts base first, if that is meant)"
  local next
  next="$(next_file)"
  (umask 077; sed -e "s|^PB_IMAGE=.*|PB_IMAGE=$previous|" -e "s|^PB_PREVIOUS_IMAGE=.*|PB_PREVIOUS_IMAGE=$current|" "$(env_file)" > "$next")
  switch_to "rollback to $previous"
}

down() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  archive_browser down
  compose_with "$(env_file)" down >/dev/null
  echo "page: page-browser-$PAGE removed; profile $(value PB_PROFILE_ID "$(env_file)") kept"
}

# A removed page's files go; its profile's volumes stay, free for another
# page (`up --profile`).
forget() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  local state
  state="$(container_status)" || fail "page-browser-$PAGE cannot be read: $PAGE is not forgotten"
  [[ "$state" == absent ]] || fail "page-browser-$PAGE still exists (down first)"
  local profile
  profile="$(value PB_PROFILE_ID "$(env_file)")"
  rm -rf "$(page_dir)"
  "$PB_BASE/egress-rules.sh" apply
  echo "page: $PAGE forgotten; profile $profile is free"
}

status() {
  local file name state
  for file in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$file" ]] || continue
    name="$(value PB_PAGE "$file")"
    [[ -z "$PAGE" || "$PAGE" == "$name" ]] || continue
    if ! state="$(docker inspect -f '{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "page-browser-$name" 2>&1)"; then
      grep -qiE 'no such (object|container)' <<<"$state" && state="absent" || state="unreadable"
    fi
    printf '%-24s page.env %-44s running: %s\n' "page-browser-$name" "$(value PB_IMAGE "$file")" "$state"
  done
}

# The operator's journals (plan §4.11; logs/journal.ts): JSON Lines on the
# page's buffer volume, a file per kind and UTC day (gzip once the day is
# over), each line with its instant (`at`). Read-only, here on the host: the
# lines of one kind from --since on, of a path that starts with --path, of
# --method — e.g. that `POST /api/v1/message/typing` never left, or which
# `POST /api/v1/message/ack` the operator let go (delivered marks) and which
# it refused (read marks). The journals hold no secrets (no tokens, cookies,
# headers, queries or bodies).
journal() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  [[ "$LOG_KIND" =~ ^(requests|connections|states|sockets)$ ]] || fail "--kind: requests, connections, states or sockets"
  [[ -z "$LOG_SINCE" || "$LOG_SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?$ ]] || fail "--since: a UTC date or instant (2026-10-14 or 2026-10-14T10:00:00Z)"
  [[ -z "$LOG_METHOD" || "$LOG_METHOD" =~ ^[A-Z]{3,7}$ ]] || fail "--method: GET, POST …"
  local profile mount file day
  profile="$(value PB_PROFILE_ID "$(env_file)")"
  [[ -n "$profile" ]] || fail "page $PAGE has no profile"
  mount="$(docker volume inspect -f '{{.Mountpoint}}' "pb-buffer-$profile")" || fail "no volume pb-buffer-$profile"
  for file in "$mount/logs/$LOG_KIND"-*.jsonl*; do
    [[ -f "$file" ]] || continue
    day="${file##*/"$LOG_KIND"-}"
    day="${day:0:10}"
    [[ -z "$LOG_SINCE" || ! "$day" < "${LOG_SINCE:0:10}" ]] || continue
    zcat -f -- "$file"
  done | awk -v since="$LOG_SINCE" -v path="$LOG_PATH" -v method="$LOG_METHOD" '
    function field(name) {
      if (match($0, "\"" name "\":\"[^\"]*\"")) return substr($0, RSTART + length(name) + 4, RLENGTH - length(name) - 5)
      return ""
    }
    {
      if (since != "" && field("at") < since) next
      if (path != "" && index(field("path"), path) != 1) next
      if (method != "" && field("method") != method) next
      print
    }'
}

# One page operation at a time on the server: a profile's owner is checked
# and claimed (its page's files written) under the same lock.
if [[ "$command" =~ ^(up|add-profile|remove-profile|rollback|down|forget)$ ]]; then
  exec 8>"$PB_BASE/.page.lock"
  flock -w 900 8 || fail "another page operation holds $PB_BASE/.page.lock"
  # Under the lock no switch is under way: a candidate left here is a dead
  # run's, and the host's rules must not admit it.
  rm -f "$PB_BASE"/pages/*/page.env.next
fi

case "$command" in
  up) up ;;
  add-profile) add_profile ;;
  remove-profile) remove_profile ;;
  rollback) rollback ;;
  down) down ;;
  forget) forget ;;
  status) status ;;
  log) journal ;;
  *) fail "usage: page.sh up|add-profile|remove-profile|rollback|down|forget|status|log [options]" ;;
esac
