#!/usr/bin/env bash
# Puts the stand's tree on the server, from the workstation (owner's decision
# №14: the stage-2 stand runs on agency-de, under the guard):
#
#   apps/page-browser/stand/push.sh --remote <user@host> [--rev <commit>]
#
# - the committed tree of <commit> (default HEAD): apps/page-browser and
#   docker-compose.page-browser.yml, as /opt/pb-suite/src/<rev>/, with the
#   revision in .pb-suite-rev (stand.sh tags its images with it);
# - the amd64 Chrome, KasmVNC and s6-overlay files into /opt/pb-suite/vendor
#   — taken from the stage-2 stand's /opt/pb-stand/vendor when they are
#   there, uploaded from the vendor cache otherwise — and checked against
#   the tree's vendor.sha256 on the server.
#
# Committed files only; nothing is built or started. PB_SSH_BIND=<address>
# binds SSH to a local address (around the VPN).
set -euo pipefail
export COPYFILE_DISABLE=1

REMOTE="" REV=HEAD
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2 ;;
    --rev) REV="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REMOTE" ]] || { sed -n '2,18p' "$0"; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
CACHE="${PB_VENDOR_CACHE:-$HOME/code/.cache/page-browser}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
[[ -n "${PB_SSH_BIND:-}" ]] && SSH+=(-b "$PB_SSH_BIND")
rev="$(git -C "$REPO" rev-parse --short=12 "$REV")"
remote() { "${SSH[@]}" "$REMOTE" "$@"; }
BASE=/opt/pb-suite

remote "install -d -m 755 $BASE $BASE/src $BASE/vendor $BASE/stands $BASE/guard"
git -C "$REPO" archive --format=tar "$rev" apps/page-browser docker-compose.page-browser.yml \
  | remote "rm -rf $BASE/src/$rev && mkdir $BASE/src/$rev && tar -xf - -C $BASE/src/$rev && echo $rev > $BASE/src/$rev/.pb-suite-rev"

# The Chrome the pushed tree's Dockerfile pins, never one named here.
chrome="$(git -C "$REPO" show "$rev:apps/page-browser/Dockerfile" | sed -n 's/^ARG CHROME_VERSION=//p')"
[[ "$chrome" =~ ^[0-9]+(\.[0-9]+){3}-[0-9]+$ ]] || { echo "no CHROME_VERSION in $rev's Dockerfile" >&2; exit 1; }
files=(
  "chrome/google-chrome-stable_${chrome}_amd64.deb"
  kasmvnc/kasmvncserver_bookworm_1.5.0_amd64.deb
  s6-overlay/s6-overlay-noarch.tar.xz
  s6-overlay/s6-overlay-x86_64.tar.xz
)
for file in "${files[@]}"; do
  name="${file##*/}"
  if remote "test -s $BASE/vendor/$name || { test -s /opt/pb-stand/vendor/$name && cp /opt/pb-stand/vendor/$name $BASE/vendor/$name; }"; then
    continue
  fi
  echo "uploading $name ($(du -h "$CACHE/$file" | cut -f1))"
  remote "cat > $BASE/vendor/$name.part && mv $BASE/vendor/$name.part $BASE/vendor/$name" < "$CACHE/$file"
done
remote "cd $BASE/vendor && grep -E '  ($(printf '%s|' "${files[@]##*/}" | sed 's/|$//; s/\./\\./g'))\$' $BASE/src/$rev/apps/page-browser/vendor.sha256 | sha256sum -c -"
echo "pushed: $BASE/src/$rev — on the server: $BASE/src/$rev/apps/page-browser/stand/stand.sh"
