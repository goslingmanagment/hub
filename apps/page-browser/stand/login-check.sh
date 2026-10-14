#!/usr/bin/env bash
# The login check (Project Browser PR 15): the login form's input path — the
# desk's probe and locator, DOM.focus, Input.insertText and a press at the
# button's centre — on a real Chrome behind the operator's real proxy, gate,
# interception and site path in the manual login, against a local TLS server
# that plays Fansly's login. What it proves and what it does not: the head
# of login-check.ts.
#
#   apps/page-browser/stand/login-check.sh [--chrome <path>] [--verbose]
#   apps/page-browser/stand/login-check.sh --image <image> [--name <container>] [--verbose]
#
# Without --image: this machine's Chrome (--chrome, else $CHROME, else Google
# Chrome of a Mac, else google-chrome-stable, google-chrome or chromium on
# PATH) and its Node (22.18 or newer: type stripping), on this checkout's
# src/. With --image: the image's Chrome and Node, in a new container of
# that image with no network at all, as site-check.sh runs it.
#
# No credential anywhere: markers stand for what the owner types. Nothing is
# sent past this machine. About half a minute; exits 0 when all held, 1 when
# any did not, 2 when it could not run.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=""
NAME="pb-login-check-$$"
CHROME_PATH="${CHROME:-}"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --chrome) CHROME_PATH="$2"; shift 2 ;;
    --verbose) ARGS+=("--verbose"); shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
    -v "$APP/stand/login-check.ts:/opt/page-browser/stand/login-check.ts:ro" \
    --entrypoint node "$IMAGE" \
    --no-warnings /opt/page-browser/stand/login-check.ts --chrome /usr/bin/google-chrome-stable "${ARGS[@]+"${ARGS[@]}"}"
fi

if [[ -z "$CHROME_PATH" ]]; then
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome-stable || true)" "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then CHROME_PATH="$candidate"; break; fi
  done
fi
[[ -n "$CHROME_PATH" ]] || { echo "no Chrome found: --chrome <path>" >&2; exit 2; }
[[ "$(id -u)" != 0 ]] || ARGS+=("--no-sandbox")
exec node --no-warnings "$APP/stand/login-check.ts" --chrome "$CHROME_PATH" "${ARGS[@]+"${ARGS[@]}"}"
