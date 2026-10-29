#!/usr/bin/env bash
set -euo pipefail

# Rebuild the production-pinned `hub` CLI from exactly one git revision.
#
# The `hub` CLI validates every response against the contract compiled into it,
# and the validation is strict on purpose: a server that serves a dataset the CLI
# never heard of is contract drift, and the CLI refuses to guess. That makes the
# installed CLI a function of the DEPLOYED revision, not of any checkout — a dev
# checkout is routinely ahead of or behind production and fails at
# `capabilities`. So the machine keeps a separate copy, a plain `git archive`
# (never a worktree: worktree cleanup has deleted it mid-audit) under
#   ~/.local/share/hub-agent-cli-prod-<rev12>/
# with `.source-revision` inside, switches ~/.local/share/hub-agent-cli-prod to
# it, and points ~/.local/bin/hub through that link.
#
# After the switch the old installs go: each is a full pnpm tree of ~40k files,
# one per deploy, and 109 had piled up by 2026-10-29. Kept are the new install,
# the one the link pointed at before (the rollback), the newest others up to
# HUB_CLI_PROD_KEEP installs in all, and anything touched in the last hour,
# which another run may still be building. A staging directory lives for the
# seconds of an extraction, so an older one was left by a run that died and
# goes too. Nothing but hub-agent-cli-prod-<rev12> and its .staging.<pid> is
# ever removed, and a symlink never is.
#
# scripts/deploy-production.sh runs this at the end of every verified deploy;
# run it by hand after any deploy that skipped it. The running revision is the
# `agency-hub.source-revision` label on the production image.
#
# The switch happens only after the freshly built CLI answers `capabilities`
# with the contract hash the requested revision compiles to. A hash mismatch
# means production runs something else than the revision you asked for, and the
# script stops before touching the links.

export COPYFILE_DISABLE=1

usage() {
  cat <<'USAGE'
Usage:
  scripts/rebuild-hub-cli-prod.sh <git-revision>

  <git-revision>  The deployed commit (sha, short sha, tag). Resolved in this
                  checkout, so fetch first if it was merged elsewhere.

Environment:
  HUB_CLI_PROD_SHARE  Parent of the pinned installs. Default: ~/.local/share
  HUB_CLI_BIN_LINK    The `hub` on PATH. Default: ~/.local/bin/hub
  HUB_CLI_PROD_KEEP   Installs kept after the switch, the new and the previous
                      one among them; at least 2. Default: 2
USAGE
}

log() {
  printf '[hub-cli] %s\n' "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ $# -eq 1 ]] || { usage >&2; exit 2; }
case "$1" in
  -h|--help) usage; exit 0 ;;
esac
REQUESTED="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SHARE_DIR="${HUB_CLI_PROD_SHARE:-${HOME}/.local/share}"
BIN_LINK="${HUB_CLI_BIN_LINK:-${HOME}/.local/bin/hub}"
KEEP="${HUB_CLI_PROD_KEEP:-2}"
INSTALL_NAME="hub-agent-cli-prod"
CURRENT_LINK="${SHARE_DIR}/${INSTALL_NAME}"

case "$REQUESTED" in
  unknown|*-dirty) fail "Refusing to pin '${REQUESTED}': not a clean commit" ;;
esac
[[ "$KEEP" =~ ^([2-9]|[1-9][0-9]+)$ ]] \
  || fail "HUB_CLI_PROD_KEEP='${KEEP}' is not a whole number of at least 2: the new and the previous install always stay"
command -v node >/dev/null || fail "node is not on PATH"
command -v pnpm >/dev/null || fail "pnpm is not on PATH"

FULL_SHA="$(git -C "$ROOT_DIR" rev-parse --verify --quiet "${REQUESTED}^{commit}")" \
  || fail "Cannot resolve '${REQUESTED}' in ${ROOT_DIR}; fetch first"
SHORT_SHA="${FULL_SHA:0:12}"
TARGET_DIR="${SHARE_DIR}/${INSTALL_NAME}-${SHORT_SHA}"

previous=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous="$(readlink "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
  fail "${CURRENT_LINK} exists and is not a symlink; move it aside first"
fi

if [[ -e "$TARGET_DIR" ]]; then
  existing="$(cat "${TARGET_DIR}/.source-revision" 2>/dev/null || true)"
  [[ "$existing" == "$FULL_SHA" ]] \
    || fail "${TARGET_DIR} exists but is not a clean install of ${FULL_SHA} (.source-revision='${existing}'); remove it by hand"
  log "Reusing existing archive of ${SHORT_SHA} at ${TARGET_DIR}"
else
  mkdir -p "$SHARE_DIR"
  STAGE_DIR="${TARGET_DIR}.staging.$$"
  trap 'rm -rf "$STAGE_DIR"' EXIT
  mkdir "$STAGE_DIR"
  log "Extracting ${FULL_SHA} into ${TARGET_DIR}"
  git -C "$ROOT_DIR" archive --format=tar "$FULL_SHA" | tar -x -C "$STAGE_DIR"
  printf '%s\n' "$FULL_SHA" > "${STAGE_DIR}/.source-revision"
  mv "$STAGE_DIR" "$TARGET_DIR"
  trap - EXIT
fi
# In use from now on: another run's prune leaves alone what was touched in the
# last hour.
touch "$TARGET_DIR"

log "Installing dependencies (frozen lockfile)"
(cd "$TARGET_DIR" && pnpm install --frozen-lockfile --force --reporter=silent) \
  || fail "pnpm install failed in ${TARGET_DIR}"

EXPECTED_HASH="$(sed -n 's/.*KERNEL_CONTRACT_HASH = "\([0-9a-f]*\)".*/\1/p' "${TARGET_DIR}/packages/contracts/src/contract-hash.ts")"
[[ -n "$EXPECTED_HASH" ]] || fail "No KERNEL_CONTRACT_HASH in ${TARGET_DIR}/packages/contracts/src/contract-hash.ts"

log "Verifying capabilities against production"
CAPABILITIES_JSON="$(node "${TARGET_DIR}/packages/hub-agent-cli/bin/hub.mjs" capabilities 2>/dev/null || true)"
SERVED_HASH="$(printf '%s' "$CAPABILITIES_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let doc;
    try { doc = JSON.parse(raw); } catch { process.stdout.write("parse_error"); return; }
    if (doc.ok !== true) {
      const error = doc.error ?? {};
      process.stdout.write(`error:${error.category ?? "?"}:${error.code ?? "?"}:${String(error.message ?? "").slice(0, 300)}`);
      return;
    }
    process.stdout.write(String(doc.data?.contract?.contractHash ?? "missing"));
  });
')"
case "$SERVED_HASH" in
  "$EXPECTED_HASH") ;;
  error:*|parse_error|missing)
    fail "capabilities did not succeed from ${TARGET_DIR}: ${SERVED_HASH}. Links untouched; the previous install still serves ${CURRENT_LINK}" ;;
  *)
    fail "Contract hash mismatch: ${SHORT_SHA} compiles to ${EXPECTED_HASH}, production serves ${SERVED_HASH}. Production runs a different revision; links untouched" ;;
esac

ln -sfn "$TARGET_DIR" "$CURRENT_LINK"
if [[ -e "$BIN_LINK" && ! -L "$BIN_LINK" ]]; then
  fail "${BIN_LINK} is a real file, not a symlink; ${CURRENT_LINK} now points at ${SHORT_SHA} but PATH still runs the old binary"
fi
mkdir -p "$(dirname "$BIN_LINK")"
ln -sfn "${CURRENT_LINK}/packages/hub-agent-cli/bin/hub.mjs" "$BIN_LINK"

log "hub now serves ${SHORT_SHA} (contract ${EXPECTED_HASH:0:12}…) via ${BIN_LINK}"
if [[ -n "$previous" && "$previous" != "$TARGET_DIR" ]]; then
  log "Previous install kept at ${previous}"
fi

# The directory a link value names, however the path was spelled.
install_name() {
  local path="$1"
  while [[ "$path" == */ ]]; do path="${path%/}"; done
  printf '%s' "${path##*/}"
}

remove_old() {
  if rm -rf -- "$1"; then
    log "Removed ${1##*/}"
  else
    log "WARNING: could not remove $1; the next run tries again"
  fi
}

# Runs only after a good switch and never fails the script: the new CLI
# already serves. The header says what stays.
prune_old_installs() {
  local install_re="^${INSTALL_NAME}-[0-9a-f]{12}\$"
  local staging_re="^${INSTALL_NAME}-[0-9a-f]{12}\\.staging\\.[0-9]+\$"
  local protected=" " kept=0 name path
  for name in "$(install_name "$TARGET_DIR")" "$(install_name "$previous")" \
    "$(install_name "$(readlink "$CURRENT_LINK" 2>/dev/null || true)")"; do
    [[ "$name" =~ $install_re && "$protected" != *" ${name} "* ]] || continue
    protected+="${name} "
    if [[ -d "${SHARE_DIR}/${name}" ]]; then kept=$((kept + 1)); fi
  done
  # Newest first, so HUB_CLI_PROD_KEEP keeps the latest of the others.
  while IFS= read -r path; do
    name="${path##*/}"
    [[ -d "$path" && ! -L "$path" ]] || continue
    if [[ "$name" =~ $install_re ]]; then
      [[ "$protected" != *" ${name} "* ]] || continue
      if (( kept < KEEP )); then
        kept=$((kept + 1))
        continue
      fi
    elif ! [[ "$name" =~ $staging_re ]]; then
      continue
    fi
    # Touched in the last hour: another run may still be building it.
    if [[ -z "$(find "$path" -maxdepth 0 -mmin -60 2>/dev/null)" ]]; then
      remove_old "$path"
    fi
  done < <(ls -1td -- "${SHARE_DIR}/${INSTALL_NAME}-"* 2>/dev/null)
  return 0
}

prune_old_installs
