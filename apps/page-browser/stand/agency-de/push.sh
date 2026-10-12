#!/usr/bin/env bash
# Puts the stand on agency-de (/opt/pb-stand), from the workstation:
#   apps/page-browser/stand/agency-de/push.sh <proto commit> <PR 2 commit>
# - the prototype tree of <proto commit> (apps/page-browser, without the
#   Mac's results) as /opt/pb-stand/src/<rev>, and this directory's files;
# - PR 2's apps/page-browser and its page Compose file as
#   /opt/pb-stand/ctx/<rev>; its seccomp and AppArmor profiles as
#   /opt/pb-stand/security;
# - the amd64 Chrome, KasmVNC and s6-overlay files from the vendor cache,
#   checked against PR 2's vendor.sha256 on the server.
# Committed files only. PB_SSH_BIND=<address> binds SSH to a local address
# (around the VPN). Nothing is started.
set -euo pipefail
export COPYFILE_DISABLE=1

REMOTE=root@152.53.191.242
PROTO="${1:?the prototype commit}"
PR2="${2:?the PR 2 commit}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
CACHE="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
[[ -n "${PB_SSH_BIND:-}" ]] && SSH+=(-b "$PB_SSH_BIND")

proto="$(git -C "$REPO" rev-parse --short=12 "$PROTO")"
pr2="$(git -C "$REPO" rev-parse --short=12 "$PR2")"
remote() { "${SSH[@]}" "$REMOTE" "$@"; }

remote "install -d -m 755 /opt/pb-stand /opt/pb-stand/src /opt/pb-stand/ctx /opt/pb-stand/vendor /opt/pb-stand/security /opt/pb-stand/results"

git -C "$REPO" archive --format=tar "$proto:apps/page-browser" -- . ':(exclude)stand/results' \
  | remote "rm -rf /opt/pb-stand/src/$proto && mkdir /opt/pb-stand/src/$proto && tar -xf - -C /opt/pb-stand/src/$proto"
remote "cd /opt/pb-stand/src/$proto/stand/agency-de \
  && install -m 644 docker-compose.yml docker-proxy.mjs /opt/pb-stand/ \
  && install -m 755 guard.sh stand.sh stand-route.sh /opt/pb-stand/ && install -d -m 755 /opt/pb-stand/tools"

git -C "$REPO" archive --format=tar "$pr2" apps/page-browser docker-compose.page-browser.yml \
  | remote "rm -rf /opt/pb-stand/ctx/$pr2 && mkdir /opt/pb-stand/ctx/$pr2 && tar -xf - -C /opt/pb-stand/ctx/$pr2 \
      && install -m 644 /opt/pb-stand/ctx/$pr2/apps/page-browser/security/* /opt/pb-stand/security/"

files=(
  chrome/google-chrome-stable_155.0.8059.39-1_amd64.deb
  kasmvnc/kasmvncserver_bookworm_1.5.0_amd64.deb
  s6-overlay/s6-overlay-noarch.tar.xz
  s6-overlay/s6-overlay-x86_64.tar.xz
)
for file in "${files[@]}"; do
  name="${file##*/}"
  if ! remote "test -s /opt/pb-stand/vendor/$name"; then
    echo "uploading $name ($(du -h "$CACHE/$file" | cut -f1))"
    remote "cat > /opt/pb-stand/vendor/$name.part && mv /opt/pb-stand/vendor/$name.part /opt/pb-stand/vendor/$name" < "$CACHE/$file"
  fi
done
remote "cd /opt/pb-stand/vendor && grep -E '  ($(printf '%s|' "${files[@]##*/}" | sed 's/|$//; s/\./\\./g'))\$' /opt/pb-stand/ctx/$pr2/apps/page-browser/vendor.sha256 | sha256sum -c -"
echo "pushed: src/$proto, ctx/$pr2"
