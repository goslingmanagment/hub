#!/usr/bin/env bash
# Self-hosted runners keep node_modules from one job to the next; everything
# else in the workspace is cleaned as actions/checkout's own clean would.
#
#   ci-node-modules.sh prepare
#       After actions/checkout with `clean: false` (which still force-checks
#       out every tracked file) and before `pnpm install --frozen-lockfile`:
#        - removes every untracked and ignored file except the node_modules
#          of workspace projects, including any node_modules elsewhere;
#        - keeps those only when the last install into them completed from
#          the same dependency inputs: every package.json, the lockfile,
#          pnpm-workspace.yaml, .npmrc and .pnpmfile.cjs, the pnpm and Node
#          versions and the platform. Otherwise it removes them all and the
#          install starts from nothing, as it did before. (pnpm converges a
#          kept node_modules onto a new lockfile, but not to what a fresh
#          install would build: switching back to an older lockfile left its
#          private hoisting different, and an interrupted install leaves
#          *_tmp_* directories behind.)
#        - drops the tool caches kept inside them (.cache, .vite, .vite-temp;
#          vitest's results cache there reorders files by the last run).
#   ci-node-modules.sh seal
#       After a successful install: record the inputs it installed from. An
#       install that never finished leaves no seal, and the next job starts
#       from nothing.
#
# The inputs of this job live in $RUNNER_TEMP/ci-node-modules/, which the
# runner empties between jobs; the seal lives in node_modules itself.
set -euo pipefail

usage() { echo "usage: ci-node-modules.sh prepare | seal" >&2; exit 2; }
[ "$#" -eq 1 ] || usage

seal=node_modules/.ci-dependency-inputs
inputs="${RUNNER_TEMP:?RUNNER_TEMP is not set}/ci-node-modules/inputs"

node_modules_dirs() { find . -path ./.git -prune -o -type d -name node_modules -prune -print; }

case "$1" in
  prepare)
    [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "::error::tracked files differ from the checkout"; exit 1; }
    mkdir -p "$(dirname "$inputs")"
    {
      echo "ci-node-modules 1"
      echo "node $(node --version)"
      echo "pnpm $(pnpm --version)"
      echo "platform $(uname -sm)"
      files="$(git ls-files -- pnpm-lock.yaml ':(glob)**/package.json' ':(glob)**/pnpm-workspace.yaml' ':(glob)**/.npmrc' ':(glob)**/.pnpmfile.cjs')"
      paste -d ' ' <(printf '%s\n' "$files" | git hash-object --stdin-paths) <(printf '%s\n' "$files")
    } > "$inputs"
    if [ ! -d node_modules ]; then reason="there is none"
    elif [ ! -f "$seal" ]; then reason="no install into it completed"
    elif ! cmp -s "$seal" "$inputs"; then reason="the dependency inputs changed"
    else reason=""
    fi
    if [ -n "$reason" ]; then
      echo "Installing into an empty node_modules: $reason."
      if [ -f "$seal" ]; then diff "$seal" "$inputs" || true; fi
    fi
    kept=0
    while IFS= read -r dir; do
      if [ -z "$reason" ] && git ls-files --error-unmatch -- "${dir%/node_modules}/package.json" >/dev/null 2>&1; then
        rm -rf "$dir/.cache" "$dir/.vite" "$dir/.vite-temp"
        kept=$((kept + 1))
      else
        rm -rf "$dir"
      fi
    done < <(node_modules_dirs)
    # A new install seals again; until it completes, nothing here is reusable.
    rm -f "$seal"
    git clean -ffdxq -e node_modules
    if [ "$kept" -gt 0 ]; then echo "Kept $kept node_modules installed from these inputs:"; else echo "Dependency inputs:"; fi
    head -n 4 "$inputs" | tail -n 3
    ;;

  seal)
    [ -f "$inputs" ] || { echo "::error::ci-node-modules.sh prepare did not run in this job"; exit 1; }
    [ -d node_modules ] || { echo "::error::there is no node_modules to seal"; exit 1; }
    cp "$inputs" "$seal"
    ;;

  *) usage ;;
esac
