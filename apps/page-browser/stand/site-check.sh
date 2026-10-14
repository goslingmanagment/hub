#!/usr/bin/env bash
# The site check (Project Browser PR 7): the site's own requests on a real
# Chrome behind the operator's real proxy, gate, interception, site path and
# buffer, against a local TLS server that plays Fansly's hosts. What it
# proves and what it does not (no holder, no extension, no nftables, not the
# full Operator): the head of site-check.ts.
#
#   apps/page-browser/stand/site-check.sh [--chrome <path>] [--verbose]
#   apps/page-browser/stand/site-check.sh --image <image> [--name <container>] [--verbose]
#
# Without --image: this machine's Chrome (--chrome, else $CHROME, else Google
# Chrome of a Mac, else google-chrome-stable, google-chrome or chromium on
# PATH) and its Node (22.18 or newer: type stripping), on this checkout's
# src/.
# With --image (hub-page-browser:<tag>): the image's Chrome and Node, in a
# new container of that image with no network at all (loopback only), its
# managed policies masked (no proxy policy, no extension), as pb-chrome
# under the image's seccomp profile, with this checkout's src/ and
# site-check.ts mounted read-only in place of the image's. The container is
# removed at its end; --name names it (default pb-site-check-<pid>).
#
# Neither way uses a credential or sends anything past this machine:
# Chrome's only way out is the proxy, the proxy's the script's SOCKS5, the
# SOCKS5's the local server. About a minute; exits 0 when all held, 1 when
# any did not, 2 when it could not run.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=""
NAME="pb-site-check-$$"
CHROME_PATH="${CHROME:-}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --chrome) CHROME_PATH="$2"; shift 2 ;;
    --verbose) ARGS+=("--verbose"); shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$IMAGE" ]]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "no image $IMAGE on this Docker" >&2; exit 2; }
  exec docker run --rm --name "$NAME" --network none \
    --user pb-chrome --shm-size 1g \
    --security-opt "seccomp=$APP/security/seccomp-chrome.json" \
    --tmpfs /etc/opt/chrome/policies/managed \
    -v "$APP/src:/opt/page-browser/src:ro" \
    -v "$APP/stand/site-check.ts:/opt/page-browser/stand/site-check.ts:ro" \
    --entrypoint node "$IMAGE" \
    --no-warnings /opt/page-browser/stand/site-check.ts --chrome /usr/bin/google-chrome-stable "${ARGS[@]+"${ARGS[@]}"}"
fi

if [[ -z "$CHROME_PATH" ]]; then
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome-stable || true)" "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then CHROME_PATH="$candidate"; break; fi
  done
fi
[[ -n "$CHROME_PATH" ]] || { echo "no Chrome found: --chrome <path>" >&2; exit 2; }
# Chrome's sandbox refuses root.
[[ "$(id -u)" != 0 ]] || ARGS+=("--no-sandbox")
exec node --no-warnings "$APP/stand/site-check.ts" --chrome "$CHROME_PATH" "${ARGS[@]+"${ARGS[@]}"}"
