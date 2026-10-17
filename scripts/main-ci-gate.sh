#!/usr/bin/env bash
# The deploy gate: production takes only a commit of main whose CI passed.
#
# PR CI runs the integration shards only for DB/sync/network changes
# (scripts/ci-integration-scope.mjs); every push to main runs the whole suite,
# so main's "Quality Gate" for the commit is the evidence a deploy needs. A
# red or unfinished main blocks every deploy, and whoever deploys fixes main
# (or waits for its run) first.
#
#   scripts/main-ci-gate.sh [repo-dir]       check HEAD of repo-dir
#   source scripts/main-ci-gate.sh; require_green_main_ci [repo-dir]
#
# DEPLOY_SKIP_CI_GATE=1 skips the check for one run: an owner-approved
# emergency only (GitHub is down, or a hotfix must go out while main is red).
# Needs git, node and an authenticated GitHub CLI (`gh`).

MAIN_CI_GATE_CHECK_NAME="Quality Gate"

require_green_main_ci() (
  set -euo pipefail
  root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  say() { printf '[ci-gate] %s\n' "$*" >&2; }

  case "${DEPLOY_SKIP_CI_GATE:-0}" in
    0|false|no|"") ;;
    1|true|yes)
      say "WARNING: DEPLOY_SKIP_CI_GATE is set: deploying without main's CI evidence (owner-approved emergencies only)"
      exit 0
      ;;
    *) say "Invalid DEPLOY_SKIP_CI_GATE value: ${DEPLOY_SKIP_CI_GATE}"; exit 1 ;;
  esac

  sha="$(git -C "$root" rev-parse --verify HEAD)" || { say "Cannot read the checkout's commit"; exit 1; }
  short="${sha:0:12}"
  # What CI tested is the commit; tracked changes on top of it are not.
  [[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ]] \
    || { say "The checkout has uncommitted changes on ${short}: deploy a clean checkout of a main commit"; exit 1; }
  git -C "$root" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" \
    || { say "Cannot fetch origin/main to check that ${short} is on it"; exit 1; }
  git -C "$root" merge-base --is-ancestor "$sha" refs/remotes/origin/main \
    || { say "${short} is not on origin/main: only a merged commit of main is deployed"; exit 1; }

  # The newest "Quality Gate" check run GitHub Actions reported for this exact
  # commit decides, as for a required check: on main, the push run's (or a
  # later re-run's).
  checks="$(cd "$root" && gh api "repos/{owner}/{repo}/commits/${sha}/check-runs?check_name=Quality%20Gate&filter=all&per_page=100")" \
    || { say "Cannot read main's CI for ${short} from GitHub"; exit 1; }
  # shellcheck disable=SC2016 # JavaScript, not shell, in single quotes.
  verdict="$(printf '%s' "$checks" | MAIN_CI_GATE_CHECK_NAME="$MAIN_CI_GATE_CHECK_NAME" node -e '
    let input = "";
    process.stdin.on("data", chunk => { input += chunk; }).on("end", () => {
      const runs = (JSON.parse(input).check_runs ?? []).filter(run => run.name === process.env.MAIN_CI_GATE_CHECK_NAME
        && run.app?.slug === "github-actions" && Number.isSafeInteger(run.id));
      if (runs.length === 0) { console.log("missing"); return; }
      const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
      console.log(`${newest.status} ${newest.conclusion ?? "none"} ${newest.html_url ?? ""}`);
    });
  ')" || { say "Cannot read main's CI for ${short}: unexpected answer from GitHub"; exit 1; }

  read -r status conclusion url <<<"$verdict"
  case "${status}:${conclusion:-}" in
    completed:success)
      say "Main CI passed for ${short}: ${url:-}"
      ;;
    missing:*)
      say "No Quality Gate on GitHub for ${short} yet: wait for main's CI run for this commit"
      exit 1
      ;;
    completed:*)
      say "Main CI for ${short} concluded ${conclusion}: ${url:-}. A red main blocks the deploy; fix main first"
      exit 1
      ;;
    *)
      say "Main CI for ${short} is still ${status}: ${url:-}. Wait for it to pass"
      exit 1
      ;;
  esac
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_green_main_ci "${1:-}"
fi
