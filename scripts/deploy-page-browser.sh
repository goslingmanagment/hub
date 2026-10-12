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
  scripts/deploy-page-browser.sh up       <user@host> --page <name> --image <tag> --socks <host:port>
                                          [--profile <uuid> | --new-profile] [--tz <zone>] [--lang <tag>]
  scripts/deploy-page-browser.sh rollback <user@host> --page <name>
  scripts/deploy-page-browser.sh down     <user@host> --page <name>
  scripts/deploy-page-browser.sh status   <user@host> [--page <name>]

  host      Prepares the server, again after any change to its files: the
            networks pb-control (internal) and pb-egress (no traffic between
            its containers), the seccomp profile, the AppArmor profile
            `page-browser`, the host's egress rules and their boot unit,
            the Compose file and page.sh under /opt/agency-hub/page-browser.
  build     Builds hub-page-browser:<Chrome version>-<commit> on the server
            from this checkout's HEAD (committed files only) and the vendor
            cache (PB_VENDOR_CACHE, default ~/code/.cache/page-browser:
            chrome/, kasmvnc/, s6-overlay/), checked against vendor.sha256.
            Chrome's .deb is ~120 MB: around a VPN see the deploy notes.
  up        Creates or recreates a page's container; the image it replaces
            stays the page's previous one.
  rollback  Back to the page's previous image.
  down      Removes the container; the profile's volumes stay.
  status    The page containers, their images and health.

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
PAGE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) SSH_ARGS+=(-i "$2"); shift 2 ;;
    --ssh-port) SSH_ARGS+=(-p "$2"); shift 2 ;;
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
      "$APP_DIR/host/page-browser-egress.service"
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
    install -m 644 \"\$staging/${APP_DIR}/security/apparmor-page-browser\" /etc/apparmor.d/page-browser
    apparmor_parser -r -W /etc/apparmor.d/page-browser
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
    systemctl daemon-reload
    systemctl enable page-browser-egress.service >/dev/null 2>&1
    ${REMOTE_BASE}/egress-rules.sh apply
    echo \"host ready: AppArmor \$(cat /sys/kernel/security/apparmor/profiles | grep -c '^page-browser ') profile, networks pb-control and pb-egress\"")"
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
    docker build --build-context vendor=\"\$dir/vendor\" --label agency-hub.page-browser.revision=${revision} -t ${tag} \"\$dir/context\"
    rm -rf \"\$dir\"")"
  log "built $tag"
}

case "$COMMAND" in
  host) host ;;
  build) build ;;
  up|rollback|down|status) page_remote "$COMMAND" "${PAGE_ARGS[@]}" ;;
  *) usage; exit 2 ;;
esac
