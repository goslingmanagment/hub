#!/usr/bin/env bash
set -euo pipefail

# Project Browser — the page browsers on the server (plan §3.1; stage 3,
# PR 2). Run from the workstation over SSH, like the Hub deploy; Hub's
# containers have no Docker access and need none. A Hub deploy never touches
# the page browsers, and this script never touches Hub's stack.
#
# macOS bsdtar would add AppleDouble sidecar files to the upload.
export COPYFILE_DISABLE=1

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-page-browser.sh host     <user@host>
  scripts/deploy-page-browser.sh build    <user@host>
  scripts/deploy-page-browser.sh up       <user@host> --page <name> --image <tag> [--socks <host:port>]
                                          [--profile <uuid> | --new-profile] [--tz <zone>] [--lang <tag>]
  scripts/deploy-page-browser.sh rollback <user@host> --page <name>
  scripts/deploy-page-browser.sh down     <user@host> --page <name>
  scripts/deploy-page-browser.sh to-node  <user@host> --page <name> [--prepare] [--hub-dir <dir>]
  scripts/deploy-page-browser.sh status   <user@host> [--page <name>]
  scripts/deploy-page-browser.sh chrome   <user@host> <check|build|update|rollout|resume|rollback|snapshot|status|prune> [options]

  host      Prepares the server, again after any change to its files: the
            networks pb-control (internal) and pb-egress (no traffic between
            its containers), the seccomp profile, the AppArmor profile
            `page-browser`, the host's egress rules and their boot unit,
            the Compose file and page.sh under /opt/agency-hub/page-browser;
            the Chrome update (page-browser-update.sh, its profile check,
            Google's signing key, the timer's units — the timer installed,
            not enabled: `systemctl enable --now page-browser-update.timer`
            is the owner's step).
            Loads br_netfilter (and at every boot): from then on traffic
            inside every Docker bridge passes iptables, where Docker's own
            rules accept it — the page rules need it, and Docker loads it
            for pb-egress anyway.
  build     Builds hub-page-browser:<Chrome version>-<commit> on the server
            from this checkout's HEAD (committed files only) and the vendor
            cache (PB_VENDOR_CACHE, default ~/code/.cache/page-browser:
            chrome/, kasmvnc/, s6-overlay/), checked against vendor.sha256.
            Chrome's .deb is ~120 MB: around a VPN see the deploy notes.
            The server keeps the build context (build/context/<commit>.tar),
            KasmVNC and s6-overlay (vendor/) and the .deb (chrome/): the
            update timer builds the next Chrome on the same commit.
  up        Creates or recreates a page's container; the image it replaces
            stays the page's previous one.
  rollback  Back to the page's previous image.
  down      Removes the container; the profile's volumes stay.
  to-node   Takes the page off its browser for good when its operator cannot
            confirm the leave: removes the container, checks it is gone, then
            tells the Hub (`sync page transport <page> node --browser-stopped`,
            in the api container under --hub-dir, default /opt/agency-hub),
            audited. Node takes the page; what the browser's buffer kept is
            marked not drained. --prepare: the page has no Node session (it
            was connected through its browser) — the owner's session follows.
  status    The page containers, their images and health.
  chrome    A new Chrome for the pages (PR 18): runs the server's
            page-browser-update.sh with the arguments as given (its own
            usage: --help) — e.g. `chrome <host> update --page lilly-1
            --image hub-page-browser:<tag> --detach`. The server's timer
            (page-browser-update.timer, installed by `host`, enabled by the
            owner) only looks, fetches, builds and proposes.

Options: --identity <path>, --ssh-port <port>. Any other option goes to
page.sh on the server (see apps/page-browser/host/page.sh).
EOF
}

log() {
  printf '[page-browser] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}
fail() {
  log "error: $*"
  exit 1
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="apps/page-browser"
REMOTE_BASE=/opt/agency-hub/page-browser
VENDOR_CACHE="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"

COMMAND="${1:-}"
REMOTE="${2:-}"
[[ "$COMMAND" == "-h" || "$COMMAND" == "--help" || -z "$COMMAND" ]] && { usage; exit 0; }
[[ -n "$REMOTE" ]] || { usage; exit 2; }
shift 2
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=15)
# `chrome`: everything after the host goes to page-browser-update.sh as it
# is (but --identity and --ssh-port, which are this script's).
CHROME_ARGS=()
if [[ "$COMMAND" == chrome ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --identity) SSH_ARGS+=(-i "$2"); shift 2 ;;
      --ssh-port) SSH_ARGS+=(-p "$2"); shift 2 ;;
      *) CHROME_ARGS+=("$1"); shift ;;
    esac
  done
fi
PAGE_ARGS=()
PAGE_NAME=""
TO_NODE_PREPARE=0
HUB_DIR=/opt/agency-hub
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) SSH_ARGS+=(-i "$2"); shift 2 ;;
    --ssh-port) SSH_ARGS+=(-p "$2"); shift 2 ;;
    --prepare) TO_NODE_PREPARE=1; shift ;;
    --hub-dir) [[ $# -ge 2 ]] || fail "$1 needs a value"; HUB_DIR="$2"; shift 2 ;;
    --page) [[ $# -ge 2 ]] || fail "$1 needs a value"; PAGE_NAME="$2"; PAGE_ARGS+=("$1" "$2"); shift 2 ;;
    --new-profile) PAGE_ARGS+=("$1"); shift ;;
    --*) [[ $# -ge 2 ]] || fail "$1 needs a value"; PAGE_ARGS+=("$1" "$2"); shift 2 ;;
    *) fail "unexpected argument $1" ;;
  esac
done

run_remote() {
  ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "$1")"
}

# Every page.sh call: its arguments quoted one by one.
page_remote() {
  local quoted="" arg
  for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
  run_remote "set -euo pipefail; ${REMOTE_BASE}/page.sh${quoted}"
}

host() {
  log "installing the host files on ${REMOTE}"
  (
    cd "$ROOT_DIR"
    tar -cf - \
      docker-compose.page-browser.yml \
      "$APP_DIR/security/seccomp-chrome.json" \
      "$APP_DIR/security/apparmor-page-browser" \
      "$APP_DIR/host/egress-rules.sh" \
      "$APP_DIR/host/page.sh" \
      "$APP_DIR/host/page-browser-egress.service" \
      scripts/page-browser-update.sh \
      "$APP_DIR/host/profile-check.mjs" \
      "$APP_DIR/host/google-linux-signing-key.asc" \
      "$APP_DIR/host/page-browser-update.service" \
      "$APP_DIR/host/page-browser-update.timer"
  ) | ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "set -euo pipefail
    staging=\$(mktemp -d)
    trap 'rm -rf \"\$staging\"' EXIT
    tar -xf - -C \"\$staging\"
    install -d -m 755 ${REMOTE_BASE} ${REMOTE_BASE}/security
    install -d -m 700 ${REMOTE_BASE}/pages
    install -m 644 \"\$staging/docker-compose.page-browser.yml\" ${REMOTE_BASE}/docker-compose.page-browser.yml
    install -m 644 \"\$staging/${APP_DIR}/security/seccomp-chrome.json\" ${REMOTE_BASE}/security/seccomp-chrome.json
    install -m 755 \"\$staging/${APP_DIR}/host/egress-rules.sh\" ${REMOTE_BASE}/egress-rules.sh
    install -m 755 \"\$staging/${APP_DIR}/host/page.sh\" ${REMOTE_BASE}/page.sh
    install -d -m 700 ${REMOTE_BASE}/update ${REMOTE_BASE}/snapshots ${REMOTE_BASE}/build ${REMOTE_BASE}/build/context ${REMOTE_BASE}/vendor
    install -d -m 755 ${REMOTE_BASE}/chrome
    install -m 755 \"\$staging/scripts/page-browser-update.sh\" ${REMOTE_BASE}/page-browser-update.sh
    install -m 644 \"\$staging/${APP_DIR}/host/profile-check.mjs\" ${REMOTE_BASE}/profile-check.mjs
    install -m 644 \"\$staging/${APP_DIR}/host/google-linux-signing-key.asc\" ${REMOTE_BASE}/google-linux-signing-key.asc
    install -m 644 \"\$staging/${APP_DIR}/security/apparmor-page-browser\" /etc/apparmor.d/page-browser
    apparmor_parser -r -W /etc/apparmor.d/page-browser
    modprobe br_netfilter
    printf 'br_netfilter\\n' > /etc/modules-load.d/page-browser.conf
    printf 'net.bridge.bridge-nf-call-iptables = 1\\n' > /etc/sysctl.d/90-page-browser.conf
    sysctl -q -w net.bridge.bridge-nf-call-iptables=1
    network() {
      local name=\$1 subnet=\$2; shift 2
      if docker network inspect \"\$name\" >/dev/null 2>&1; then
        [[ \"\$(docker network inspect \"\$name\" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')\" == \"\$subnet\" ]] \\
          || { echo \"\$name exists with another subnet\" >&2; exit 1; }
      else
        docker network create --driver bridge --subnet \"\$subnet\" --ipv6=false \"\$@\" \"\$name\" >/dev/null
      fi
    }
    network pb-control 10.230.0.0/24 --internal
    network pb-egress 10.230.1.0/24 -o com.docker.network.bridge.enable_icc=false
    install -m 644 \"\$staging/${APP_DIR}/host/page-browser-egress.service\" /etc/systemd/system/page-browser-egress.service
    # The Chrome update's timer: installed here, enabled only by the owner.
    install -m 644 \"\$staging/${APP_DIR}/host/page-browser-update.service\" /etc/systemd/system/page-browser-update.service
    install -m 644 \"\$staging/${APP_DIR}/host/page-browser-update.timer\" /etc/systemd/system/page-browser-update.timer
    systemctl daemon-reload
    systemctl enable page-browser-egress.service >/dev/null 2>&1
    ${REMOTE_BASE}/egress-rules.sh apply
    echo \"host ready: AppArmor \$(cat /sys/kernel/security/apparmor/profiles | grep -c '^page-browser ') profile, networks pb-control and pb-egress\"
    echo \"Chrome update timer: \$(systemctl is-enabled page-browser-update.timer 2>/dev/null || true) (the owner enables it: systemctl enable --now page-browser-update.timer)\"")"
}

build() {
  local revision chrome_version kasm_version arch deb_arch s6_arch tag files=() file
  git -C "$ROOT_DIR" diff --quiet HEAD -- "$APP_DIR" || fail "$APP_DIR has uncommitted changes: the image is built from HEAD"
  revision="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
  chrome_version="$(sed -n 's/^ARG CHROME_VERSION=//p' "$ROOT_DIR/$APP_DIR/Dockerfile")"
  kasm_version="$(sed -n 's/^ARG KASMVNC_VERSION=//p' "$ROOT_DIR/$APP_DIR/Dockerfile")"
  arch="$(run_remote 'uname -m')"
  case "$arch" in
    x86_64) deb_arch=amd64; s6_arch=x86_64 ;;
    aarch64) deb_arch=arm64; s6_arch=aarch64 ;;
    *) fail "no build for $arch" ;;
  esac
  tag="hub-page-browser:${chrome_version}-${revision}"
  files=(
    "chrome/google-chrome-stable_${chrome_version}_${deb_arch}.deb"
    "kasmvnc/kasmvncserver_bookworm_${kasm_version}_${deb_arch}.deb"
    "s6-overlay/s6-overlay-noarch.tar.xz"
    "s6-overlay/s6-overlay-${s6_arch}.tar.xz"
  )
  local vendor
  vendor="$(mktemp -d)"
  trap 'rm -rf "$vendor"' RETURN
  mkdir "$vendor/vendor"
  for file in "${files[@]}"; do
    [[ -f "$VENDOR_CACHE/$file" ]] || fail "missing $VENDOR_CACHE/$file"
    cp "$VENDOR_CACHE/$file" "$vendor/vendor/"
  done
  (cd "$vendor/vendor" && grep -F -f <(printf '  %s\n' "${files[@]##*/}") "$ROOT_DIR/$APP_DIR/vendor.sha256" | shasum -a 256 -c -) >&2 \
    || fail "a vendored file does not match vendor.sha256"
  git -C "$ROOT_DIR" archive --format=tar --prefix=context/ "HEAD:$APP_DIR" >"$vendor/context.tar"
  log "uploading the build context of $tag ($(du -sh "$vendor" | cut -f1))"
  (cd "$vendor" && tar -cf - context.tar vendor) | ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -lc $(printf '%q' "set -euo pipefail
    dir=${REMOTE_BASE}/build/${revision}
    rm -rf \"\$dir\"
    install -d -m 700 \"\$dir\"
    tar -xf - -C \"\$dir\"
    tar -xf \"\$dir/context.tar\" -C \"\$dir\"
    docker build --build-context vendor=\"\$dir/vendor\" --label agency-hub.page-browser.revision=${revision} --label agency-hub.page-browser.chrome-version=${chrome_version} --build-arg OPERATOR_VERSION=${revision} -t ${tag} \"\$dir/context\"
    # What the Chrome update builds the next Chrome from, on this commit
    # (scripts/page-browser-update.sh build): the context, KasmVNC and
    # s6-overlay, and this Chrome in the archive with its checked SHA-256.
    install -d -m 700 ${REMOTE_BASE}/build/context ${REMOTE_BASE}/vendor
    install -d -m 755 ${REMOTE_BASE}/chrome
    install -m 600 \"\$dir/context.tar\" ${REMOTE_BASE}/build/context/${revision}.tar
    printf '%s\\n' ${revision} > ${REMOTE_BASE}/build/context/LATEST
    install -m 600 \"\$dir\"/vendor/kasmvncserver_* \"\$dir\"/vendor/s6-overlay-* ${REMOTE_BASE}/vendor/
    deb=google-chrome-stable_${chrome_version}_${deb_arch}.deb
    if [[ ! -f ${REMOTE_BASE}/chrome/\$deb.meta ]]; then
      install -m 644 \"\$dir/vendor/\$deb\" ${REMOTE_BASE}/chrome/\$deb
      printf 'version=%s\\nsha256=%s\\nbytes=%s\\nfetched_at=%s\\nfetched_s=%s\\nsource=deploy-page-browser.sh build %s\\n' ${chrome_version} \"\$(sha256sum ${REMOTE_BASE}/chrome/\$deb | cut -d' ' -f1)\" \"\$(stat -c %s ${REMOTE_BASE}/chrome/\$deb)\" \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"\$(date -u +%s)\" ${revision} > ${REMOTE_BASE}/chrome/\$deb.meta
    fi
    rm -rf \"\$dir\"")"
  log "built $tag"
}

# The page off its browser for good (Project Browser PR 14): its container
# removed and gone, then the Hub told the browser is stopped — its pending
# leave confirmed by the owner's word, audited. Never the other way round: a
# Hub told before the container is gone would let Node send beside a live
# site socket.
to_node() {
  [[ -n "$PAGE_NAME" ]] || fail "to-node needs --page <name>"
  [[ "$PAGE_NAME" =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || fail "not a page name: $PAGE_NAME"
  page_remote down --page "$PAGE_NAME"
  # Gone means Docker says so: an inspect that fails for another reason (its
  # daemon down) says nothing, and the Hub is not told on it.
  local gone=0
  run_remote "set -uo pipefail; out=\$(docker inspect $(printf '%q' "page-browser-${PAGE_NAME}") 2>&1) && exit 1; grep -qiE 'no such (object|container)' <<<\"\$out\" && exit 0; exit 2" || gone=$?
  ((gone != 1)) || fail "page-browser-${PAGE_NAME} still exists: the Hub is not told it stopped"
  ((gone == 0)) || fail "page-browser-${PAGE_NAME} cannot be read on the server: the Hub is not told it stopped"
  local cli=(node apps/runtime/dist/cli.js sync page transport "$PAGE_NAME" node --browser-stopped)
  [[ "$TO_NODE_PREPARE" == "1" ]] && cli+=(--prepare)
  cli+=(--note "deploy-page-browser.sh to-node: container page-browser-${PAGE_NAME} removed")
  local quoted="" arg
  for arg in "${cli[@]}"; do quoted+=" $(printf '%q' "$arg")"; done
  run_remote "set -euo pipefail; cd $(printf '%q' "$HUB_DIR"); docker compose --env-file .env.production -f docker-compose.production.yml exec -T api${quoted}"
  log "page ${PAGE_NAME}: its browser is stopped and the Hub knows it; Node takes the page"
}

chrome() {
  [[ ${#CHROME_ARGS[@]} -gt 0 ]] || fail "chrome needs a command of page-browser-update.sh (--help lists them)"
  local quoted="" arg
  for arg in "${CHROME_ARGS[@]}"; do quoted+=" $(printf '%q' "$arg")"; done
  run_remote "set -euo pipefail; ${REMOTE_BASE}/page-browser-update.sh${quoted}"
}

case "$COMMAND" in
  host) host ;;
  build) build ;;
  to-node) to_node ;;
  chrome) chrome ;;
  up|rollback|down|status) page_remote "$COMMAND" "${PAGE_ARGS[@]}" ;;
  *) usage; exit 2 ;;
esac
