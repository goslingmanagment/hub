#!/usr/bin/env bash
# The resource-timing check (Project Browser, variant Б): Hub's API request
# from the isolated world `pb-hub` leaves no entry in the site's resource
# timeline and no fetch event in its service worker, on a real Chrome —
# what Chrome does today and CDP does not promise. Run it on every Chrome
# the image moves to: stand/chrome-update.sh runs it on the new image, and
# tests/page-browser-image.test.ts fails while PASSED_ON in
# resource-timing-check.ts is not the Dockerfile's Chrome. What it asserts
# and how: the head of resource-timing-check.ts.
#
#   apps/page-browser/stand/resource-timing-check.sh --image <image> [--apparmor <profile>] [--name <container>] [--verbose]
#   apps/page-browser/stand/resource-timing-check.sh [--chrome <path>] [--verbose]
#
# With --image (hub-page-browser:<tag>): the image's Chrome and Node, headed
# on the image's own X server (Xkasmvnc :99, as the page's screen), in a new
# container of that image with no network at all (loopback only), its
# managed policies masked (an empty policy directory), as pb-chrome under
# the image's seccomp profile, with this checkout's src/ and
# resource-timing-check.ts mounted read-only in place of the image's. The
# container is removed at its end; --name names it (default
# pb-resource-timing-<pid>). --apparmor: a profile for the container
# (page-browser on a server, where Docker's default one stops Chrome's
# sandbox; unconfined on a Mac); none given, Docker's default.
# Without --image: this machine's Chrome (--chrome, else $CHROME, else
# Google Chrome of a Mac, else google-chrome-stable, google-chrome or
# chromium on PATH), headless, and its Node (22.18 or newer: type
# stripping), on this checkout's src/.
#
# No Fansly, no stand, no credential: the site and its API are this
# script's local servers, and nothing is sent past this machine. About half
# a minute; exits 0 when all held, 1 when any did not, 2 when it could not
# run.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=""
APPARMOR=""
NAME="pb-resource-timing-$$"
CHROME_PATH="${CHROME:-}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --apparmor) APPARMOR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --chrome) CHROME_PATH="$2"; shift 2 ;;
    --verbose) ARGS+=("--verbose"); shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$IMAGE" ]]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "no image $IMAGE on this Docker" >&2; exit 2; }
  SECURITY=(--security-opt "seccomp=$APP/security/seccomp-chrome.json")
  [[ -z "$APPARMOR" ]] || SECURITY+=(--security-opt "apparmor=$APPARMOR")
  # The screen as s6's xvnc/run starts it, without its web client's
  # password: nothing but this container's loopback reaches it.
  exec docker run --rm --name "$NAME" --network none \
    --user pb-chrome --shm-size 1g "${SECURITY[@]}" \
    --tmpfs /etc/opt/chrome/policies/managed \
    --tmpfs /tmp/.X11-unix:mode=1777 \
    -v "$APP/src:/opt/page-browser/src:ro" \
    -v "$APP/stand/resource-timing-check.ts:/opt/page-browser/stand/resource-timing-check.ts:ro" \
    --entrypoint sh "$IMAGE" -c '
      Xkasmvnc :99 -geometry 1920x1080 -depth 24 -AcceptSetDesktopSize 0 \
        -websocketPort 6901 -interface 127.0.0.1 -sslOnly 0 -disableBasicAuth 1 -SecurityTypes None \
        -nolisten tcp -publicIP 127.0.0.1 >/tmp/xvnc.log 2>&1 &
      i=0
      while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
      [ -S /tmp/.X11-unix/X99 ] || { echo "resource-timing-check: no X server" >&2; tail -20 /tmp/xvnc.log >&2; exit 2; }
      exec node --no-warnings /opt/page-browser/stand/resource-timing-check.ts --chrome /usr/bin/google-chrome-stable --display :99 "$@"
    ' resource-timing-check "${ARGS[@]+"${ARGS[@]}"}"
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
exec node --no-warnings "$APP/stand/resource-timing-check.ts" --chrome "$CHROME_PATH" "${ARGS[@]+"${ARGS[@]}"}"
