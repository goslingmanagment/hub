#!/usr/bin/env bash
# Rebase the current branch on origin/main; the generated contract files are
# regenerated, never merged.
#
#   scripts/rebase-main.sh
#
# The generated set (`merge=hub-generated` in .gitattributes: the OpenAPI
# document, the contract hash, packages/sdk, the authorization policy table)
# conflicts on almost every pair of contract PRs, and the answer is always
# "regenerate". So this rebase runs with that merge driver set to `true` for
# this one command (`git -c`, never written to the repo config, which every
# worktree shares): a generated file keeps main's side, and the rebase stops
# only on a real source conflict. Then `pnpm contracts:generate` rewrites the
# set from the rebased sources and commits it when it changed. CI's
# "Contracts are regenerated" stays the gate.
set -euo pipefail

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "rebase-main: no arguments (see --help)" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"
GENERATED=(reference/agency-hub.openapi.json packages/contracts/src/contract-hash.ts packages/sdk docs/generated/authorization-policy.md)
DRIVER=(-c merge.hub-generated.driver=true)

rebase_in_progress() {
  [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]
}

if rebase_in_progress; then
  echo "rebase-main: a rebase is in progress; finish it (git ${DRIVER[*]} rebase --continue) or abort it, then run this again" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  echo "rebase-main: the worktree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

git fetch --quiet origin main
if ! git "${DRIVER[@]}" rebase origin/main; then
  if rebase_in_progress; then
    echo "rebase-main: the rebase stopped on a source conflict. Resolve it, git add the files, then" >&2
    echo "  git ${DRIVER[*]} rebase --continue" >&2
    echo "and run scripts/rebase-main.sh again when the rebase is done: it regenerates the contracts." >&2
  fi
  exit 1
fi

if ! pnpm --silent contracts:generate; then
  echo "rebase-main: rebased, but pnpm contracts:generate failed (dependencies changed on main? pnpm install, then run this again)" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all -- "${GENERATED[@]}")" ]]; then
  # `add -u` and the untracked list, not `add -A`: docs/ is gitignored, and
  # naming the tracked policy table to `add -A` fails on that.
  git add -u -- "${GENERATED[@]}"
  while IFS= read -r -d '' file; do git add -- "$file"; done < <(git ls-files -z --others --exclude-standard -- "${GENERATED[@]}")
  git commit --quiet -m "Regenerate contracts after rebase"
  echo "rebase-main: rebased on origin/main; regenerated contracts committed ($(git rev-parse --short HEAD))"
else
  echo "rebase-main: rebased on origin/main; the generated contracts are current"
fi
