#!/usr/bin/env bash
# The stand check of the rules extension in a page container that exists
# (plan §5, stage 3, PR 6: a read mark, typing, the status and an unknown
# write are cancelled without the operator, on the image's real Chrome):
# copies stand/rules-check.mjs into the container and runs it there as
# pb-operator. What it checks and how: the head of rules-check.mjs.
#
#   apps/page-browser/stand/rules-check.sh --container <name> [--take-over]
#
# The container is the page's (`page-browser-<page>`), on the Docker this
# shell talks to — the stand's server with DOCKER_HOST=ssh://<user@host>, or
# run there. The check stops the page's operator and restarts its Chrome for
# about a minute, and leaves the page as a standing one: Chrome down, the
# operator up. So it is for a page no engine starts meanwhile — a new page
# Hub does not know yet, or a paused one. It refuses a container whose
# Chrome is running; --take-over takes it anyway (the page's start is then
# the engine's to give again). It sends nothing to any network: Chrome's
# only way out is the proxy's port, and during the check this script's
# listener holds it.
#
# A new container for the whole image check instead: stand/image-check.sh
# (it runs this check too).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=""
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --take-over) ARGS+=("--take-over"); shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n "$CONTAINER" ]] || { echo "which container? --container page-browser-<page>" >&2; exit 2; }
[[ "$CONTAINER" == page-browser-* ]] || { echo "$CONTAINER is not a page's container (page-browser-<page>)" >&2; exit 2; }
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true || { echo "$CONTAINER is not running" >&2; exit 1; }

docker cp "$APP/stand/rules-check.mjs" "$CONTAINER:/tmp/rules-check.mjs" >/dev/null
docker exec "$CONTAINER" chmod 644 /tmp/rules-check.mjs
exec docker exec "$CONTAINER" /command/s6-setuidgid pb-operator node --no-warnings /tmp/rules-check.mjs "${ARGS[@]+"${ARGS[@]}"}"
