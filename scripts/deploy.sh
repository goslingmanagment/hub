#!/usr/bin/env bash
# Deploy Hub to production in one command.
#
#   scripts/deploy.sh                    the tip of origin/main
#   scripts/deploy.sh <sha>              that commit (it must be on origin/main)
#   scripts/deploy.sh --dry-run [<sha>]  everything except the deploy itself:
#                                        CI gate, running revision, new migrations
#   scripts/deploy.sh [<sha>] -- <args>  extra scripts/deploy-production.sh
#                                        options, e.g. -- --mode full after a
#                                        package.json / lockfile change
#
# It fetches origin, checks the commit out in a throwaway worktree, requires
# main's green "Quality Gate" for it (scripts/main-ci-gate.sh), runs
# scripts/deploy-production.sh --mode dist-only from that worktree, writes the
# whole log to a file and prints a short summary. The worktree is removed at
# the end, whatever happened. Run it from any checkout of the repo.
#
# HUB_DEPLOY_HOST  production SSH target. Default: root@152.53.191.242 (agency-de)
# HUB_DEPLOY_LOGS  log directory. Default: ~/.local/state/hub-deploy
set -euo pipefail

HOST="${HUB_DEPLOY_HOST:-root@152.53.191.242}"
LOG_DIR="${HUB_DEPLOY_LOGS:-${XDG_STATE_HOME:-$HOME/.local/state}/hub-deploy}"
APP_DIR="/opt/agency-hub"

DRY_RUN=0
TARGET=""
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; EXTRA=("$@"); break ;;
    -*) echo "deploy: unknown option $1 (deploy-production.sh options go after --)" >&2; exit 2 ;;
    *) [[ -z "$TARGET" ]] || { echo "deploy: one commit at a time" >&2; exit 2; }; TARGET="$1"; shift ;;
  esac
done

case "$HOST" in
  *45.8.230.111*) echo "deploy: 45.8.230.111 is the retired server; Hub runs on agency-de" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

git -C "$REPO" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"
SHA="$(git -C "$REPO" rev-parse --verify "${TARGET:-origin/main}^{commit}")" \
  || { echo "deploy: unknown commit ${TARGET}" >&2; exit 2; }
git -C "$REPO" merge-base --is-ancestor "$SHA" refs/remotes/origin/main \
  || { echo "deploy: ${SHA:0:12} is not on origin/main" >&2; exit 2; }
SUBJECT="$(git -C "$REPO" log -1 --format=%s "$SHA")"

mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}.log"
: >"$LOG"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hub-deploy.XXXXXX")"
cleanup() {
  # Moved aside, the worktree is pruned at once and its files go in the
  # background: deleting them took seconds after the summary.
  if mv "$WORK" "${WORK}.done" 2>>"$LOG"; then
    git -C "$REPO" worktree prune >>"$LOG" 2>&1 || true
    (rm -rf "${WORK}.done" >/dev/null 2>&1 &)
    return 0
  fi
  git -C "$REPO" worktree remove --force "${WORK}/hub" >>"$LOG" 2>&1 || true
  rm -rf "$WORK"
  git -C "$REPO" worktree prune >>"$LOG" 2>&1 || true
}
trap cleanup EXIT
git -C "$REPO" worktree add --detach --quiet "${WORK}/hub" "$SHA" >>"$LOG" 2>&1
TREE="${WORK}/hub"

say "deploy: ${SHA:0:12} \"${SUBJECT}\" → ${HOST}"
say "log: ${LOG}"

gate_refused() {
  say "ci-gate: REFUSED — main's Quality Gate for ${SHA:0:12} is not green (still running, or red): $(grep '\[ci-gate\]' "$LOG" | tail -1)"
}

# A real deploy installs the dependencies meanwhile: they are local, and the
# deploy asks the CI gate itself before anything else (scripts/deploy-production.sh,
# preflight), so the gate is not asked twice.
INSTALL_PID=""
if [[ "$DRY_RUN" != "1" ]]; then
  (cd "$TREE" && pnpm install --frozen-lockfile --prefer-offline) >"${WORK}/install.log" 2>&1 </dev/null &
  INSTALL_PID=$!
else
  # The dry run's gate: a red or unfinished main stops here.
  if ! bash "${TREE}/scripts/main-ci-gate.sh" "$TREE" >>"$LOG" 2>&1; then
    gate_refused
    exit 1
  fi
  say "ci-gate: green"
fi

# What production runs now, read-only, and the migrations this deploy brings.
PREV="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  "id=\$(docker ps -q --filter label=com.docker.compose.project.working_dir=${APP_DIR} --filter label=com.docker.compose.service=api | head -1); [ -n \"\$id\" ] && docker image inspect -f '{{index .Config.Labels \"agency-hub.source-revision\"}}' \"\$(docker inspect -f '{{.Image}}' \"\$id\")\"" \
  2>>"$LOG" || true)"
PREV_COMMIT="${PREV%-dirty}"
MIGRATIONS="unknown (running revision '${PREV:-?}' not found locally)"
if [[ -n "$PREV_COMMIT" ]] && git -C "$REPO" cat-file -e "${PREV_COMMIT}^{commit}" 2>/dev/null; then
  list=()
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    name="${file##*/}"
    if grep -Eq '^-- agency-hub:rollback-compatible([^[:alnum:]_-]|$)' "${TREE}/${file}" \
      || grep -Fq "\"${name}\"" "${TREE}/scripts/deploy-production.sh"; then
      list+=("${name}")
    else
      list+=("${name} (no auto-rollback)")
    fi
  done < <(git -C "$REPO" diff --name-only --diff-filter=A "$PREV_COMMIT" "$SHA" -- packages/db/migrations/)
  if [[ ${#list[@]} -eq 0 ]]; then
    MIGRATIONS="none"
  else
    MIGRATIONS="$(IFS=,; printf '%s' "${list[*]}" | sed 's/,/, /g')"
  fi
fi
say "running now: ${PREV:-unknown}"
say "new migrations: ${MIGRATIONS}"

if [[ "$DRY_RUN" == "1" ]]; then
  say "dry run: nothing deployed"
  exit 0
fi

install_status=0
wait "$INSTALL_PID" || install_status=$?
cat "${WORK}/install.log" >>"$LOG"
if [[ "$install_status" != "0" ]]; then
  say "deploy: FAILED — pnpm install (see log)"
  exit 1
fi

# Seconds since the command started (bash counts SECONDS from the script's start).
PREP=$SECONDS
status=0
"${TREE}/scripts/deploy-production.sh" --mode dist-only ${EXTRA[@]+"${EXTRA[@]}"} "$HOST" >>"$LOG" 2>&1 || status=$?
elapsed=$SECONDS
duration="$((elapsed / 60))m$((elapsed % 60))s"
healthy="$(sed -n 's/.*Production verified; elapsed_seconds=\([0-9]*\)$/\1/p' "$LOG" | tail -1)"

if [[ "$status" == "0" ]]; then
  sync_status="$(sed -n 's/.*Sync health: .*(status \([^)]*\))$/\1/p' "$LOG" | tail -1)"
  say "deploy: OK — ${SHA:0:12} live (was ${PREV:-unknown}), ${duration}${healthy:+ (healthy after $((healthy + PREP))s)}"
  say "health: API 200, dashboard 200, sync ${sync_status:-not checked}"
  grep -q 'local hub CLI rebuild failed' "$LOG" && say "warning: the local hub CLI was not rebuilt (scripts/rebuild-hub-cli-prod.sh ${SHA:0:12})"
  exit 0
fi

if grep -q 'Deploy refused: this checkout is not a clean commit of main with a green Quality Gate' "$LOG"; then
  gate_refused
  exit "$status"
fi
say "deploy: FAILED (exit ${status}) after ${duration}"
say "error: $(grep '^\[deploy\] error:' "$LOG" | tail -1 | sed 's/^\[deploy\] error: //')"
if grep -q 'Rollback health check passed' "$LOG"; then
  say "rollback: production is back on ${PREV:-the previous image}"
elif grep -q 'Rollback skipped\|Rollback command failed\|Rollback health check did not reach 200' "$LOG"; then
  say "rollback: NOT done — $(grep -E 'Rollback skipped|Rollback command failed|Rollback health check did not' "$LOG" | tail -1 | sed 's/^\[deploy\] [^ ]* //')"
fi
grep -q 'dependency checksum changed' "$LOG" && say "hint: dependencies changed — run scripts/deploy.sh ${SHA:0:12} -- --mode full"
exit "$status"
