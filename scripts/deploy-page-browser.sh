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
  scripts/deploy-page-browser.sh add-profile <user@host> --page <name> --image <tag> [--existing]
                                          [--env <json>] [--socks <host:port> --env <json>] [--hub-dir <dir>]
  scripts/deploy-page-browser.sh remove-profile <user@host> --page <name> [--profile <uuid>] [--hub-dir <dir>]
  scripts/deploy-page-browser.sh rollback <user@host> --page <name>
  scripts/deploy-page-browser.sh down     <user@host> --page <name>
  scripts/deploy-page-browser.sh to-node  <user@host> --page <name> [--prepare] [--hub-dir <dir>]
  scripts/deploy-page-browser.sh status   <user@host> [--page <name>]
  scripts/deploy-page-browser.sh chrome   <user@host> <check|build|update|rollout|resume|rollback|snapshot|status|prune> [options]
  scripts/deploy-page-browser.sh log      <user@host> --page <name> [--kind requests|connections|states|sockets]
                                          [--since <iso>] [--path <prefix>] [--method <M>]

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
  add-profile
            A new browser profile (Project Browser PR 16), made from the
            browser the owner started in the dashboard (Настройки → Страницы
            → «Новые страницы через серверный браузер»; owner decision
            2026-10-15): there he pasted the proxy, Hub checked it and
            proposed the environment from its exit, he confirmed it. Nothing
            of it is typed here: Hub's draft of <name> (`sync browser-profile
            draft` in the api container under --hub-dir, default
            /opt/agency-hub) gives the SOCKS5's ip:port the container's rules
            admit — the public address Hub judged when the draft was saved,
            never a DNS answer of now — and the environment; Chrome's zone and
            language come from it. Then a container with a profile of its own, an empty buffer
            and its own secrets (the engine's RPC token, the API's token, the
            KasmVNC password), then its row in Hub from the draft (`sync
            browser-profile add --from-draft`, the secrets on its standard
            input, never in a command line; the draft consumed with it,
            refused if the owner changed it meanwhile), its page empty: the
            owner connects the new page in the dashboard (the exit IP, his
            login, the account check, the page's creation). --existing: the
            page <name> exists in Hub and moves to its browser (its draft
            says so; its proxy is its own) — the profile is bound to it at
            once (plan §5, stage 4). --env <json> overrides the draft's
            environment ({"timeZone":…,"languages":[…],"geolocation":
            {"latitude":…,"longitude":…,"accuracyM":…}}). --socks with --env:
            no draft (PR 16's way) — the proxy's login and password are then
            given in the dashboard, and Hub refuses a proxy that is not this
            SOCKS5; refused when the owner has a draft of <name>. If Hub
            refuses the profile (its own word: nothing of it written), the
            container and its volumes go. Any other failure — its answer
            lost — leaves the outcome unknown (Hub may have registered it,
            with --existing bound to the page): nothing is removed; the
            script says what is left, how to ask Hub (`sync browser-profile
            show`) and, when Hub has none, the remove-profile to run with the
            profile's UUID.
  remove-profile
            A profile no page has, given up: Hub forgets it first (refused
            for a profile bound to a page), then its container, its files and
            its two volumes are deleted on the server — only while the page's
            files there still name the profile Hub forgot (checked under the
            server's lock). --profile <uuid>: refused unless the page names
            that profile. Hub never registers a forgotten profile again (an
            add still under way is refused), so "absent" is final.
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
  log       The page browser's journals (plan §4.11), read on the server from
            its buffer volume — Hub's containers cannot reach them: one kind
            (default requests) from --since on, of a path starting with
            --path, of --method; e.g. that POST /api/v1/message/ack never
            left: --path /api/v1/message/ack --method POST.

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
ENV_JSON=""
SOCKS_ARG=""
EXISTING_PAGE=0
PROFILE_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) SSH_ARGS+=(-i "$2"); shift 2 ;;
    --ssh-port) SSH_ARGS+=(-p "$2"); shift 2 ;;
    --prepare) TO_NODE_PREPARE=1; shift ;;
    --existing) EXISTING_PAGE=1; shift ;;
    --env) [[ $# -ge 2 ]] || fail "$1 needs a value"; ENV_JSON="$2"; shift 2 ;;
    --hub-dir) [[ $# -ge 2 ]] || fail "$1 needs a value"; HUB_DIR="$2"; shift 2 ;;
    --page) [[ $# -ge 2 ]] || fail "$1 needs a value"; PAGE_NAME="$2"; PAGE_ARGS+=("$1" "$2"); shift 2 ;;
    --socks) [[ $# -ge 2 ]] || fail "$1 needs a value"; SOCKS_ARG="$2"; PAGE_ARGS+=("$1" "$2"); shift 2 ;;
    --new-profile) PAGE_ARGS+=("$1"); shift ;;
    --profile) [[ $# -ge 2 ]] || fail "$1 needs a value"; PROFILE_ARG="$2"; PAGE_ARGS+=("$1" "$2"); shift 2 ;;
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
      scripts/archive-container-logs.sh \
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
    install -m 755 \"\$staging/scripts/archive-container-logs.sh\" ${REMOTE_BASE}/archive-container-logs.sh
    install -d -m 700 ${REMOTE_BASE}/container-logs
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
  # The protocol its operator speaks, as a label: the Chrome update refuses
  # an image the engine would refuse (page-browser-update.sh, PR 17's 1.1).
  local protocol
  protocol="$(git -C "$ROOT_DIR" show "HEAD:$APP_DIR/src/rpc/protocol.ts" | sed -n 's/.*PROTOCOL = { major: \([0-9]*\), minor: \([0-9]*\) }.*/\1.\2/p' | head -n 1)"
  [[ "$protocol" =~ ^[0-9]+\.[0-9]+$ ]] || fail "the operator's protocol cannot be read in $APP_DIR/src/rpc/protocol.ts"
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
    docker build --build-context vendor=\"\$dir/vendor\" --label agency-hub.page-browser.revision=${revision} --label agency-hub.page-browser.chrome-version=${chrome_version} --label agency-hub.page-browser.protocol=${protocol} --build-arg OPERATOR_VERSION=${revision} -t ${tag} \"\$dir/context\"
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

# The Hub CLI in the api container, run from --hub-dir (the caller's line
# goes there first): the command's arguments quoted one by one; what the
# caller pipes in goes to its standard input.
hub_cli_line() {
  local quoted="" arg
  for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
  printf 'docker compose --env-file .env.production -f docker-compose.production.yml exec -T api node apps/runtime/dist/cli.js%s' "$quoted"
}

# One field of a JSON object Hub printed: a string as it is, anything else
# as JSON; 1 when it has none.
json_field() {
  node -e 'const v = JSON.parse(process.argv[1])[process.argv[2]]; if (v === undefined || v === null) process.exit(1); process.stdout.write(typeof v === "string" ? v : JSON.stringify(v))' "$2" "$1"
}

# A new profile (Project Browser PR 16): the container on the server, then
# its row in Hub with its secrets on the CLI's standard input — both from
# the owner's draft in the dashboard (owner decision 2026-10-15), unless
# --socks and --env say it here. If Hub does not take it, the container and
# its volumes go: nothing half-made stays.
add_profile() {
  [[ -n "$PAGE_NAME" ]] || fail "add-profile needs --page <name>"
  [[ "$PAGE_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fail "not a page name: $PAGE_NAME"
  local env_override="$ENV_JSON" from_draft=()
  if [[ -z "$SOCKS_ARG" ]]; then
    # The SOCKS5's address and the environment from Hub's draft: nothing of
    # the proxy is typed here, and its login and password never leave Hub.
    local draft draft_socks draft_id revision existing
    draft="$(run_remote "set -euo pipefail; cd $(printf '%q' "$HUB_DIR"); $(hub_cli_line sync browser-profile draft --name "$PAGE_NAME")")" \
      || fail "Hub gave no draft of ${PAGE_NAME}: start its browser in the dashboard (Настройки → Страницы → «Новые страницы через серверный браузер»), or give --socks and --env"
    draft_socks="$(json_field socks "$draft")" || fail "Hub's draft of ${PAGE_NAME} names no SOCKS5"
    draft_id="$(json_field draftId "$draft")" || fail "Hub's draft of ${PAGE_NAME} has no id"
    revision="$(json_field revision "$draft")" || fail "Hub's draft of ${PAGE_NAME} has no revision"
    existing="$(json_field existingPage "$draft")" || fail "Hub's draft of ${PAGE_NAME} does not say whose it is"
    [[ "$draft_socks" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$ && "$draft_id" =~ ^[0-9a-f-]{36}$ && "$revision" =~ ^[0-9]+$ ]] || fail "Hub's draft of ${PAGE_NAME} does not read"
    if [[ "$existing" == "true" && "$EXISTING_PAGE" != "1" ]]; then fail "the draft of ${PAGE_NAME} moves the existing page to its browser: add --existing"; fi
    if [[ "$existing" != "true" && "$EXISTING_PAGE" == "1" ]]; then fail "the draft of ${PAGE_NAME} is a new page's: no --existing"; fi
    [[ -n "$ENV_JSON" ]] || ENV_JSON="$(json_field env "$draft")" || fail "Hub's draft of ${PAGE_NAME} has no environment"
    PAGE_ARGS+=(--socks "$draft_socks")
    # The very draft read — its own id (one deleted and made again is
    # another) and its revision —, for the very address it holds.
    from_draft=(--from-draft "$PAGE_NAME" --draft-id "$draft_id" --draft-revision "$revision")
    log "the draft of ${PAGE_NAME} (revision ${revision}): SOCKS5 ${draft_socks}$([[ -n "$env_override" ]] && echo ", the environment given here")"
  else
    [[ -n "$ENV_JSON" ]] || fail "add-profile needs --env <json> with --socks: the browser's environment by the proxy's region"
  fi
  local zone lang
  # Chrome's zone and first language, from the environment (checked again,
  # whole, by Hub).
  zone="$(node -e 'const e = JSON.parse(process.argv[1]); if (typeof e.timeZone !== "string") process.exit(1); process.stdout.write(e.timeZone)' "$ENV_JSON")" \
    || fail "--env: not a JSON object with a timeZone"
  lang="$(node -e 'const e = JSON.parse(process.argv[1]); const l = Array.isArray(e.languages) ? e.languages[0] : null; if (typeof l !== "string") process.exit(1); process.stdout.write(l)' "$ENV_JSON")" \
    || fail "--env: no languages"
  local made profile socks
  made="$(page_remote add-profile "${PAGE_ARGS[@]}" --tz "$zone" --lang "$lang")" || fail "the server did not make the profile's container"
  printf '%s\n' "$made" | grep -v '^PB_' >&2 || true
  profile="$(printf '%s\n' "$made" | sed -n 's/^PB_PROFILE_ID=//p' | tail -n 1)"
  socks="$(printf '%s\n' "$made" | sed -n 's/^PB_SOCKS=//p' | tail -n 1)"
  [[ "$profile" =~ ^[0-9a-f-]{36}$ && "$socks" =~ ^[0-9.]+:[0-9]+$ ]] || fail "the server did not name the new profile"
  local cli=(sync browser-profile add --profile "$profile" --container "page-browser-${PAGE_NAME}" --socks "$socks")
  if [[ ${#from_draft[@]} -gt 0 ]]; then
    cli+=("${from_draft[@]}")
    [[ -z "$env_override" ]] || cli+=(--env "$env_override")
  else
    cli+=(--env "$ENV_JSON")
  fi
  cli+=(--secrets-stdin)
  [[ "$EXISTING_PAGE" == "1" ]] && cli+=(--page "$PAGE_NAME") || cli+=(--new-page "$PAGE_NAME")
  local secrets="${REMOTE_BASE}/pages/${PAGE_NAME}/secrets"
  local registered status=0 refused_re='"outcome": "refused"'
  registered="$(run_remote "set -euo pipefail; cd $(printf '%q' "$HUB_DIR"); cat $(printf '%q' "$secrets/rpc_token") $(printf '%q' "$secrets/api_token") $(printf '%q' "$secrets/vnc_password") | $(hub_cli_line "${cli[@]}")")" || status=$?
  [[ -z "$registered" ]] || printf '%s\n' "$registered"
  if (( status != 0 )); then
    if [[ "$registered" =~ $refused_re ]]; then
      # Hub's own refusal: nothing of the profile was written there.
      log "Hub refused profile ${profile} (nothing of it written there): its container and volumes go"
      page_remote remove-profile --page "$PAGE_NAME" --profile "$profile" || log "warning: page-browser-${PAGE_NAME} could not be removed: run remove-profile again"
      fail "add-profile failed; nothing of profile ${profile} is kept"
    fi
    # Anything else — the answer lost, a failure that is not Hub's word:
    # Hub may have registered it, or may still (with --existing: bound to
    # the page). Nothing is removed here (Astra's review of PR 16, round 2).
    left_behind "$profile"
    fail "add-profile: whether Hub registered profile ${profile} is not known — nothing was removed"
  fi
  log "profile ${profile} of ${PAGE_NAME}: container page-browser-${PAGE_NAME} up, registered in Hub$([[ "$EXISTING_PAGE" == "1" ]] && echo " and bound to ${PAGE_NAME}" || echo "; connect the page in the dashboard (Настройки → Страницы)")"
}

# A profile no page has, given up: Hub first (it refuses a bound one), then
# the server's container, files and volumes.
# After an add whose outcome is unknown: what the server keeps, and how the
# owner resolves it — Hub's word first, then remove-profile by the UUID
# (Hub forgets it for good: a registration still under way is refused).
left_behind() {
  local profile="$1" show bound
  show="'cd $(printf '%q' "$HUB_DIR") && $(hub_cli_line sync browser-profile show --profile "$profile")'"
  if [[ "$EXISTING_PAGE" == "1" ]]; then bound=" (its pageId: bound to ${PAGE_NAME}, which runs on its browser now)"; else bound="; connect the page in the dashboard"; fi
  cat >&2 <<EOF
deploy-page-browser: left on ${REMOTE}, untouched: the container page-browser-${PAGE_NAME}, the volumes pb-profile-${profile} and pb-buffer-${profile}, the files ${REMOTE_BASE}/pages/${PAGE_NAME}/
  1. Ask Hub what it holds of profile ${profile}:
       ssh ${REMOTE} ${show}
  2. "present": true — Hub registered it${bound}; keep everything.
     "present": false — remove what was made (Hub then never registers ${profile}):
       scripts/deploy-page-browser.sh remove-profile ${REMOTE} --page ${PAGE_NAME} --profile ${profile}
EOF
}

remove_profile() {
  [[ -n "$PAGE_NAME" ]] || fail "remove-profile needs --page <name>"
  [[ "$PAGE_NAME" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || fail "not a page name: $PAGE_NAME"
  local profile
  profile="$(run_remote "set -euo pipefail; sed -n 's/^PB_PROFILE_ID=//p' $(printf '%q' "${REMOTE_BASE}/pages/${PAGE_NAME}/page.env") | tail -n 1")" \
    || fail "no page ${PAGE_NAME} on the server"
  [[ "$profile" =~ ^[0-9a-f-]{36}$ ]] || fail "page ${PAGE_NAME} names no profile on the server"
  [[ -z "$PROFILE_ARG" || "$PROFILE_ARG" == "$profile" ]] || fail "page ${PAGE_NAME} names profile ${profile} on the server, not ${PROFILE_ARG}: nothing removed"
  # Hub forgets it (or never had it: a run again after Hub's answer was
  # lost); a profile bound to a page is refused.
  run_remote "set -euo pipefail; cd $(printf '%q' "$HUB_DIR"); $(hub_cli_line sync browser-profile remove --profile "$profile" --absent-ok)" \
    || fail "Hub did not forget profile ${profile} (bound to a page? see sync browser-profile list): nothing removed"
  # The server removes it only while the page's files still name it.
  page_remote remove-profile --page "$PAGE_NAME" --profile "$profile" \
    || fail "the server did not remove profile ${profile} of ${PAGE_NAME} (Hub forgot it already): see page.sh status"
  log "profile ${profile} of ${PAGE_NAME} removed: Hub, container, files, volumes"
}

case "$COMMAND" in
  host) host ;;
  add-profile) add_profile ;;
  remove-profile) remove_profile ;;
  build) build ;;
  to-node) to_node ;;
  chrome) chrome ;;
  up|rollback|down|status|log) page_remote "$COMMAND" "${PAGE_ARGS[@]}" ;;
  *) usage; exit 2 ;;
esac
