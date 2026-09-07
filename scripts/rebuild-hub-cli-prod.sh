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
# it, and points ~/.local/bin/hub through that link. The previous install is
# kept, never deleted.
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
INSTALL_NAME="hub-agent-cli-prod"
CURRENT_LINK="${SHARE_DIR}/${INSTALL_NAME}"

case "$REQUESTED" in
  unknown|*-dirty) fail "Refusing to pin '${REQUESTED}': not a clean commit" ;;
esac
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
