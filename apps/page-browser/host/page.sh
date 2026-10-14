#!/usr/bin/env bash
# A page's browser container on the server (plan §3.1; stage 3, PR 2), run
# as root by scripts/deploy-page-browser.sh over SSH — the only way these
# containers are created, recreated and removed.
#
#   page.sh up --page <name> --image <tag> [--socks <host:port>]
#              [--profile <uuid> | --new-profile] [--tz <zone>] [--lang <tag>]
#              (a new page needs --socks and a profile; an existing one keeps
#              what it had unless told otherwise; --tz and --lang are only
#              Chrome's defaults until the engine's hello brings the page's
#              own environment)
#   page.sh rollback --page <name>
#   page.sh down --page <name>
#   page.sh forget --page <name>
#   page.sh status [--page <name>]
#
# A page's files: $PB_BASE/pages/<page>/page.env (the Compose variables:
# image and the previous one, profile, addresses, SOCKS5, zone, language)
# and secrets/ — vnc_password (the owner's screen) and rpc_token (the
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
# wrote (stage 1; plan §4.10): `up` and `rollback` refuse an image whose
# Chrome is older than the one that last opened the page's profile. The way
# back to an older Chrome is the profile's snapshot with it:
# page-browser-update.sh rollback (PR 18).
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --page) PAGE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --socks) SOCKS="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --new-profile) NEW_PROFILE=1; shift ;;
    --tz) TZ_ARG="$2"; shift 2 ;;
    --lang) LANG_ARG="$2"; shift 2 ;;
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

# Run the candidate state (page.env.next). The host's rules admit it before
# it starts — the page's current state and the candidate, both its own, until
# the switch ends; if they cannot be applied, nothing changes. Healthy: the
# candidate becomes page.env. Not: the previous state, if any, runs again,
# and this fails.
switch_to() {
  local what="$1" next
  next="$(next_file)"
  if ! "$PB_BASE/egress-rules.sh" apply; then
    rm -f "$next"
    fail "$what: the host's rules could not admit the new state; nothing changed"
  fi
  if compose_with "$next" up -d --force-recreate --no-build >/dev/null && healthy; then
    mv "$next" "$(env_file)"
    "$PB_BASE/egress-rules.sh" apply \
      || echo "page: warning: the host's rules still admit $PAGE's previous SOCKS5 too (run egress-rules.sh apply)" >&2
    echo "page: page-browser-$PAGE healthy on $(value PB_IMAGE "$(env_file)")"
    return 0
  fi
  if [[ -f "$(env_file)" ]]; then
    rm -f "$next"
    "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the failed state's SOCKS5" >&2
    compose_with "$(env_file)" up -d --force-recreate --no-build >/dev/null && healthy \
      && fail "$what failed; page-browser-$PAGE is back on $(value PB_IMAGE "$(env_file)")"
    fail "$what failed, and page-browser-$PAGE did not come back healthy on $(value PB_IMAGE "$(env_file)")"
  fi
  compose_with "$next" down >/dev/null 2>&1 || true
  rm -f "$next"
  "$PB_BASE/egress-rules.sh" apply || echo "page: warning: the host's rules still admit the removed page" >&2
  fail "$what failed; the new page was removed"
}

# Who else holds a profile: another page's files, or another container
# mounting its volume. Two Chromes on one profile would share its session
# and corrupt it.
profile_owner() {
  local profile="$1" file
  for file in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$file" && "$file" != "$(env_file)" ]] || continue
    [[ "$(value PB_PROFILE_ID "$file")" == "$profile" ]] && { value PB_PAGE "$file"; return 0; }
  done
  docker ps -a --filter "volume=pb-profile-$profile" --format '{{.Names}}' | grep -vx "page-browser-$PAGE" | head -n 1 || true
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

# Refuses <image> on <profile> when the profile was last opened by a newer
# Chrome than the image's. Read through a container of the image itself,
# with no network: the profile is Chrome's user's alone.
refuse_downgrade() {
  local image="$1" profile="$2" label image_chrome profile_chrome
  label="$(docker image inspect --format '{{ index .Config.Labels "agency-hub.page-browser.chrome-version" }}' "$image" 2>/dev/null)" \
    || fail "the image $image cannot be read"
  image_chrome="$(chrome_of "$label" || true)"
  if [[ -z "$image_chrome" ]]; then
    image_chrome="$(chrome_of "$(docker run --rm --network none --entrypoint /usr/bin/google-chrome-stable "$image" --version 2>/dev/null)" || true)"
  fi
  [[ -n "$image_chrome" ]] || fail "the Chrome of $image cannot be read"
  profile_chrome="$(docker run --rm --network none --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges --user 0 \
    --entrypoint sh -v "pb-profile-$profile:/profile:ro" "$image" -c '
      if [ -f "/profile/Last Version" ]; then head -c 64 "/profile/Last Version"
      elif [ -f /profile/Default/Preferences ]; then grep -o "\"last_chrome_version\":\"[0-9.]*\"" /profile/Default/Preferences | head -n 1
      fi' pb-helper version)" || fail "the profile $profile cannot be read"
  profile_chrome="$(chrome_of "$profile_chrome" || true)"
  if [[ -n "$profile_chrome" ]] && ver_gt "$profile_chrome" "$image_chrome"; then
    fail "$image has Chrome $image_chrome, but the profile $profile was last opened by Chrome $profile_chrome: Chrome never opens a profile a newer one wrote (page-browser-update.sh rollback restores its snapshot)"
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
    profile="$(cat /proc/sys/kernel/random/uuid)"
  else
    profile="${PROFILE:-$(value PB_PROFILE_ID "$old")}"
    [[ -n "$profile" ]] || fail "a new page needs --profile <uuid> or --new-profile"
    [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "--profile: a UUID"
    docker volume inspect "pb-profile-$profile" "pb-buffer-$profile" >/dev/null 2>&1 || fail "no volumes of profile $profile"
    local owner
    owner="$(profile_owner "$profile")"
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

  if [[ "$NEW_PROFILE" == 1 ]]; then
    docker volume create "pb-profile-$profile" >/dev/null
    docker volume create "pb-buffer-$profile" >/dev/null
  else
    refuse_downgrade "$IMAGE" "$profile"
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
PB_SECCOMP_PROFILE=$PB_BASE/security/seccomp-chrome.json
PB_APPARMOR_PROFILE=${PB_APPARMOR_PROFILE:-page-browser}
PB_SECRETS_DIR=$dir/secrets
EOF
  chmod 600 "$next"
  # A new page's addresses are in the host's rules only once it is healthy:
  # until then the host lets it reach nothing.
  switch_to "up $IMAGE"
}

rollback() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  local current previous
  current="$(value PB_IMAGE "$(env_file)")"
  previous="$(value PB_PREVIOUS_IMAGE "$(env_file)")"
  [[ -n "$previous" ]] || fail "$PAGE has no previous image"
  docker image inspect "$previous" >/dev/null 2>&1 || fail "the previous image $previous is gone"
  refuse_downgrade "$previous" "$(value PB_PROFILE_ID "$(env_file)")"
  local next
  next="$(next_file)"
  (umask 077; sed -e "s|^PB_IMAGE=.*|PB_IMAGE=$previous|" -e "s|^PB_PREVIOUS_IMAGE=.*|PB_PREVIOUS_IMAGE=$current|" "$(env_file)" > "$next")
  switch_to "rollback to $previous"
}

down() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  compose_with "$(env_file)" down >/dev/null
  echo "page: page-browser-$PAGE removed; profile $(value PB_PROFILE_ID "$(env_file)") kept"
}

# A removed page's files go; its profile's volumes stay, free for another
# page (`up --profile`).
forget() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  ! docker inspect "page-browser-$PAGE" >/dev/null 2>&1 || fail "page-browser-$PAGE still exists (down first)"
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
    state="$(docker inspect -f '{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "page-browser-$name" 2>/dev/null)" || state="absent"
    printf '%-24s page.env %-44s running: %s\n' "page-browser-$name" "$(value PB_IMAGE "$file")" "$state"
  done
}

# One page operation at a time on the server: a profile's owner is checked
# and claimed (its page's files written) under the same lock.
if [[ "$command" =~ ^(up|rollback|down|forget)$ ]]; then
  exec 8>"$PB_BASE/.page.lock"
  flock -w 900 8 || fail "another page operation holds $PB_BASE/.page.lock"
  # Under the lock no switch is under way: a candidate left here is a dead
  # run's, and the host's rules must not admit it.
  rm -f "$PB_BASE"/pages/*/page.env.next
fi

case "$command" in
  up) up ;;
  rollback) rollback ;;
  down) down ;;
  forget) forget ;;
  status) status ;;
  *) fail "usage: page.sh up|rollback|down|forget|status [options]" ;;
esac
