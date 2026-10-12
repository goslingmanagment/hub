#!/usr/bin/env bash
# A page's browser container on the server (plan §3.1; stage 3, PR 2), run
# as root by scripts/deploy-page-browser.sh over SSH — the only way these
# containers are created, recreated and removed.
#
#   page.sh up --page <name> --image <tag> --socks <host:port>
#              [--profile <uuid> | --new-profile] [--tz <zone>] [--lang <tag>]
#   page.sh rollback --page <name>
#   page.sh down --page <name>
#   page.sh status [--page <name>]
#
# A page's files: $PB_BASE/pages/<page>/page.env (the Compose variables:
# image and the previous one, profile, addresses, SOCKS5, zone, language)
# and secrets/vnc_password (the owner's screen, made here once, root's
# only). Its addresses in pb-control and pb-egress end in the same octet,
# chosen once. The profile's volumes outlive the container: `down` keeps
# them, and `up --profile` gives an existing profile to a page.
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
value() {
  [[ -f "$2" ]] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1
}
compose() { docker compose -p "page-browser-$PAGE" -f "$COMPOSE_FILE" --env-file "$(env_file)" "$@"; }

wait_healthy() {
  local container="page-browser-$PAGE" health=""
  for _ in $(seq 1 "$HEALTH_WAIT_S"); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$health" == "starting" || -z "$health" ]] || break
    sleep 1
  done
  if [[ "$health" != "healthy" ]]; then
    docker logs --tail 60 "$container" 2>&1 | grep -E 'init-net|net-selftest|s6-rc|rc.init' >&2 || true
    fail "$container is ${health:-missing}"
  fi
  docker exec "$container" grep -q '"ok":true' /run/pb/net-selftest.json || fail "$container: the kernel check did not pass"
  echo "page: $container healthy, kernel check passed"
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
  [[ "$SOCKS" =~ ^([A-Za-z0-9.-]+):([0-9]{1,5})$ ]] || fail "--socks: <host>:<port>"
  local socks_host="${BASH_REMATCH[1]}" socks_port="${BASH_REMATCH[2]}" socks_ip
  socks_ip="$(getent ahostsv4 "$socks_host" | awk 'NR == 1 { print $1 }')"
  [[ "$socks_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "cannot resolve $socks_host"

  local dir old="" profile octet previous="" time_zone lang
  dir="$(page_dir)"
  [[ -f "$(env_file)" ]] && old="$(env_file)"
  if [[ "$NEW_PROFILE" == 1 ]]; then
    [[ -z "$PROFILE" ]] || fail "--profile and --new-profile together"
    profile="$(cat /proc/sys/kernel/random/uuid)"
  else
    profile="${PROFILE:-$(value PB_PROFILE_ID "$old")}"
    [[ -n "$profile" ]] || fail "a new page needs --profile <uuid> or --new-profile"
    [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "--profile: a UUID"
    docker volume inspect "pb-profile-$profile" "pb-buffer-$profile" >/dev/null 2>&1 || fail "no volumes of profile $profile"
  fi
  octet="$(value PB_EGRESS_IP "$old" | sed -n "s/^$EGRESS_PREFIX\.//p")"
  [[ -n "$octet" ]] || octet="$(free_octet)"
  previous="$(value PB_IMAGE "$old")"
  [[ "$previous" == "$IMAGE" ]] && previous="$(value PB_PREVIOUS_IMAGE "$old")"
  time_zone="${TZ_ARG:-$(value PB_TZ "$old")}"
  lang="${LANG_ARG:-$(value PB_LANG "$old")}"
  [[ "${time_zone:-UTC}" =~ ^[A-Za-z0-9_+/-]{1,64}$ ]] || fail "--tz: a zone name"
  [[ "${lang:-en-US}" =~ ^[a-z]{2,3}(-[A-Z]{2})?$ ]] || fail "--lang: a language tag"

  if [[ "$NEW_PROFILE" == 1 ]]; then
    docker volume create "pb-profile-$profile" >/dev/null
    docker volume create "pb-buffer-$profile" >/dev/null
  fi
  install -d -m 700 "$dir" "$dir/secrets"
  if [[ ! -s "$dir/secrets/vnc_password" ]]; then
    (umask 077; openssl rand -hex 24 > "$dir/secrets/vnc_password")
  fi
  local next
  next="$(mktemp "$dir/page.env.XXXXXX")"
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
  mv "$next" "$(env_file)"
  # The host's rules first: the new container is never out without them.
  "$PB_BASE/egress-rules.sh" apply
  compose up -d --force-recreate --no-build >/dev/null
  wait_healthy
}

rollback() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  local current previous
  current="$(value PB_IMAGE "$(env_file)")"
  previous="$(value PB_PREVIOUS_IMAGE "$(env_file)")"
  [[ -n "$previous" ]] || fail "$PAGE has no previous image"
  docker image inspect "$previous" >/dev/null 2>&1 || fail "the previous image $previous is gone"
  local next
  next="$(mktemp "$(page_dir)/page.env.XXXXXX")"
  sed -e "s|^PB_IMAGE=.*|PB_IMAGE=$previous|" -e "s|^PB_PREVIOUS_IMAGE=.*|PB_PREVIOUS_IMAGE=$current|" "$(env_file)" > "$next"
  chmod 600 "$next"
  mv "$next" "$(env_file)"
  compose up -d --force-recreate --no-build >/dev/null
  wait_healthy
  echo "page: $PAGE back on $previous (was $current)"
}

down() {
  [[ -n "$PAGE" && -f "$(env_file)" ]] || fail "no page $PAGE"
  compose down >/dev/null
  echo "page: page-browser-$PAGE removed; profile $(value PB_PROFILE_ID "$(env_file)") kept"
}

status() {
  local file name state
  for file in "$PB_BASE"/pages/*/page.env; do
    [[ -f "$file" ]] || continue
    name="$(value PB_PAGE "$file")"
    [[ -z "$PAGE" || "$PAGE" == "$name" ]] || continue
    state="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "page-browser-$name" 2>/dev/null)" || state=absent
    printf '%-24s %-48s %s\n' "page-browser-$name" "$(value PB_IMAGE "$file")" "$state"
  done
}

case "$command" in
  up) up ;;
  rollback) rollback ;;
  down) down ;;
  status) status ;;
  *) fail "usage: page.sh up|rollback|down|status [options]" ;;
esac
