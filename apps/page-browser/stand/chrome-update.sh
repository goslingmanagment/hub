#!/usr/bin/env bash
# The stand check of a Chrome update (Project Browser plan §5, stage 3,
# PR 18: "обновление и откат страницы с живым профилем"): a page with a live
# profile moved to a new Chrome and back by scripts/page-browser-update.sh
# itself, with page.sh, on this machine's Docker — run it where the images
# are (on a server: there, not through DOCKER_HOST: the snapshots are files
# of the machine that runs it).
#
#   apps/page-browser/stand/chrome-update.sh --from <image> --to <image>
#       [--profile <uuid>] [--apparmor <profile>] [--keep]
#
# <from> and <to>: two hub-page-browser images, <to>'s Chrome newer.
#  1. A page of this run's own (pr18-<run>, Compose project
#     page-browser-pr18-<run>) on <from>, with its own base directory
#     (page.sh, the update script and their files, a temporary one) and the
#     profile:
#     - none given: a new profile, made live — its Chrome run once, a cookie
#       of .fansly.com stored (`pr18=before`) and a mark file;
#     - --profile <uuid>: the volumes pb-profile-<uuid>, pb-buffer-<uuid>
#       as they are (e.g. a copy of the test account's, last opened by
#       <from>'s Chrome or an older one): the names of its .fansly.com
#       cookies are compared, never a value. It ends as it was found: what
#       the check adds on the new Chrome goes with the rollback.
#  2. update <from> → <to> (--engine none: no Hub here): the profile's
#     snapshot, the new Chrome opens it, the rules extension of <to>.
#     Checked: the container on <to>, the profile names <to>'s Chrome, its
#     cookies are still there; then a cookie and mark of <to>'s time.
#  3. page.sh rollback is refused: the profile is <to>'s Chrome's now.
#  4. page-browser-update.sh rollback: <from> with the snapshot. Checked:
#     <from>'s Chrome, the cookies of before — and not <to>'s — the mark of
#     before, the profile Chrome's user's alone (700).
#  5. An image that fails the profile check (<to> with another extension ID
#     in its files): the update rolls itself back; the same checks as 4.
#  6. A halt held for the owner's decision on the page's buffer volume
#     (written by the image's own halt store, PR 17): the update refuses the
#     page, nothing touched; the halt is cleared again by the same store.
#  7. The page's view of Hub's requests on <to>'s Chrome
#     (stand/resource-timing-check.sh, in a container of its own with no
#     network): Hub's API request from its isolated world leaves no entry in
#     the site's resource timeline and no fetch event in its service worker.
# What this run made goes at the end, and nothing else — its page, its
# volumes (never a --profile's), its derived image, the networks if it made
# them; --keep leaves it. Every name is this run's own: runs side by side,
# or one --kept, are never touched.
#
# Nothing reaches any network: the exit of the page stays closed (no engine
# opens it), its SOCKS5 is a documentation address (192.0.2.10), the host's
# egress rules are not this check's (a stub). The networks pb-control and
# pb-egress are made with the host's subnets if they are missing. On a Mac
# (Docker Desktop): --apparmor unconfined; flock and getent are stood in for.
#
# On agency-de (the owner's run), from a checkout of this branch:
#   scripts/deploy-page-browser.sh build root@agency-de    # <from>; keeps the build context
#   git archive HEAD scripts/page-browser-update.sh apps/page-browser docker-compose.page-browser.yml \
#     | ssh root@agency-de 'rm -rf /opt/pb-stand/pr18 && mkdir -p /opt/pb-stand/pr18 && tar -x -C /opt/pb-stand/pr18'
#   ssh root@agency-de 'cd /opt/pb-stand/pr18 && PB_BASE=/opt/agency-hub/page-browser \
#     PB_CHROME_SIGNING_KEY=$PWD/apps/page-browser/host/google-linux-signing-key.asc \
#     bash scripts/page-browser-update.sh check'             # <to>: the newest Stable, verified and built
#   ssh root@agency-de 'bash /opt/pb-stand/pr18/apps/page-browser/stand/chrome-update.sh --from <from> --to <to>'
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP="$ROOT/apps/page-browser"
FROM="" TO="" PROFILE="" APPARMOR="page-browser" KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --apparmor) APPARMOR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$FROM" == hub-page-browser:* && "$TO" == hub-page-browser:* ]] || { echo "--from and --to: hub-page-browser images" >&2; exit 2; }
docker image inspect "$FROM" "$TO" >/dev/null || exit 2

RUN_ID="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
PAGE="pr18-$RUN_ID"
CONTAINER="page-browser-$PAGE"
BAD="hub-page-browser:pr18-$RUN_ID-wrong-extension"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/pb-chrome-update.XXXXXX")"
# What this run made, as it makes it: cleanup removes these and nothing else.
OWN_PROFILE=0 MADE_PAGE=0 MADE_IMAGE=0 MADE_NETWORKS=() FAILED=0
log() { printf '[chrome-update] %s\n' "$*" >&2; }
check() {
  if [[ "$2" == "$3" ]]; then log "PASS $1 ($2)"; else log "FAIL $1: $2, expected $3"; FAILED=1; fi
}

cleanup() {
  if ((KEEP == 1)); then
    log "kept: $CONTAINER, its volumes, $BASE"
    return
  fi
  # The container's name is this run's alone.
  if ((MADE_PAGE == 1)); then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if ((OWN_PROFILE == 1)); then docker volume rm "pb-profile-$PROFILE" "pb-buffer-$PROFILE" >/dev/null 2>&1 || true; fi
  if ((MADE_IMAGE == 1)); then docker image rm "$BAD" >/dev/null 2>&1 || true; fi
  local network
  for network in "${MADE_NETWORKS[@]+"${MADE_NETWORKS[@]}"}"; do docker network rm "$network" >/dev/null 2>&1 || true; done
  rm -rf "$BASE"
}
trap cleanup EXIT

# The base: page.sh and the update with their files; the host's rules are
# not this check's.
mkdir -p "$BASE/security" "$BASE/bin"
cp "$ROOT/docker-compose.page-browser.yml" "$BASE/"
cp "$APP/security/seccomp-chrome.json" "$BASE/security/"
cp "$APP/host/page.sh" "$APP/host/profile-check.mjs" "$APP/host/google-linux-signing-key.asc" "$ROOT/scripts/page-browser-update.sh" "$BASE/"
printf '#!/usr/bin/env bash\n# The host'\''s egress rules are not the stand check'\''s.\nexit 0\n' > "$BASE/egress-rules.sh"
chmod 755 "$BASE/page.sh" "$BASE/page-browser-update.sh" "$BASE/egress-rules.sh"
command -v flock >/dev/null || printf '#!/usr/bin/env bash\nexit 0\n' > "$BASE/bin/flock"
command -v getent >/dev/null || printf '#!/usr/bin/env bash\nprintf "%%s STREAM %%s\\n" "$2" "$2"\n' > "$BASE/bin/getent"
chmod 755 "$BASE"/bin/* 2>/dev/null || true
export PATH="$BASE/bin:$PATH" PB_BASE="$BASE" PB_APPARMOR_PROFILE="$APPARMOR"
case "$(uname -m)" in x86_64) export PB_ARCH=amd64 ;; *) export PB_ARCH=arm64 ;; esac

network() {
  local name="$1" subnet="$2"
  shift 2
  docker network inspect "$name" >/dev/null 2>&1 && return 0
  docker network create --driver bridge --subnet "$subnet" "$@" "$name" >/dev/null
  MADE_NETWORKS+=("$name")
}
network pb-control 10.230.0.0/24 --internal
network pb-egress 10.230.1.0/24 -o com.docker.network.bridge.enable_icc=false
# page.sh picks the page's addresses among its own pages: the ones other
# containers hold in these networks are named to it as taken.
mkdir -p "$BASE/pages/taken-by-others"
for name in pb-control pb-egress; do
  docker network inspect "$name" --format '{{range .Containers}}{{.IPv4Address}}{{"\n"}}{{end}}' \
    | sed -n 's#^10\.230\.[01]\.\([0-9]*\)/.*#PB_EGRESS_IP=10.230.1.\1#p'
done > "$BASE/pages/taken-by-others/page.env"

if [[ -z "$PROFILE" ]]; then
  PROFILE="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/')"
  OWN_PROFILE=1
  docker volume create "pb-profile-$PROFILE" >/dev/null
  docker volume create "pb-buffer-$PROFILE" >/dev/null
fi
docker volume inspect "pb-profile-$PROFILE" "pb-buffer-$PROFILE" >/dev/null

# In the page's container, as pb-operator: its Chrome once, the profile's
# .fansly.com cookies by name (live-profile.mjs).
cookies() {
  docker cp "$APP/stand/live-profile.mjs" "$CONTAINER:/tmp/pb-live-profile.mjs" >/dev/null
  docker exec "$CONTAINER" chmod 644 /tmp/pb-live-profile.mjs
  docker exec "$CONTAINER" /command/s6-setuidgid pb-operator node --no-warnings /tmp/pb-live-profile.mjs "$@" \
    | sed -n 's/.*"cookies":\[\([^]]*\)\].*/\1/p' | tr -d '"'
}
profile_says() { docker exec "$CONTAINER" sh -c "$1"; }
chrome_of() { [[ "$1" =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"; }
image_chrome() { chrome_of "$(docker run --rm --network none --entrypoint /usr/bin/google-chrome-stable "$1" --version)"; }
FROM_CHROME="$(image_chrome "$FROM")"
TO_CHROME="$(image_chrome "$TO")"
log "from $FROM (Chrome $FROM_CHROME) to $TO (Chrome $TO_CHROME), profile $PROFILE$([[ $OWN_PROFILE == 1 ]] && echo ' (new, made live here)')"

update() { bash "$BASE/page-browser-update.sh" update "$@" --engine none --any-hour --window 0; }
rollback() { bash "$BASE/page-browser-update.sh" rollback "$@"; }
on_from() {
  check "$1: the container's image" "$(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' "$CONTAINER")" "$FROM healthy"
  check "$1: the profile names Chrome" "$(profile_says 'cat "/data/profile/Last Version"')" "$FROM_CHROME"
  check "$1: the profile is Chrome's user's alone" "$(profile_says 'stat -c "%U %a" /data/profile')" "pb-chrome 700"
  check "$1: the cookies of before, not the new Chrome's" "$(cookies list)" "$BEFORE"
  ((OWN_PROFILE == 0)) || check "$1: the mark of before" "$(profile_says 'cat /data/profile/pr18-mark')" "before"
}

# 1. The page on <from>, its profile live.
MADE_PAGE=1
bash "$BASE/page.sh" up --page "$PAGE" --image "$FROM" --profile "$PROFILE" --socks 192.0.2.10:1080 >&2
if ((OWN_PROFILE == 1)); then
  cookies set pr18 before >/dev/null
  profile_says '/command/s6-setuidgid pb-chrome sh -c "echo before > /data/profile/pr18-mark"'
fi
BEFORE="$(cookies list)"
log "the profile's .fansly.com cookies: ${BEFORE:-none}"

# 2. The update.
update --page "$PAGE" --image "$TO"
check "update: the container's image" "$(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' "$CONTAINER")" "$TO healthy"
check "update: the profile names Chrome" "$(profile_says 'cat "/data/profile/Last Version"')" "$TO_CHROME"
check "update: the cookies kept by the new Chrome" "$(cookies list)" "$BEFORE"
check "update: the snapshot" "$(find "$BASE/snapshots/$PROFILE" -name "*.tar.gz.meta" | wc -l | tr -d ' ')" "1"
cookies set pr18-after new-chrome >/dev/null
((OWN_PROFILE == 0)) || profile_says '/command/s6-setuidgid pb-chrome sh -c "echo after > /data/profile/pr18-mark"'

# 3. A plain rollback would open the profile with the older Chrome.
if bash "$BASE/page.sh" rollback --page "$PAGE" 2>"$BASE/refused"; then
  check "page.sh rollback is refused" "it went" "refused"
else
  check "page.sh rollback is refused" "$(grep -c 'Chrome never opens a profile a newer one wrote' "$BASE/refused")" "1"
fi

# 4. The rollback: <from> with the snapshot.
rollback --page "$PAGE" --reason "stand check" || true
check "rollback: the update's end" "$(sed -n 's/^STEP=//p' "$BASE/update/pages/$PAGE/state")" "rolled_back"
on_from rollback

# 5. A Chrome that fails its check rolls itself back.
MADE_IMAGE=1
printf 'FROM %s\nRUN echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > /opt/page-browser/extension/dist/id\n' "$TO" | docker build -q -t "$BAD" - >/dev/null
if update --page "$PAGE" --image "$BAD"; then check "a failing image: the update" "done" "rolled back"; fi
check "a failing image: the update's end" "$(sed -n 's/^STEP=//p' "$BASE/update/pages/$PAGE/state")" "rolled_back"
check "a failing image: why" "$(sed -n 's/^REASON=.*profile check failed: \(extension_installed_by_policy\).*/\1/p' "$BASE/update/pages/$PAGE/state")" "extension_installed_by_policy"
on_from "automatic rollback"

# 6. A halted page is not updated.
halt_store() {
  docker run --rm --network none --user 0 --entrypoint node -v "pb-buffer-$PROFILE:/data/buffer" "$FROM" --no-warnings --input-type=module -e "
    const { HaltStore, newHalt } = await import('/opt/page-browser/src/state/halt-store.ts');
    const store = new HaltStore('/data/buffer/operator/halt.json');
    const held = store.read();
    store.write($1);
    console.log('ok');" pb-stand-halt >/dev/null
}
halt_store '{ halt: newHalt("exit_ip_changed"), lastClearedId: held.lastClearedId }'
if update --page "$PAGE" --image "$TO" 2>"$BASE/halted"; then
  check "a halted page: the update" "it went" "refused"
else
  check "a halted page: refused" "$(grep -c "its operator holds a halt for the owner's decision (exit_ip_changed" "$BASE/halted")" "1"
fi
check "a halted page: untouched" "$(docker inspect -f '{{.Config.Image}} {{.State.Health.Status}}' "$CONTAINER")" "$FROM healthy"
halt_store '{ halt: null, lastClearedId: held.halt === null ? held.lastClearedId : held.halt.id }'

# 7. What the site's page sees of Hub's requests on the new Chrome, under
# the page's own AppArmor profile.
if bash "$APP/stand/resource-timing-check.sh" --image "$TO" --apparmor "$APPARMOR" --name "pb-resource-timing-pr18-$RUN_ID" >&2; then
  check "the page's view of Hub's requests on Chrome $TO_CHROME" "hidden" "hidden"
else
  check "the page's view of Hub's requests on Chrome $TO_CHROME" "not hidden, or not checked (resource-timing-check.sh)" "hidden"
fi

if ((FAILED == 0)); then log "passed"; else log "FAILED"; fi
exit "$FAILED"
