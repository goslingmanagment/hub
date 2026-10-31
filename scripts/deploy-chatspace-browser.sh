#!/usr/bin/env bash
set -euo pipefail

# The always-on ChatSpace tab on the server (apps/chatspace-browser/README.md).
# Run from the workstation over SSH, like deploy-page-browser.sh: a Hub
# deploy never touches this container, and this script never touches Hub's
# stack or the page browsers.
#
# macOS bsdtar would add AppleDouble sidecar files to the upload.
export COPYFILE_DISABLE=1

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-chatspace-browser.sh host    <user@host>
  scripts/deploy-chatspace-browser.sh build   <user@host> [--firefox <version>]
  scripts/deploy-chatspace-browser.sh up      <user@host> [--image <tag>]
  scripts/deploy-chatspace-browser.sh status  <user@host>
  scripts/deploy-chatspace-browser.sh restart-firefox <user@host>
  scripts/deploy-chatspace-browser.sh rollback <user@host>
  scripts/deploy-chatspace-browser.sh down    <user@host>
  scripts/deploy-chatspace-browser.sh tunnel  <user@host>

  host      Prepares the server, again after any change to its files: the
            Compose file under /opt/agency-hub/chatspace-browser, the network
            csb-egress, the profile volume csb-profile, the owner's screen
            password (made once, root's only) and its copy for Hub's API in
            /opt/agency-hub/.env.production (CHATSPACE_BROWSER_SCREEN_PASSWORD,
            a backup of the file first; the api reads it at its next
            recreate, a Hub deploy). Needs the page browsers' host files
            (deploy-page-browser.sh host): their seccomp and AppArmor
            profiles and pb-control.
  build     Builds hub-chatspace-browser:<Firefox ESR version>-<commit> on the
            server from this checkout's HEAD (committed files only; a clean
            commit of origin/main whose CI passed, scripts/main-ci-gate.sh)
            with the page browsers' KasmVNC and s6-overlay on the server,
            checked against vendor.sha256. --firefox: that firefox-esr
            version of Mozilla's repository (default: its newest).
  up        Creates or recreates the container on --image (default: the last
            built), with the extension's XPI the update feed names now (the
            extension updates itself after that). The image it replaces
            stays the previous one. Waits for it to be healthy; the profile
            (the OnlyMonster session, the hub sign-in) is on its volume and
            survives every recreate.
  status    The container, its image and health, Firefox, the extension's
            version, the watchdog's last restarts, memory.
  restart-firefox
            Firefox only, through s6: it comes back on ChatSpace's Accounts
            Overview, logged in as it was.
  rollback  Back to the previous image.
  down      Removes the container; the profile volume stays.
  tunnel    Prints the SSH tunnel to the screen, the way in when Hub's API
            is down (the screen's password is on the server, root's only).

Options: --identity <path>, --ssh-port <port>.
EOF
}

log() {
  printf '[chatspace-browser] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}
fail() {
  log "error: $*"
  exit 1
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The deploy gate: only a commit of main whose CI passed (owner, 2026-10-18).
# shellcheck source=./scripts/main-ci-gate.sh
source "${ROOT_DIR}/scripts/main-ci-gate.sh"
APP_DIR="apps/chatspace-browser"
REMOTE_BASE=/opt/agency-hub/chatspace-browser
# The page browsers' KasmVNC and s6-overlay, kept on the server by their build.
REMOTE_VENDOR=/opt/agency-hub/page-browser/vendor
CONTROL_IP=10.230.0.253
EGRESS_SUBNET=10.231.0.0/24
FEED_URL=https://ext.gosling-agency.ru/chat-extension/firefox/updates.json
EXTENSION_ID=chat-extension@gosling.agency

COMMAND="${1:-}"
REMOTE="${2:-}"
[[ "$COMMAND" == "-h" || "$COMMAND" == "--help" || -z "$COMMAND" ]] && { usage; exit 0; }
[[ -n "$REMOTE" ]] || { usage; exit 2; }
shift 2
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=15)
IMAGE=""
FIREFOX_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) SSH_ARGS+=(-i "$2"); shift 2 ;;
    --ssh-port) SSH_ARGS+=(-p "$2"); shift 2 ;;
    --image) [[ $# -ge 2 ]] || fail "$1 needs a value"; IMAGE="$2"; shift 2 ;;
    --firefox) [[ $# -ge 2 ]] || fail "$1 needs a value"; FIREFOX_VERSION="$2"; shift 2 ;;
    *) fail "unexpected argument $1" ;;
  esac
done
[[ -z "$IMAGE" || "$IMAGE" =~ ^hub-chatspace-browser:[A-Za-z0-9._~-]+$ ]] || fail "--image is not a hub-chatspace-browser tag"
[[ -z "$FIREFOX_VERSION" || "$FIREFOX_VERSION" =~ ^[0-9][0-9.]*esr~build[0-9]+$ ]] || fail "--firefox is not a firefox-esr version (e.g. 153.6.0esr~build2)"

run_remote() {
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "$1")"
}

# The remote side's helpers, ahead of every command that changes the container.
REMOTE_LIB="$(cat <<EOF
set -euo pipefail
BASE=${REMOTE_BASE}
ENV_FILE=\$BASE/browser.env
compose() { docker compose -p chatspace-browser -f \$BASE/docker-compose.chatspace-browser.yml --env-file \$ENV_FILE "\$@"; }
value() { sed -n "s/^\$1=//p" "\$ENV_FILE" 2>/dev/null | tail -n 1; }
# The extension's newest XPI, as the update feed names it now.
feed_xpi() {
  curl -fsS --max-time 20 ${FEED_URL} | node -e '
    let input = ""; process.stdin.on("data", (c) => (input += c)).on("end", () => {
      const updates = JSON.parse(input).addons?.["${EXTENSION_ID}"]?.updates ?? [];
      const link = updates.at(-1)?.update_link ?? "";
      if (!/^https:\/\/ext\.gosling-agency\.ru\/chat-extension\/firefox\/[A-Za-z0-9._-]+\.xpi$/.test(link)) process.exit(1);
      console.log(link);
    });'
}
healthy() {
  local health=""
  for _ in \$(seq 1 150); do
    health="\$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' chatspace-browser 2>/dev/null || true)"
    [[ "\$health" == starting || -z "\$health" ]] || break
    sleep 1
  done
  if [[ "\$health" != healthy ]]; then
    docker logs --tail 40 chatspace-browser 2>&1 >&2 || true
    echo "chatspace-browser is \${health:-missing}" >&2
    return 1
  fi
}
# Writes the env file for an image: the feed's XPI now, the image replaced.
write_env() {
  local image=\$1 previous=\$2 xpi
  xpi="\$(feed_xpi)" || { echo "the extension's update feed cannot be read" >&2; return 1; }
  umask 077
  printf 'CSB_IMAGE=%s\nCSB_PREVIOUS_IMAGE=%s\nCSB_EXTENSION_URL=%s\nCSB_CONTROL_IP=${CONTROL_IP}\n' "\$image" "\$previous" "\$xpi" > "\$ENV_FILE.next"
  mv -f "\$ENV_FILE.next" "\$ENV_FILE"
}
EOF
)"

host() {
  log "installing the host files on ${REMOTE}"
  (cd "$ROOT_DIR" && tar -cf - docker-compose.chatspace-browser.yml) \
    | ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "${REMOTE_LIB}
    staging=\$(mktemp -d)
    trap 'rm -rf \"\$staging\"' EXIT
    tar -xf - -C \"\$staging\"
    [[ -f /opt/agency-hub/page-browser/security/seccomp-chrome.json ]] && grep -q '^page-browser ' /sys/kernel/security/apparmor/profiles \\
      && docker network inspect pb-control >/dev/null 2>&1 \\
      || { echo 'the page browsers host files are missing: run deploy-page-browser.sh host first' >&2; exit 1; }
    install -d -m 755 \$BASE
    install -d -m 700 \$BASE/secrets \$BASE/build
    install -m 644 \"\$staging/docker-compose.chatspace-browser.yml\" \$BASE/docker-compose.chatspace-browser.yml
    if docker network inspect csb-egress >/dev/null 2>&1; then
      [[ \"\$(docker network inspect csb-egress --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')\" == ${EGRESS_SUBNET} ]] \\
        || { echo 'csb-egress exists with another subnet' >&2; exit 1; }
    else
      docker network create --driver bridge --subnet ${EGRESS_SUBNET} --ipv6=false -o com.docker.network.bridge.enable_icc=false csb-egress >/dev/null
    fi
    docker volume inspect csb-profile >/dev/null 2>&1 || docker volume create csb-profile >/dev/null
    if [[ ! -s \$BASE/secrets/vnc_password ]]; then
      (umask 077; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 > \$BASE/secrets/vnc_password)
    fi
    chmod 600 \$BASE/secrets/vnc_password
    # The API's copy, for the owner's screen in the dashboard.
    production=/opt/agency-hub/.env.production
    password=\$(cat \$BASE/secrets/vnc_password)
    current=\$(sed -n 's/^CHATSPACE_BROWSER_SCREEN_PASSWORD=//p' \$production | tail -n 1)
    if [[ -z \"\$current\" ]]; then
      cp -p \$production \$production.bak-\$(date +%Y%m%d)-chatspace-browser
      printf '\\n# The always-on ChatSpace tab: its screen password (scripts/deploy-chatspace-browser.sh host).\\nCHATSPACE_BROWSER_SCREEN_PASSWORD=%s\\n' \"\$password\" >> \$production
      echo 'the screen password added to .env.production: the api reads it at the next Hub deploy'
    elif [[ \"\$current\" != \"\$password\" ]]; then
      echo 'CHATSPACE_BROWSER_SCREEN_PASSWORD in .env.production is not the screen password: fix one of them by hand' >&2
      exit 1
    fi
    unset password current
    echo \"host ready: \$BASE, network csb-egress (${EGRESS_SUBNET}), volume csb-profile, the screen at ${CONTROL_IP}:6901 in pb-control\"")"
}

build() {
  local revision tag version
  git -C "$ROOT_DIR" diff --quiet HEAD -- "$APP_DIR" || fail "$APP_DIR has uncommitted changes: the image is built from HEAD"
  require_green_main_ci "$ROOT_DIR" || fail "build refused: HEAD is not a clean commit of main with a green Quality Gate (see [ci-gate] above)"
  revision="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
  if [[ -z "$FIREFOX_VERSION" ]]; then
    FIREFOX_VERSION="$(run_remote "curl -fsS --max-time 60 https://packages.mozilla.org/apt/dists/mozilla/main/binary-amd64/Packages \
      | awk '/^Package: /{p=\$2} /^Version: /{if (p == \"firefox-esr\") print \$2}' | sort -V | tail -n 1")" \
      || fail "the newest firefox-esr of Mozilla's repository cannot be read"
    [[ "$FIREFOX_VERSION" =~ ^[0-9][0-9.]*esr~build[0-9]+$ ]] || fail "Mozilla's repository names no firefox-esr version"
  fi
  version="${FIREFOX_VERSION%%esr*}"
  tag="hub-chatspace-browser:${version}-${revision}"
  local context
  context="$(mktemp -d)"
  trap 'rm -rf "$context"' RETURN
  git -C "$ROOT_DIR" archive --format=tar --prefix=context/ "HEAD:$APP_DIR" >"$context/context.tar"
  log "building $tag (firefox-esr $FIREFOX_VERSION) on ${REMOTE}"
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "set -euo pipefail
    dir=${REMOTE_BASE}/build/${revision}
    rm -rf \"\$dir\"
    install -d -m 700 \"\$dir\" \"\$dir/vendor\"
    tar -xf - -C \"\$dir\"
    cp ${REMOTE_VENDOR}/kasmvncserver_bookworm_* ${REMOTE_VENDOR}/s6-overlay-* \"\$dir/vendor/\"
    docker build --build-context vendor=\"\$dir/vendor\" --build-arg FIREFOX_VERSION=${FIREFOX_VERSION} \
      --label agency-hub.chatspace-browser.revision=${revision} --label agency-hub.chatspace-browser.firefox=${FIREFOX_VERSION} \
      -t ${tag} \"\$dir/context\"
    printf '%s\\n' ${tag} > ${REMOTE_BASE}/build/LATEST
    rm -rf \"\$dir\"")" <"$context/context.tar" || fail "the build failed"
  log "built $tag"
  printf '%s\n' "$tag"
}

up() {
  run_remote "${REMOTE_LIB}
    image=$(printf '%q' "$IMAGE")
    [[ -n \"\$image\" ]] || image=\$(cat \$BASE/build/LATEST 2>/dev/null || true)
    [[ -n \"\$image\" ]] || { echo 'no image: build one first' >&2; exit 1; }
    docker image inspect \"\$image\" >/dev/null 2>&1 || { echo \"no image \$image on the server\" >&2; exit 1; }
    [[ -s \$BASE/secrets/vnc_password ]] || { echo 'no screen password: run host first' >&2; exit 1; }
    current=\$(value CSB_IMAGE)
    previous=\$(value CSB_PREVIOUS_IMAGE)
    [[ \"\$current\" == \"\$image\" ]] || previous=\$current
    write_env \"\$image\" \"\$previous\"
    compose up -d --force-recreate --remove-orphans
    healthy
    echo \"chatspace-browser healthy on \$image, the extension from \$(value CSB_EXTENSION_URL | sed 's#.*/##')\""
}

rollback() {
  run_remote "${REMOTE_LIB}
    previous=\$(value CSB_PREVIOUS_IMAGE)
    [[ -n \"\$previous\" ]] || { echo 'no previous image' >&2; exit 1; }
    write_env \"\$previous\" \"\$(value CSB_IMAGE)\"
    compose up -d --force-recreate --remove-orphans
    healthy
    echo \"chatspace-browser back on \$previous\""
}

down() {
  run_remote "${REMOTE_LIB}
    compose down
    echo 'chatspace-browser removed; the profile volume csb-profile stays'"
}

status() {
  run_remote "set -euo pipefail
    docker inspect -f 'container: {{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} since {{.State.StartedAt}}, image {{.Config.Image}}' chatspace-browser 2>/dev/null \\
      || { echo 'no container chatspace-browser'; exit 0; }
    docker exec chatspace-browser sh -c 'firefox-esr --version 2>/dev/null; /command/s6-svstat /run/service/firefox; cat /run/csb/watchdog.json 2>/dev/null || echo \"(no watchdog state yet)\"'
    docker stats --no-stream --format 'memory {{.MemUsage}}, cpu {{.CPUPerc}}' chatspace-browser"
}

restart_firefox() {
  run_remote "docker exec chatspace-browser /command/s6-svc -r /run/service/firefox && echo 'Firefox restarted: back on the Accounts Overview in a few seconds'"
}

tunnel() {
  local host="${REMOTE#*@}"
  cat <<EOF
The screen without Hub's API (the owner only):
  ssh -N -L 16901:${CONTROL_IP}:6901 ${REMOTE}
then http://localhost:16901 — user "owner", the password:
  ssh ${REMOTE} cat ${REMOTE_BASE}/secrets/vnc_password
(${host}: the address is the container's in pb-control; nothing is published.)
EOF
}

case "$COMMAND" in
  host) host ;;
  build) build ;;
  up) up ;;
  status) status ;;
  restart-firefox) restart_firefox ;;
  rollback) rollback ;;
  down) down ;;
  tunnel) tunnel ;;
  *) usage; exit 2 ;;
esac
